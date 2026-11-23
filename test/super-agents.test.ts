/**
 * Super-subagents: pi-bridge's `super_agents` tool and option, the bridge
 * server's per-client tools and hang-ups, and the runs of both providers.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const work = realpathSync(mkdtempSync(join(tmpdir(), "super-agents-test-")));
process.env.PI_CODING_AGENT_DIR = join(work, "agent");
process.env.PI_CLAUDE_SCRATCH_DIR = join(work, "scratch");
process.env.PI_AGY_SCRATCH_DIR = join(work, "scratch-agy");
process.env.PI_MCP_DIR = join(work, "mcp");

const { BridgeServer } = await import("../extensions/pi-bridge/server.ts");
const { SUPER_AGENT_CHANNEL } = await import("../extensions/shared/agent-bus.ts");
const superMod = await import("../extensions/pi-bridge/super-agents.ts");
const { SuperAgentList } = await import("../extensions/shared/super-agents.ts");

const until = async (check: () => boolean, ms = 3000) => {
	for (let waited = 0; !check() && waited < ms; waited += 20) await new Promise((r) => setTimeout(r, 20));
	assert.ok(check(), "timed out");
};

async function rpc(url: string, token: string, body: unknown) {
	const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
	return res.json();
}

// =============================================================================
// pi-bridge
// =============================================================================

test("the option is off by default, switched and kept in pi-bridge.json", () => {
	assert.equal(superMod.superAgentsOn(), false);
	superMod.setSuperAgents(true);
	assert.equal(superMod.superAgentsOn(), true);
	assert.equal(JSON.parse(readFileSync(join(work, "agent", "pi-bridge.json"), "utf8")).superSubagents, true);
	superMod.setSuperAgents(false);
	assert.equal(superMod.superAgentsOn(), false);
});

test("tasks are checked and the report has each one's full answer", () => {
	assert.throws(() => superMod.superTasks({}), /empty/);
	assert.throws(() => superMod.superTasks({ tasks: [{ description: "x" }] }), /no prompt/);
	assert.throws(() => superMod.superTasks({ tasks: Array.from({ length: 9 }, () => ({ prompt: "p" })) }), /At most 8/);
	const tasks = superMod.superTasks({ tasks: [{ description: " Find callers ", prompt: "Find them", model: "haiku" }, { prompt: "Second line\nmore" }] });
	assert.deepEqual(tasks, [
		{ description: "Find callers", prompt: "Find them", model: "haiku" },
		{ description: "Second line", prompt: "Second line\nmore", model: undefined },
	]);
	const report = superMod.superReport(tasks, [
		{ text: "Found 3.", isError: false, model: "haiku", tokens: 1234, session: "s1" },
		{ text: "Broke.", isError: true },
	]);
	assert.match(report, /^2 super-subagents finished: 1 done, 1 failed\./);
	assert.match(report, /## 1\. Find callers \(done · haiku · 1,234 tokens · session s1\)\n\nFound 3\./);
	assert.match(report, /## 2\. Second line \(failed\)\n\nBroke\./);
});

test("the tool is offered only while the option is on, not to pi's models nor to super-subagents, and runs the tasks in parallel", async () => {
	const requests: any[] = [];
	const emit = (channel: string, data: any) => {
		assert.equal(channel, SUPER_AGENT_CHANNEL);
		requests.push(data);
		if (data.provider === "nobody") return;
		data.claim();
		setTimeout(() => data.reply({ text: `did ${data.prompt}`, isError: false }), 10);
	};
	const tool = superMod.superAgentsTool(emit, () => work);
	const server = new BridgeServer(() => [tool]);
	const url = await server.start();
	try {
		const main = server.token({ provider: "claude-x", kind: "claude", data: { cwd: work } });
		const child = server.token({ provider: "claude-x", kind: "claude", tag: superMod.SUPER_TAG, data: { cwd: work } });
		assert.notEqual(main, child, "a super-subagent's client is one of its own");
		const names = async (token: string) => (await rpc(url, token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools.map((t: any) => t.name);
		assert.deepEqual(await names(main), []);
		superMod.setSuperAgents(true);
		assert.deepEqual(await names(main), ["super_agents"]);
		assert.deepEqual(await names(child), []);

		const call = await rpc(url, main, {
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: "super_agents", arguments: { tasks: [{ description: "A", prompt: "a" }, { description: "B", prompt: "b", model: "haiku" }] } },
		});
		assert.equal(call.result.isError, false);
		assert.match(call.result.content[0].text, /## 1\. A \(done\)\n\ndid a/);
		assert.match(call.result.content[0].text, /## 2\. B \(done\)\n\ndid b/);
		assert.deepEqual(
			requests.map((r) => [r.provider, r.description, r.model, r.cwd]),
			[
				["claude-x", "A", undefined, work],
				["claude-x", "B", "haiku", work],
			],
		);
		assert.ok(requests[0].signal instanceof AbortSignal);

		const nobody = await superMod.runSuperTask(emit, "nobody", work, { description: "x", prompt: "y" });
		assert.equal(nobody.isError, true);
		assert.match(nobody.text, /No extension runs super-subagents/);
	} finally {
		superMod.setSuperAgents(false);
		await server.stop();
	}
});

test("a tool call learns when the caller hangs up", async () => {
	let aborted = false;
	const slow = {
		name: "slow",
		description: "waits",
		inputSchema: { type: "object" },
		call: (_args: any, _client: any, signal?: AbortSignal) =>
			new Promise<any>((resolve) => {
				signal?.addEventListener("abort", () => {
					aborted = true;
					resolve({ text: "stopped" });
				});
			}),
	};
	const server = new BridgeServer(() => [slow]);
	const url = await server.start();
	try {
		const token = server.token({ provider: "p", kind: "claude" });
		const controller = new AbortController();
		const pending = fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow", arguments: {} } }),
			signal: controller.signal,
		}).catch(() => undefined);
		await new Promise((r) => setTimeout(r, 100));
		controller.abort();
		await pending;
		await until(() => aborted);
	} finally {
		await server.stop();
	}
});

test("the extension: /super-subagents switches it, Claude's own subagents go off and agy's are denied", async () => {
	const { default: bridge } = await import("../extensions/pi-bridge/index.ts");
	const { BRIDGE_CHANNEL } = await import("../extensions/shared/agent-bus.ts");
	const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void>>();
	const listeners = new Map<string, (data: unknown) => void>();
	const commands = new Map<string, any>();
	const pi: any = {
		events: { on: (channel: string, fn: any) => listeners.set(channel, fn), emit: (channel: string, data: unknown) => listeners.get(channel)?.(data) },
		on: (event: string, fn: any) => handlers.set(event, fn),
		registerTool() {},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerMessageRenderer() {},
		sendMessage() {},
		getAllTools: () => [],
		getCommands: () => [],
	};
	bridge(pi);
	const notes: string[] = [];
	const ctx = { hasUI: true, cwd: work, ui: { notify: (text: string) => notes.push(text), setWidget() {} }, sessionManager: { getBranch: () => [] } };
	await handlers.get("session_start")!({}, ctx);
	const request = (kind: "claude" | "agy", superAgent?: boolean) => {
		let info: any;
		pi.events.emit(BRIDGE_CHANNEL, { provider: `${kind}-1`, kind, cwd: work, mode: "auto", superAgent, reply: (i: any) => (info = i) });
		return info;
	};
	try {
		assert.equal(request("claude").disallowedTools, undefined);
		await commands.get("super-subagents").handler("", ctx);
		assert.equal(superMod.superAgentsOn(), true);
		assert.match(notes.at(-1)!, /^Super-subagents on/);
		assert.deepEqual(request("claude").disallowedTools, ["Agent", "Task"]);
		assert.equal(request("claude", true).disallowedTools, undefined, "a super-subagent keeps its own subagents");

		// agy's hook denies its own subagents, in every mode, but not to a super-subagent.
		const hook = async (info: any) => {
			const res = await fetch(info.gate.url, {
				method: "POST",
				headers: { ...info.gate.headers, "Content-Type": "application/json" },
				body: JSON.stringify({ toolCall: { name: "invoke_subagent", args: {} }, workspacePaths: [work] }),
			});
			return res.json();
		};
		const denied = await hook(request("agy"));
		assert.equal(denied.decision, "deny");
		assert.match(denied.reason, /super_agents/);
		assert.deepEqual(await hook(request("agy", true)), {});

		await commands.get("super-subagents").handler("off", ctx);
		assert.equal(superMod.superAgentsOn(), false);
		assert.equal(request("claude").disallowedTools, undefined);
		await commands.get("super-subagents").handler("maybe", ctx);
		assert.match(notes.at(-1)!, /Usage/);
	} finally {
		superMod.setSuperAgents(false);
		await handlers.get("session_shutdown")?.({}, ctx);
	}
});

// =============================================================================
// Claude
// =============================================================================

const event = (e: unknown) => ({ type: "stream_event", event: e, session_id: "super-session" });

test("Claude: a run of its own, streamed live into the subagent, its final answer replied whole", async () => {
	const { runtime } = await import("../extensions/claude-code/state.ts");
	const { runClaudeSuperAgent } = await import("../extensions/claude-code/super-agents.ts");
	const fixture = join(work, "claude.jsonl");
	const record = join(work, "claude-record.json");
	const lines = [
		{ type: "system", subtype: "init", session_id: "super-session", model: "claude-sonnet" },
		event({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
		event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Look " } }),
		event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "around." } }),
		event({ type: "content_block_stop", index: 0 }),
		{ type: "assistant", message: { content: [{ type: "thinking", thinking: "Look around." }] } },
		event({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "Bash", input: {} } }),
		event({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":' } }),
		event({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"ls"}' } }),
		event({ type: "content_block_stop", index: 1 }),
		{ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } },
		{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt\nb.txt" }] } },
		// Its own subagent's traffic stays inside that subagent.
		{ type: "assistant", parent_tool_use_id: "t2", message: { content: [{ type: "text", text: "nested" }] } },
		event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Two files: " } }),
		event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a and b." } }),
		event({ type: "content_block_stop", index: 0 }),
		{ type: "assistant", message: { content: [{ type: "text", text: "Two files: a and b." }] } },
		{
			type: "result",
			subtype: "success",
			is_error: false,
			result: "Two files: a and b.",
			session_id: "super-session",
			usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
		},
	];
	writeFileSync(fixture, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	process.env.FAKE_CLAUDE_FIXTURE = fixture;
	process.env.FAKE_CLAUDE_RECORD = record;
	runtime.cwd = work;
	runtime.permissionMode = "acceptEdits";
	const published: any[][] = [];
	const list = new SuperAgentList((agents) => published.push(agents.map((a) => structuredClone(a))));
	const state: any = { instance: { id: "claude-t", name: "T", command: `"${process.execPath}" "${join(here, "fake-claude.mjs")}"` }, models: [] };
	const result = await new Promise<any>((resolve) =>
		runClaudeSuperAgent(list, state, { provider: "claude-t", description: "List files", prompt: "List the files", cwd: work, claim() {}, reply: resolve }, { model: "sonnet", effort: "high" }),
	);
	assert.deepEqual(result, { text: "Two files: a and b.", isError: false, session: "super-session", model: "claude-sonnet", tokens: 115 });
	const agent = list.agents[0];
	assert.equal(agent.status, "done");
	assert.equal(agent.description, "List files");
	assert.equal(agent.type, "super · sonnet");
	assert.deepEqual(agent.lastTool, { name: "Bash", detail: "ls" });
	assert.deepEqual(agent.steps, [
		{ kind: "prompt", text: "List the files" },
		{ kind: "thinking", text: "Look around." },
		{ kind: "tool", name: "Bash", detail: "ls" },
		{ kind: "result", text: "a.txt\nb.txt", isError: false },
		{ kind: "text", text: "Two files: a and b." },
	]);
	assert.equal(published.at(-1)![0].status, "done");
	assert.equal(published[0][0].status, "running");

	await until(() => existsSync(record));
	const recorded = JSON.parse(readFileSync(record, "utf8"));
	const args: string[] = recorded.args;
	assert.ok(args.includes("--include-partial-messages"));
	assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "sonnet"]);
	assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), ["--effort", "high"]);
	assert.deepEqual(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2), ["--permission-mode", "acceptEdits"]);
	assert.match(args[args.indexOf("--append-system-prompt") + 1], /You are a super-subagent/);
	assert.ok(!args.includes("--no-session-persistence"), "it keeps a session of its own");
	assert.equal(JSON.parse(recorded.stdin.trim()).message.content[0].text, "List the files");
	rmSync(record);
});

test("Claude: a run that is stopped or fails replies with an error", async () => {
	const { runClaudeSuperAgent } = await import("../extensions/claude-code/super-agents.ts");
	const fixture = join(work, "claude-slow.jsonl");
	writeFileSync(fixture, `${JSON.stringify({ fake: "sleep", ms: 5000 })}\n${JSON.stringify({ type: "result", subtype: "success", result: "late" })}\n`);
	process.env.FAKE_CLAUDE_FIXTURE = fixture;
	delete process.env.FAKE_CLAUDE_RECORD;
	const list = new SuperAgentList(() => {});
	const state: any = { instance: { id: "claude-t", name: "T", command: `"${process.execPath}" "${join(here, "fake-claude.mjs")}"` }, models: [] };
	const controller = new AbortController();
	const pending = new Promise<any>((resolve) =>
		runClaudeSuperAgent(list, state, { provider: "claude-t", description: "Slow", prompt: "wait", cwd: work, signal: controller.signal, claim() {}, reply: resolve }, {}),
	);
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(list.running, 1);
	controller.abort();
	const result = await pending;
	assert.equal(result.isError, true);
	assert.match(result.text, /stopped/);
	assert.equal(list.agents[0].status, "stopped");
	assert.equal(list.running, 0);
});

// =============================================================================
// agy
// =============================================================================

test("agy: thinking, text and tools of its stream become steps; the response is the result", async () => {
	const { AgySuperFeed, superModel } = await import("../extensions/antigravity/super-agents.ts");
	const agent: any = { id: "super-1", description: "d", status: "running", steps: [{ kind: "prompt", text: "p" }] };
	const feed = new AgySuperFeed(agent, "gemini-x-high");
	const step = (s: any) => ({ event: "step_update", conversation_id: "conv-1", step_update: s });
	const msgs = [
		step({ step_index: 1, step_type: "agent_response", state: "ACTIVE", thinking_delta: "Hmm, " }),
		step({ step_index: 1, step_type: "agent_response", state: "ACTIVE", thinking_delta: "files." }),
		step({ step_index: 1, step_type: "agent_response", state: "DONE" }),
		step({ step_index: 2, step_type: "tool", tool_name: "run_command", state: "ACTIVE", tool_info: { parameters: { CommandLine: "ls" } } }),
		step({ step_index: 2, step_type: "tool", tool_name: "run_command", state: "DONE", tool_info: { parameters: { CommandLine: "ls" }, output: "a\nb" } }),
		step({ step_index: 3, step_type: "tool", tool_name: "finish", state: "DONE", tool_info: {} }),
		step({ step_index: 4, step_type: "agent_response", state: "ACTIVE", text_delta: "Found " }),
		step({ step_index: 4, step_type: "agent_response", state: "ACTIVE", text_delta: "a, b." }),
		{ event: "result", result: { status: "SUCCESS", conversation_id: "conv-1", usage: { input_tokens: 7, output_tokens: 3 } } },
	];
	for (const m of msgs) feed.feed(m);
	assert.deepEqual(agent.steps, [
		{ kind: "prompt", text: "p" },
		{ kind: "thinking", text: "Hmm, files." },
		{ kind: "tool", name: "Bash", detail: "ls" },
		{ kind: "result", text: "a\nb", isError: false },
		{ kind: "text", text: "Found a, b." },
	]);
	assert.deepEqual(feed.result, { text: "Found a, b.", isError: false, session: "conv-1", model: "gemini-x-high", tokens: 10 });

	const failing = new AgySuperFeed({ id: "s", description: "d", status: "running", steps: [] } as any);
	failing.feed({ event: "result", result: { status: "ERROR", response: "quota" } });
	assert.deepEqual(failing.result, { text: "quota", isError: true, session: undefined, model: undefined, tokens: undefined });

	const models = [{ id: "gemini-x", name: "Gemini X", efforts: ["low", "high"] }];
	assert.equal(superModel(models, "gemini-x", "high"), "gemini-x-high");
	assert.equal(superModel(models, "claude-opus", "high"), "claude-opus");
	assert.equal(superModel(models, undefined, "high"), undefined);
});
