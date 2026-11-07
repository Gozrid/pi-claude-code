/**
 * The Antigravity provider: model list, permission rules and the stream end to
 * end, against a fake `agy` that plays back the JSON lines a real run prints
 * (shapes taken from agy 1.4.8).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const work = realpathSync(mkdtempSync(join(tmpdir(), "pi-antigravity-test-")));
// Keep the sessions file and scratch dirs away from the real ~/.pi/agent.
process.env.PI_CODING_AGENT_DIR = join(work, "agent");
process.env.PI_AGY_SCRATCH_DIR = join(work, "scratch");
process.env.PI_AGY_BRAIN_DIR = join(work, "brain");
process.env.PI_AGY_MODE = "accept-edits";
process.env.PI_MCP_DIR = join(work, "mcp");
process.env.PI_AGY_GEMINI_DIR = join(work, "gemini");

const { loadCachedModels, parseModels, saveCachedModels, smallestVariant, toProviderModel, variantId } = await import(
	"../extensions/antigravity/cli.ts"
);
const { CONFIG_FILE, MODELS_FILE, loadInstances, providerIdFor, saveInstances } = await import("../extensions/antigravity/config.ts");
const { allowRules, ruleFromError } = await import("../extensions/antigravity/permissions.ts");
const { runtime } = await import("../extensions/antigravity/state.ts");
const { errorText, loadSessions, sessionKey, streamAntigravity, toolDetail } = await import(
	"../extensions/antigravity/stream.ts"
);
const { parseUsage, usageForModel } = await import("../extensions/antigravity/usage.ts");
const { groupMessage } = await import("../extensions/chat-view/grouping.ts");

const MODELS = `gemini-4-argon-medium\tGemini 4 Argon (Medium)
gemini-4-argon-high\tGemini 4 Argon (High)
gemini-4-argon-low\tGemini 4 Argon (Low)
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.8-flash-low\tGemini 3.8 Flash (Low)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)
`;

test("agy's effort variants become one model per family", () => {
	assert.deepEqual(parseModels(`Fetching available models...\n${MODELS}`), [
		{ id: "gemini-4-argon", name: "Gemini 4 Argon", efforts: ["low", "medium", "high"] },
		{ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", efforts: ["low", "high"] },
		{ id: "gpt-oss-120b", name: "GPT-OSS 120B", efforts: ["medium"] },
	]);
});

test("the thinking level picks the variant, else a middle one", () => {
	const [argon, flash, gpt] = parseModels(MODELS);
	assert.equal(variantId(argon, argon.id, "high"), "gemini-4-argon-high");
	assert.equal(variantId(argon, argon.id, "minimal"), "gemini-4-argon-low");
	assert.equal(variantId(argon, argon.id, "max"), "gemini-4-argon-medium");
	assert.equal(variantId(flash, flash.id, undefined), "gemini-3.8-flash-low");
	assert.equal(variantId(gpt, gpt.id, "high"), "gpt-oss-120b-medium");
	assert.equal(variantId(undefined, "other", "high"), "other");
	assert.equal(smallestVariant(parseModels(MODELS)), "gemini-3.8-flash-low");
});

test("the allow rule comes from agy's denial message", () => {
	assert.equal(
		ruleFromError('permission check failed for unsandboxed "ls -la": user denied permission to run command:\nls -la\nDo not attempt …'),
		"command(ls -la)",
	);
	assert.equal(
		ruleFromError('permission check failed: user denied permission to run command:\npython3 -c "\nprint(1)\n"\nDo not attempt to circumvent…'),
		'command(python3 -c "\nprint(1)\n")',
	);
	assert.equal(
		ruleFromError('permission check failed for write_file "/p/a.txt": user denied permission for write_file(/p/a.txt)\nDo not …'),
		"write_file(/p/a.txt)",
	);
	assert.equal(ruleFromError("file not found"), undefined);
});

test("agy's /usage buckets map to 5-hour session and weekly limits per model family", () => {
	const parsed = parseUsage(
		JSON.stringify({
			status: "SUCCESS",
			command: {
				name: "usage",
				data: {
					groups: [
						{
							name: "Gemini Models",
							buckets: [
								{ id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.8, reset_time: "2026-11-06T12:00:00Z" },
								{ id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 0.75, reset_time: "2026-10-30T17:00:00Z" },
							],
						},
						{
							name: "Claude and GPT models",
							buckets: [
								{ id: "3p-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.6, reset_time: "2026-11-06T13:00:00Z" },
								{ id: "3p-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 0.9, reset_time: "2026-10-30T18:00:00Z" },
							],
						},
						{
							name: "Gemini 4 Argon",
							buckets: [
								{ id: "gemini-argon-wtu-weekly", name: "Gemini 4 Argon Weekly Limit", window: "weekly", remaining_fraction: 0.5, reset_time: "2026-11-06T14:00:00Z" },
							],
						},
					],
				},
			},
		}),
	);
	assert.equal(parsed?.groups.length, 3);
	const flash = usageForModel(parsed, "gemini-3.8-flash");
	assert.equal(Math.round(flash.session!.percent), 25);
	assert.equal(Math.round(flash.weekly!.percent), 20);
	const argon = usageForModel(parsed, "gemini-4-argon");
	assert.equal(Math.round(argon.session!.percent), 25);
	assert.equal(Math.round(argon.weekly!.percent), 50);
	const gpt = usageForModel(parsed, "gpt-oss-120b");
	assert.equal(Math.round(gpt.session!.percent), 10);
	assert.equal(Math.round(gpt.weekly!.percent), 40);
});

test("allowing rules keeps the other settings and adds each rule once", () => {
	const file = join(work, "agy-settings.json");
	writeFileSync(file, JSON.stringify({ trustedWorkspaces: ["/x"], permissions: { allow: ["command(ls)"], deny: ["mcp(*)"] } }));
	assert.ok(allowRules(["command(ls)", "command(npm test)"], file));
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
		trustedWorkspaces: ["/x"],
		permissions: { allow: ["command(ls)", "command(npm test)"], deny: ["mcp(*)"] },
	});
});

test("a tool's detail is its command, path or query", () => {
	assert.equal(toolDetail({ CommandLine: "npm test", Cwd: "/p" }), "npm test");
	assert.equal(toolDetail({ Path: "/p/a.txt" }), "/p/a.txt");
	assert.equal(toolDetail({ Other: "x" }), "x");
	assert.equal(toolDetail(undefined), "");
});

// =============================================================================
// Stream
// =============================================================================

const SESSION = "pi-session-1";
const CONVERSATION = "conv-1";
const record = join(work, "record.json");
const step = (step_index: number, state: string, step_type: string, extra: Record<string, unknown> = {}) => ({
	event: "step_update",
	step_update: { conversation_id: CONVERSATION, step_index, state, step_type, ...extra },
});
const usage = (input: number, output: number) => ({
	input_tokens: input,
	output_tokens: output,
	thinking_tokens: 5,
	cache_read_tokens: 0,
	total_tokens: input + output,
});
const result = (extra: Record<string, unknown> = {}) => ({
	event: "result",
	result: { conversation_id: CONVERSATION, status: "SUCCESS", response: "Done.", usage: usage(300, 40), ...extra },
});

const demo = join(work, "demo.txt");

function toolRun() {
	const command = { name: "run_command", parameters: { CommandLine: "npm test" } };
	const write = { name: "write_file", parameters: { Path: demo } };
	return [
		{ event: "init", conversation_id: CONVERSATION, init: { model: "gemini-4-argon-high", permission_mode: "accept-edits" } },
		step(0, "DONE", "user_input"),
		step(1, "DONE", "agent_response", { usage: usage(100, 10) }),
		step(2, "ACTIVE", "tool", { tool_name: "run_command", tool_info: command }),
		step(2, "DONE", "tool", { tool_name: "run_command", tool_info: { ...command, output: "12 passing\nall good" } }),
		step(3, "ACTIVE", "tool", { tool_name: "write_file", tool_info: write }),
		{ write: demo, content: "one\n2\nthree\n" },
		step(3, "DONE", "tool", { tool_name: "write_file", tool_info: write }),
		step(4, "ACTIVE", "agent_response", { text_delta: "Do" }),
		step(4, "DONE", "agent_response", { text_delta: "ne.", usage: usage(200, 20) }),
		result(),
	];
}

const prompt = { role: "user", content: "Change demo.txt", timestamp: 0 };

async function run(lines: unknown[], messages: unknown[] = [prompt], reasoning = "high", provider = "antigravity") {
	const fixture = join(work, "fixture.jsonl");
	writeFileSync(fixture, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	process.env.FAKE_AGY_FIXTURE = fixture;
	process.env.FAKE_AGY_RECORD = record;
	const model = { id: "gemini-4-argon", provider, api: `antigravity-cli:${provider}`, reasoning: true } as any;
	const stream = streamAntigravity(model, { messages } as any, { sessionId: SESSION, reasoning } as any);
	const events: any[] = [];
	for await (const e of stream) events.push(e);
	return { events, message: await stream.result(), recorded: JSON.parse(readFileSync(record, "utf8")) };
}

const texts = (message: any): string[] =>
	message.content.filter((c: any) => c.type === "text").map((c: any) => c.text as string);

before(() => {
	runtime.cwd = work;
	const command = `"${process.execPath}" "${join(here, "fake-agy.mjs")}"`;
	for (const [id, name] of [
		["antigravity", "Antigravity"],
		["antigravity-work", "Work"],
	]) {
		runtime.instances.set(id, { instance: { id, name, command }, models: parseModels(MODELS) });
	}
});

test("streams tool calls under Claude's names, a diff for the edit and the text", async () => {
	writeFileSync(demo, "one\ntwo\nthree\n");
	const tools: unknown[] = [];
	runtime.onTool = (event) => tools.push(event);
	const { message, events } = await run(toolRun());
	runtime.onTool = undefined;
	assert.equal(message.stopReason, "stop");
	assert.equal(events.at(-1).type, "done");
	const lines = texts(message);
	assert.equal(lines[0], "⏺ **Bash** ` npm test `");
	assert.equal(lines[1], "⎿ 2 lines\n\n```\n12 passing\nall good\n```");
	assert.equal(lines[2], "⏺ **Write** ` demo.txt `");
	assert.ok(lines[3].startsWith("⎿ Updated ` demo.txt ` (+1 −1)"));
	assert.match(lines[3], /\n one\n-two\n\+2\n three\n/);
	assert.equal(lines.at(-1), "Done.");
	assert.deepEqual(tools, [
		{ type: "start", name: "Bash", detail: "npm test" },
		{ type: "end", isError: false },
		{ type: "start", name: "Write", detail: demo },
		{ type: "end", isError: false },
	]);
	assert.equal(message.usage.input, 300);
	assert.equal(message.usage.output, 45);
});

test("starts a conversation with the instructions, the effort's variant and the mode", async () => {
	const { recorded } = await run(toolRun());
	const args: string[] = recorded.args;
	assert.ok(args[0].startsWith("--print=<pi_instructions>"));
	assert.ok(args[0].endsWith("Change demo.txt"));
	assert.equal(args[args.indexOf("--model") + 1], "gemini-4-argon-high");
	assert.equal(args[args.indexOf("--mode") + 1], "accept-edits");
	assert.ok(args[args.indexOf("--add-dir") + 1].startsWith(join(work, "scratch")));
	// pi's MCP servers (none here) instead of agy's own, through a mirror of the gemini folder.
	const mirror = args.find((a) => a.startsWith("--gemini_dir="))!.slice("--gemini_dir=".length);
	assert.ok(mirror.startsWith(join(work, "mcp")));
	assert.deepEqual(JSON.parse(readFileSync(join(mirror, "config", "mcp_config.json"), "utf8")), { mcpServers: {} });
	assert.deepEqual(loadSessions()[SESSION], { conversationId: CONVERSATION, cwd: work, messageCount: 2, context: { tokens: 220 } });
});

test("pi's MCP servers: through pi's connections with pi-bridge, else started by agy without the tools pi hides", async () => {
	const file = join(work, "agent", "mcp.json");
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify({ mcpServers: { maestro: { command: "maestro", args: ["mcp"], toolExposure: { "*cloud*": "hidden" } } } }));
	const mcpConfig = (args: string[]) => {
		const mirror = args.find((a) => a.startsWith("--gemini_dir="))!.slice("--gemini_dir=".length);
		return JSON.parse(readFileSync(join(mirror, "config", "mcp_config.json"), "utf8")).mcpServers;
	};
	try {
		runtime.piTools = () => [{ name: "mcp__maestro__run_on_cloud", exposure: "hidden", sourceInfo: { path: "builtin:mcp" } }];
		const alone = mcpConfig((await run(toolRun())).recorded.args);
		assert.deepEqual(alone.maestro, { command: "maestro", args: ["mcp"], disabledTools: ["run_on_cloud"] });

		runtime.bridge = () => ({ name: "pi", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer t" }, mcpUrl: "http://127.0.0.1:9/mcp" });
		const bridged = mcpConfig((await run(toolRun())).recorded.args);
		assert.deepEqual(bridged.maestro, { type: "http", url: "http://127.0.0.1:9/mcp/maestro", headers: { Authorization: "Bearer t" } });
	} finally {
		runtime.piTools = undefined;
		runtime.bridge = undefined;
		writeFileSync(file, JSON.stringify({ mcpServers: {} }));
	}
});

test("continues the conversation with only the new message", async () => {
	const answer = { role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: 1 };
	const next = { role: "user", content: "And now?", timestamp: 2 };
	const { recorded } = await run(toolRun(), [prompt, answer, next], "low");
	const args: string[] = recorded.args;
	assert.equal(args[0], "--print=And now?");
	assert.equal(args[args.indexOf("--conversation") + 1], CONVERSATION);
	assert.equal(args[args.indexOf("--model") + 1], "gemini-4-argon-low");
});

test("an image in the prompt goes to agy as a file in the session's temp folder", async () => {
	const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
	const withImage = { role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image", data: png, mimeType: "image/png" }], timestamp: 0 };
	const { recorded } = await run(toolRun(), [withImage]);
	const file = /\[image attached as file: (\S+\.png) \(open it to see it\)\]$/.exec(recorded.args[0])?.[1];
	assert.ok(file, recorded.args[0].slice(-200));
	assert.ok(file.startsWith(join(work, "scratch")));
	assert.equal(readFileSync(file).toString("base64"), png);
});

test("lists denied actions with the rule that allows them", async () => {
	const command = { name: "run_command", parameters: { CommandLine: "ls -la" } };
	const denied = {
		...command,
		error: { type: "TOOL_ERROR", message: 'permission check failed for unsandboxed "ls -la": user denied permission to run command:\nls -la\nDo not …' },
	};
	const { message } = await run([
		step(1, "DONE", "agent_response", { usage: usage(100, 10) }),
		step(2, "ACTIVE", "tool", { tool_name: "run_command", tool_info: command }),
		step(2, "ERROR", "tool", { tool_name: "run_command", tool_info: denied }),
		result({ response: "", denied_actions: [{ action: "command", display_name: "RunCommand" }] }),
	]);
	assert.equal(message.stopReason, "stop");
	assert.deepEqual(runtime.denials, {
		mode: "accept-edits",
		items: [{ tool: "Bash", detail: "ls -la", rule: "command(ls -la)", action: "run_command" }],
	});
	assert.ok(texts(message).some((t) => t.startsWith("✗ permission check failed")));
	assert.ok(texts(message).at(-1)!.startsWith("> ⚠ **1 action was not allowed** in mode `accept-edits`"));
});

test("allowing everything once skips agy's permission checks for one run", async () => {
	runtime.skipPermissionsOnce = true;
	const first = await run([result()]);
	assert.ok(first.recorded.args.includes("--dangerously-skip-permissions"));
	assert.ok(!first.recorded.args.includes("--mode"));
	const second = await run([result()]);
	assert.ok(!second.recorded.args.includes("--dangerously-skip-permissions"));
});

test("agy's error output loses its machine-readable copy", () => {
	assert.equal(errorText('Error: building toolbox failed\nAGY_ERROR: {"short_error":"x"}\n'), "Error: building toolbox failed");
	assert.equal(errorText("plain\n"), "plain");
});

test("a failed run ends with agy's message", async () => {
	const { message } = await run([result({ status: "ERROR", response: "model unavailable" })]);
	assert.equal(message.stopReason, "error");
	assert.equal(message.errorMessage, "model unavailable");
});

test("without instances there is the default one, with the command earlier versions saved", () => {
	writeFileSync(CONFIG_FILE, JSON.stringify({ command: "my-agy", contextWindow: 500000 }));
	assert.deepEqual(loadInstances(), [{ id: "antigravity", name: "Antigravity", command: "my-agy", contextWindow: 500000 }]);
});

test("instances get provider ids under the antigravity prefix", () => {
	assert.equal(providerIdFor("Work", new Set()), "antigravity-work");
	assert.equal(providerIdFor("Work", new Set(["antigravity-work"])), "antigravity-work-2");
	assert.equal(providerIdFor("Antigravity", new Set()), "antigravity");
	assert.ok(saveInstances([{ id: "antigravity-work", name: "Work", command: "AGY_ADC_AUTH=1 agy" }]));
	assert.deepEqual(loadInstances(), [{ id: "antigravity-work", name: "Work", command: "AGY_ADC_AUTH=1 agy" }]);
	writeFileSync(CONFIG_FILE, "{}");
});

test("each instance keeps its model list; the old single list stays the default's", () => {
	writeFileSync(MODELS_FILE, JSON.stringify({ models: [{ id: "old", name: "Old", efforts: [] }] }));
	saveCachedModels("antigravity-work", parseModels(MODELS));
	assert.equal(loadCachedModels("antigravity")?.[0].id, "old");
	assert.equal(loadCachedModels("antigravity-work")?.length, 3);
	assert.equal(loadCachedModels("antigravity-other"), undefined);
	const [argon] = parseModels(MODELS);
	assert.equal(toProviderModel(argon).name, "Antigravity · Gemini 4 Argon");
	assert.equal(toProviderModel(argon, "Work").name, "Antigravity · Gemini 4 Argon @ Work");
});

test("another instance runs its own command and keeps its own conversation", async () => {
	const { recorded } = await run(toolRun(), [prompt], "high", "antigravity-work");
	assert.ok(!recorded.args.includes("--conversation"));
	assert.equal(sessionKey("antigravity", SESSION), SESSION);
	assert.equal(loadSessions()[sessionKey("antigravity-work", SESSION)]?.conversationId, CONVERSATION);
});

test("a model of an unknown instance fails with a clear message", async () => {
	const { message } = await run([result()], [prompt], "high", "antigravity-gone");
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage ?? "", /No Antigravity CLI instance/);
});

test("streams thinking blocks from agy's conversation transcript before tool calls and the final answer", async () => {
	const logsDir = join(work, "brain", CONVERSATION, ".system_generated", "logs");
	mkdirSync(logsDir, { recursive: true });
	const transcript = [
		{ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", thinking: "Run the tests first, then update demo.txt." },
		{ step_index: 4, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", thinking: "All tests pass and demo.txt is updated." },
	];
	writeFileSync(join(logsDir, "transcript_full.jsonl"), `${transcript.map((l) => JSON.stringify(l)).join("\n")}\n`);
	writeFileSync(demo, "one\ntwo\nthree\n");

	const { message } = await run(toolRun());
	const thoughts = message.content.filter((c: any) => c.type === "thinking").map((c: any) => c.thinking);
	assert.deepEqual(thoughts, [
		"Run the tests first, then update demo.txt.",
		"All tests pass and demo.txt is updated.",
	]);
	const grouped = groupMessage(message.content as any);
	assert.equal(grouped.answer, "Done.");
	assert.deepEqual(
		grouped.work.map((s) => s.kind),
		["thinking", "tools", "thinking"],
	);
});

test("a gated run gets pi's hook next to the user's hooks and the gate's rules next to the user's", async () => {
	const { gateHooks, gateSettings } = await import("../extensions/antigravity/mcp.ts");
	const { mkdtempSync, mkdirSync: mk, writeFileSync: wf } = await import("node:fs");
	const { tmpdir: td } = await import("node:os");
	const { join: j } = await import("node:path");
	const dir = mkdtempSync(j(td(), "agy-gate-"));
	mk(j(dir, "config"), { recursive: true });
	wf(j(dir, "config", "hooks.json"), JSON.stringify({ mine: { PostToolUse: [] } }));
	wf(j(dir, "settings.json"), JSON.stringify({ permissions: { allow: ["command(ls)"], deny: ["command(rm)"] } }));
	const gate = { url: "http://127.0.0.1:1/hook", headers: { Authorization: "Bearer t" }, allow: ["command(*)", "command(ls)"], timeout: 3600 };
	const hooks = JSON.parse(gateHooks(gate, dir));
	assert.deepEqual(Object.keys(hooks), ["mine", "pi-gate"]);
	const hook = hooks["pi-gate"].PreToolUse[0];
	assert.equal(hook.matcher, "*");
	assert.equal(hook.hooks[0].timeout, 3600);
	assert.match(hook.hooks[0].command, /^curl -sS --fail --max-time 3600 -H @'.+' .*'http:\/\/127\.0\.0\.1:1\/hook'$/);
	assert.doesNotMatch(hook.hooks[0].command, /Bearer/, "the token stays in a private file");
	const [flag, json] = gateSettings(gate, j(dir, "settings.json"));
	assert.equal(flag, "--settings");
	assert.deepEqual(JSON.parse(json), { permissions: { allow: ["command(ls)", "command(*)"], deny: ["command(rm)"] } });
});

test("agy's permission hook waits for the user as good as without a limit", async () => {
	const { HOOK_TIMEOUT } = await import("../extensions/pi-bridge/agy-gate.ts");
	assert.ok(HOOK_TIMEOUT >= 7 * 24 * 3600);
});

test("Escape while agy waits for a command says in the chat which steps it ended", async () => {
	const command = { name: "run_command", parameters: { CommandLine: "gh run watch 42" } };
	const fixture = join(work, "fixture.jsonl");
	const lines = [
		{ event: "init", conversation_id: CONVERSATION, init: { model: "gemini-4-argon-high" } },
		step(0, "DONE", "user_input"),
		step(1, "ACTIVE", "tool", { tool_name: "run_command", tool_info: command }),
		{ hang: true },
	];
	writeFileSync(fixture, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	process.env.FAKE_AGY_FIXTURE = fixture;
	const abort = new AbortController();
	let stopped: string[] | undefined;
	runtime.onTool = (event) => {
		if (event.type === "start") abort.abort();
	};
	runtime.onToolsStopped = (descriptions) => {
		stopped = descriptions;
	};
	try {
		const model = { id: "gemini-4-argon", provider: "antigravity", api: "antigravity-cli:antigravity", reasoning: true } as any;
		const stream = streamAntigravity(model, { messages: [prompt] } as any, { sessionId: SESSION, signal: abort.signal } as any);
		for await (const _ of stream);
		assert.equal((await stream.result()).stopReason, "aborted");
		assert.equal(stopped?.length, 1);
		assert.match(stopped![0], /gh run watch 42/);
	} finally {
		runtime.onTool = undefined;
		runtime.onToolsStopped = undefined;
	}
});
