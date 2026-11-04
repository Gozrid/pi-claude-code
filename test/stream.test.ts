/**
 * The provider stream end to end, against a fake `claude` that plays back the
 * JSON lines a real CLI run prints (shapes taken from Claude Code 2.1).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), "pi-claude-code-test-"));
// Keep the sessions file and scratch dirs away from the real ~/.pi/agent.
process.env.PI_CODING_AGENT_DIR = join(work, "agent");
process.env.PI_CLAUDE_SCRATCH_DIR = join(work, "scratch");
process.env.PI_MCP_DIR = join(work, "mcp");

const { runtime } = await import("../extensions/claude-code/state.ts");
const { streamClaudeCode, sessionKey, loadSessions } = await import("../extensions/claude-code/stream.ts");

const PROVIDER = "claude-test";
const SESSION = "pi-session-1";
const record = join(work, "record.json");

const event = (e: unknown) => ({ type: "stream_event", event: e, session_id: "claude-session-1" });
const block = (index: number, content_block: unknown) => event({ type: "content_block_start", index, content_block });
const delta = (index: number, d: unknown) => event({ type: "content_block_delta", index, delta: d });
const stop = (index: number) => event({ type: "content_block_stop", index });
const usage = (input: number, cacheRead: number, cacheWrite: number) =>
	event({
		type: "message_start",
		message: {
			usage: {
				input_tokens: input,
				cache_read_input_tokens: cacheRead,
				cache_creation_input_tokens: cacheWrite,
				output_tokens: 1,
			},
		},
	});
const toolCall = (index: number, id: string, name: string, input: unknown) => [
	block(index, { type: "tool_use", id, name, input: {} }),
	delta(index, { type: "input_json_delta", partial_json: JSON.stringify(input) }),
	stop(index),
];
const toolResult = (id: string, content: string, structured: unknown, isError = false) => ({
	type: "user",
	message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
	tool_use_result: structured,
});

function result(extra: Record<string, unknown> = {}) {
	return {
		type: "result",
		subtype: "success",
		is_error: false,
		result: "Done.",
		stop_reason: "end_turn",
		total_cost_usd: 0.01,
		session_id: "claude-session-1",
		modelUsage: {
			"claude-main": { inputTokens: 15, cacheReadInputTokens: 2300, cacheCreationInputTokens: 200, contextWindow: 200000 },
			"claude-haiku": { inputTokens: 3, contextWindow: 1000000 },
		},
		...extra,
	};
}

/** A run with thinking, an edit, task tools, a rate limit event and a final text. */
function toolRun(extra: Record<string, unknown> = {}) {
	return [
		{ type: "system", subtype: "init", session_id: "claude-session-1" },
		usage(10, 1000, 200),
		block(0, { type: "thinking", thinking: "" }),
		delta(0, { type: "thinking_delta", thinking: "Plan." }),
		stop(0),
		...toolCall(1, "t1", "Edit", { file_path: join(work, "demo.txt"), old_string: "two", new_string: "2" }),
		...toolCall(2, "t2", "TaskCreate", { subject: "Write intro", activeForm: "Writing intro" }),
		event({ type: "message_delta", usage: { output_tokens: 50 } }),
		toolResult("t1", "The file was updated.", {
			filePath: join(work, "demo.txt"),
			structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" one", "-two", "+2"] }],
		}),
		toolResult("t2", "Task #1 created successfully: Write intro", { task: { id: "1", subject: "Write intro" } }),
		{ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.25, resets_at: 2e9 } } } },
		usage(5, 1300, 0),
		...toolCall(0, "t3", "TaskUpdate", { taskId: "1", status: "in_progress" }),
		block(1, { type: "text", text: "" }),
		delta(1, { type: "text_delta", text: "Done." }),
		stop(1),
		event({ type: "message_delta", usage: { output_tokens: 10 } }),
		toolResult("t3", "Updated task #1 status", { success: true, taskId: "1" }),
		result(extra),
	];
}

const prompt = { role: "user", content: "Change demo.txt", timestamp: 0 };

async function run(lines: unknown[], messages: unknown[] = [prompt]) {
	const fixture = join(work, "fixture.jsonl");
	writeFileSync(fixture, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	process.env.FAKE_CLAUDE_FIXTURE = fixture;
	process.env.FAKE_CLAUDE_RECORD = record;
	const model = { id: "opus", provider: PROVIDER, api: `claude-code-cli:${PROVIDER}`, reasoning: true } as any;
	const stream = streamClaudeCode(model, { messages } as any, { sessionId: SESSION } as any);
	const events: any[] = [];
	for await (const e of stream) events.push(e);
	return { events, message: await stream.result(), recorded: JSON.parse(readFileSync(record, "utf8")) };
}

const texts = (message: any): string[] =>
	message.content.filter((c: any) => c.type === "text").map((c: any) => c.text as string);

before(() => {
	runtime.cwd = work;
	runtime.permissionMode = "auto";
	runtime.instances.set(PROVIDER, {
		instance: { id: PROVIDER, name: "Test", command: `"${process.execPath}" "${join(here, "fake-claude.mjs")}"` },
		models: [],
	});
});

after(() => {
	runtime.instances.delete(PROVIDER);
});

test("streams thinking, tool calls and text, and finishes with stop", async () => {
	const { message, events } = await run(toolRun());
	assert.equal(message.stopReason, "stop");
	assert.equal(events.at(-1).type, "done");
	const thinking = message.content.find((c) => c.type === "thinking");
	assert.ok(thinking?.type === "thinking");
	assert.equal(thinking.thinking, "Plan.");
	assert.ok(texts(message).some((t) => t.startsWith("⏺ **Edit**")));
	assert.equal(texts(message).at(-1), "Done.");
	assert.equal(message.usage.output, 60);
	assert.equal(message.usage.cost.total, 0.01);
});

test("shows an edit as a diff block with the path relative to the project", async () => {
	const { message } = await run(toolRun());
	const diff = texts(message).find((t) => t.includes("```diff"));
	assert.ok(diff, "a diff block");
	assert.ok(diff.startsWith("⎿ Updated ` demo.txt ` (+1 −1)"));
	assert.match(diff, /\n-two\n\+2\n/);
});

test("shows MCP calls as Server › tool with their code, and their images and file contents in the chat", async () => {
	const png = Buffer.from("fake png").toString("base64");
	const { message } = await run([
		{ type: "system", subtype: "init", session_id: "claude-session-1" },
		usage(10, 0, 0),
		...toolCall(0, "m1", "mcp__freecad__execute_code", { code: "import FreeCAD\nprint(1)" }),
		...toolCall(1, "r1", "Read", { file_path: join(work, "demo.ts") }),
		{
			type: "user",
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "m1",
						content: [
							{ type: "text", text: "1" },
							{ type: "image", source: { type: "base64", media_type: "image/png", data: png } },
						],
					},
				],
			},
		},
		toolResult("r1", "     3\tconst a = 1;", { type: "text", file: { filePath: join(work, "demo.ts"), content: "const a = 1;", startLine: 3 } }),
		result(),
	]);
	const [call, read, out, file] = texts(message);
	assert.equal(call, "⏺ **FreeCAD › execute_code**\n\n```python\nimport FreeCAD\nprint(1)\n```");
	assert.ok(read.startsWith("⏺ **Read** ` demo.ts `"));
	// The result follows another call, so it names its tool; the image lies in the scratch dir.
	const image = /!\[image 1\]\((.+)\)/.exec(out)?.[1];
	assert.ok(out.startsWith("⎿ **FreeCAD › execute_code** · ` 1 `"), out);
	assert.ok(image?.startsWith(join(work, "scratch")) && readFileSync(image).toString() === "fake png");
	assert.equal(file, "⎿ 1 line\n\n```typescript:3\nconst a = 1;\n```");
});

test("keeps task tools out of the chat and follows the task list", async () => {
	let updates = 0;
	runtime.onTasks = () => updates++;
	const { message } = await run(toolRun());
	runtime.onTasks = undefined;
	assert.ok(!texts(message).some((t) => t.includes("TaskCreate") || t.includes("Task #1")));
	const key = sessionKey(PROVIDER, SESSION);
	assert.deepEqual(runtime.tasks.get(key), [
		{ id: "1", subject: "Write intro", status: "in_progress", activeForm: "Writing intro" },
	]);
	assert.equal(updates, 2);
	assert.deepEqual(loadSessions()[key].tasks, runtime.tasks.get(key));
});

test("records the context size of the last API call and the main model's window", async () => {
	await run(toolRun());
	const key = sessionKey(PROVIDER, SESSION);
	// Last call: 5 input + 1300 cache read + 10 output.
	assert.deepEqual(runtime.context.get(key), { tokens: 1315, window: 200000 });
	assert.deepEqual(loadSessions()[key].context, { tokens: 1315, window: 200000 });
});

test("updates plan usage from rate limit events", async () => {
	let calls = 0;
	runtime.onUsage = () => calls++;
	await run(toolRun());
	runtime.onUsage = undefined;
	assert.equal(runtime.instances.get(PROVIDER)?.usage?.session?.percent, 25);
	// The rate limit event plus one redraw per API call for the live context size.
	assert.equal(calls, 3);
});

test("reports the context size live with every API call of a run", async () => {
	const key = sessionKey(PROVIDER, SESSION);
	runtime.context.set(key, { tokens: 99, window: 200000 });
	const seen: unknown[] = [];
	runtime.onUsage = () => seen.push({ ...runtime.context.get(key) });
	await run(toolRun());
	runtime.onUsage = undefined;
	// First call: 10 input + 1000 cache read + 200 cache write + 1 output; the window is kept from before.
	assert.deepEqual(seen[0], { tokens: 1211, window: 200000 });
	assert.deepEqual(seen.at(-1), { tokens: 1306, window: 200000 });
});

test("resumes the Claude session on the next prompt and turns the task tools on", async () => {
	await run(toolRun());
	const answer = { role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: 1 };
	const next = { role: "user", content: "And now three.", timestamp: 2 };
	const { recorded } = await run(toolRun(), [prompt, answer, next]);
	assert.ok(recorded.args.includes("--resume"));
	assert.equal(recorded.args[recorded.args.indexOf("--resume") + 1], "claude-session-1");
	assert.equal(recorded.env.tasks, "1");
	// Only the new message goes to the resumed session.
	assert.match(recorded.stdin, /And now three\./);
	assert.doesNotMatch(recorded.stdin, /Change demo\.txt/);
});

test("gives Claude pi's MCP servers and only those, in a file only the user reads", async () => {
	mkdirSync(join(work, "agent"), { recursive: true });
	writeFileSync(join(work, "agent", "mcp.json"), JSON.stringify({ mcpServers: { docs: { url: "https://example.com/mcp" } } }));
	const { recorded } = await run(toolRun());
	const args: string[] = recorded.args;
	assert.ok(args.includes("--strict-mcp-config"));
	const file = args[args.indexOf("--mcp-config") + 1]!;
	assert.ok(file.startsWith(join(work, "mcp")));
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { mcpServers: { docs: { type: "http", url: "https://example.com/mcp" } } });
});

test("with pi-bridge, Claude reaches pi's MCP servers through pi's connections instead of starting them again", async () => {
	runtime.bridge = () => ({ name: "pi", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer t" }, mcpUrl: "http://127.0.0.1:9/mcp" });
	try {
		const { recorded } = await run(toolRun());
		const args: string[] = recorded.args;
		const servers = JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1]!, "utf8")).mcpServers;
		assert.deepEqual(servers.docs, { type: "http", url: "http://127.0.0.1:9/mcp/docs", headers: { Authorization: "Bearer t" } });
		assert.ok(!args.includes("--disallowedTools"), "pi's proxy leaves the hidden tools out itself");
	} finally {
		runtime.bridge = undefined;
	}
});

test("without pi-bridge, Claude starts pi's servers itself and the tools pi hides are disallowed", async () => {
	runtime.piTools = () => [
		{ name: "mcp__docs__delete_page", exposure: "hidden", sourceInfo: { path: "builtin:mcp" } },
		{ name: "mcp__docs__search", exposure: "direct", sourceInfo: { path: "builtin:mcp" } },
	];
	try {
		const { recorded } = await run(toolRun());
		const args: string[] = recorded.args;
		assert.equal(args[args.indexOf("--disallowedTools") + 1], "mcp__docs__delete_page");
	} finally {
		runtime.piTools = undefined;
	}
});

test("lists denied actions and remembers them for the retry offer", async () => {
	const { message } = await run(
		toolRun({ permission_denials: [{ tool_name: "Bash", tool_use_id: "t9", tool_input: { command: "rm -rf build" } }] }),
	);
	const note = texts(message).find((t) => t.includes("not allowed"));
	assert.ok(note);
	assert.match(note, /\*\*1 action was not allowed\*\* in mode `auto`/);
	assert.ok(note.includes("- **Bash** ` rm -rf build `"));
	assert.deepEqual(runtime.denials, { mode: "auto", items: [{ tool: "Bash", detail: "rm -rf build" }] });
});

test("passes tools allowed once to the next run only", async () => {
	runtime.allowOnce = ["Bash", "Write"];
	const first = await run(toolRun());
	assert.equal(first.recorded.args[first.recorded.args.indexOf("--allowedTools") + 1], "Bash,Write");
	const second = await run(toolRun());
	assert.ok(!second.recorded.args.includes("--allowedTools"));
});

test("reports an error result as an error", async () => {
	const { message, events } = await run([
		{ type: "system", subtype: "init", session_id: "claude-session-1" },
		{ type: "result", subtype: "error_during_execution", is_error: true, result: "Claude AI usage limit reached" },
	]);
	assert.equal(message.stopReason, "error");
	assert.equal(message.errorMessage, "Claude AI usage limit reached");
	assert.equal(events.at(-1).type, "error");
});

test("reports a CLI that exits without a result", async () => {
	process.env.FAKE_CLAUDE_EXIT = "3";
	const { message } = await run([{ type: "system", subtype: "init" }]);
	delete process.env.FAKE_CLAUDE_EXIT;
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage ?? "", /exited with code 3 without a result/);
});

test("with pi's own server, Claude gets it too and asks pi before what its mode does not allow", async () => {
	runtime.bridge = () => ({ name: "pi", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer t" }, permissionTool: "mcp__pi__permission" });
	try {
		const { message, recorded } = await run(
			toolRun({ permission_denials: [{ tool_name: "Bash", tool_use_id: "t9", tool_input: { command: "rm -rf build" } }] }),
		);
		const args: string[] = recorded.args;
		assert.equal(args[args.indexOf("--permission-prompts") + 1], "host");
		assert.equal(args[args.indexOf("--permission-prompt-tool") + 1], "mcp__pi__permission");
		const servers = JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1]!, "utf8")).mcpServers;
		assert.deepEqual(servers.pi, { type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer t" } });
		// The user denied it in pi already: no note, no retry offer.
		assert.ok(!texts(message).some((t) => t.includes("not allowed")));
		assert.equal(runtime.denials, undefined);
	} finally {
		runtime.bridge = undefined;
	}
});

test("without a user interface to ask, prompts are denied as before", async () => {
	runtime.bridge = () => ({ name: "pi", url: "http://127.0.0.1:9/mcp", headers: {} });
	try {
		const { recorded } = await run(toolRun());
		const args: string[] = recorded.args;
		assert.equal(args[args.indexOf("--permission-prompts") + 1], "none");
		assert.ok(!args.includes("--permission-prompt-tool"));
	} finally {
		runtime.bridge = undefined;
	}
});

test("claude waits for pi's dialogs: no MCP tool timeout unless the user set one", async () => {
	const { childEnv, MCP_TOOL_TIMEOUT_MS } = await import("../extensions/claude-code/cli.ts");
	const env = childEnv({ FOO: "1" }, { CLAUDECODE: "1", PATH: "/bin" });
	assert.equal(env.MCP_TOOL_TIMEOUT, String(MCP_TOOL_TIMEOUT_MS));
	assert.ok(MCP_TOOL_TIMEOUT_MS >= 7 * 24 * 3600_000 && MCP_TOOL_TIMEOUT_MS < 2 ** 31);
	assert.equal(env.CLAUDECODE, undefined);
	assert.equal(env.FOO, "1");
	assert.equal(childEnv(undefined, { MCP_TOOL_TIMEOUT: "5000" }).MCP_TOOL_TIMEOUT, "5000");
});

// Steering: claude takes a steer up while it works; the answer splits there and the next turn reads on.
const say = (index: number, text: string) => [
	block(index, { type: "text", text: "" }),
	delta(index, { type: "text_delta", text }),
	stop(index),
];
const steerText = "fix the test first";
const steerMessage = { role: "user", content: [{ type: "text", text: steerText }], timestamp: 0 };

/** One pi turn; `steer` goes into claude with the turn's first event. */
async function turn(messages: unknown[], sessionId: string, steer?: string) {
	const { steerRun } = await import("../extensions/claude-code/stream.ts");
	const model = { id: "opus", provider: PROVIDER, api: `claude-code-cli:${PROVIDER}`, reasoning: true } as any;
	const stream = streamClaudeCode(model, { messages } as any, { sessionId } as any);
	let steered = !steer;
	for await (const _ of stream) {
		if (!steered) {
			steered = true;
			assert.equal(steerRun(steer!), true, "the steer goes into the running claude");
		}
	}
	return stream.result();
}

function fixture(lines: unknown[]) {
	const file = join(work, "steer-fixture.jsonl");
	writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	process.env.FAKE_CLAUDE_FIXTURE = file;
	process.env.FAKE_CLAUDE_RECORD = record;
}

test("a steer reaches claude after its current step: the answer splits there and the next turn reads on in the same run", async () => {
	const { steerRun } = await import("../extensions/claude-code/stream.ts");
	assert.equal(steerRun(steerText), false, "nothing to steer while claude does not run");
	fixture([
		{ type: "system", subtype: "init", session_id: "claude-steer" },
		usage(10, 0, 0),
		...toolCall(0, "t1", "Bash", { command: "ls" }),
		event({ type: "message_delta", usage: { output_tokens: 20 } }),
		toolResult("t1", "a.txt", undefined),
		{ fake: "read" },
		{ fake: "replay" },
		usage(5, 0, 0),
		...say(0, "Steered."),
		event({ type: "message_delta", usage: { output_tokens: 5 } }),
		result({ session_id: "claude-steer" }),
	]);
	const first = await turn([prompt], "steer-1", steerText);
	assert.equal(first.stopReason, "stop", "the answer so far ends where claude took the steer up");
	assert.ok(texts(first).some((t) => t.startsWith("⏺ **Bash**")));
	assert.ok(!texts(first).includes("Steered."));
	assert.equal(runtime.live?.detached, true, "claude keeps running for the next turn");

	const second = await turn([prompt, first, steerMessage], "steer-1");
	assert.equal(second.stopReason, "stop");
	assert.deepEqual(texts(second), ["Steered."], "the next turn reads on in the same run");
	assert.equal(runtime.live, undefined);
	const recorded = JSON.parse(readFileSync(record, "utf8"));
	const inputs = recorded.stdin.trim().split("\n").map((l: string) => JSON.parse(l));
	assert.equal(inputs.length, 2, "one claude process: the prompt and the steer");
	assert.deepEqual(inputs[1].message.content, [{ type: "text", text: steerText }]);
	assert.ok(recorded.args.includes("--replay-user-messages"));
	assert.equal(loadSessions()[sessionKey(PROVIDER, "steer-1")].messageCount, 4, "pi's transcript and claude's session agree");
});

test("a steer during the final answer splits at the result and continues as claude's next turn", async () => {
	fixture([
		{ type: "system", subtype: "init", session_id: "claude-steer" },
		usage(10, 0, 0),
		...say(0, "First answer."),
		event({ type: "message_delta", usage: { output_tokens: 5 } }),
		{ fake: "read" },
		result({ session_id: "claude-steer", result: "First answer." }),
		{ type: "system", subtype: "init", session_id: "claude-steer" },
		{ fake: "replay" },
		usage(5, 0, 0),
		...say(0, "Second."),
		result({ session_id: "claude-steer", result: "Second." }),
	]);
	const first = await turn([prompt], "steer-2", steerText);
	assert.deepEqual(texts(first), ["First answer."]);
	assert.equal(runtime.live?.detached, true);
	const second = await turn([prompt, first, steerMessage], "steer-2");
	assert.deepEqual(texts(second), ["Second."], "claude's echo of the expected steer splits nothing");
	assert.equal(runtime.live, undefined);
});

test("a result claude reports before it takes up the prompt does not end the answer", async () => {
	// Resumed after a run that left a background task behind: claude first reports that task as stopped.
	fixture([
		{ type: "system", subtype: "task_notification", session_id: "claude-bg" },
		{ type: "system", subtype: "init", session_id: "claude-bg" },
		result({ session_id: "claude-bg", num_turns: 0, result: "" }),
		{ type: "system", subtype: "init", session_id: "claude-bg" },
		{ fake: "prompt" },
		usage(5, 0, 0),
		...say(0, "The real answer."),
		result({ session_id: "claude-bg", result: "The real answer." }),
	]);
	const answer = await turn([prompt], "bg-1");
	assert.equal(answer.stopReason, "stop");
	assert.deepEqual(texts(answer), ["The real answer."]);
	assert.equal(runtime.live, undefined, "claude is done after the turn's own result");
});

test("a steer pi does not deliver stops the claude kept for it; the next prompt starts a new run", async () => {
	const { dropLiveRun } = await import("../extensions/claude-code/stream.ts");
	fixture([
		{ type: "system", subtype: "init", session_id: "claude-steer" },
		usage(10, 0, 0),
		...toolCall(0, "t1", "Bash", { command: "ls" }),
		toolResult("t1", "a.txt", undefined),
		{ fake: "read" },
		{ fake: "replay" },
		...say(0, "Steered."),
		result({ session_id: "claude-steer" }),
	]);
	const first = await turn([prompt], "steer-3", steerText);
	const kept = runtime.live;
	assert.equal(kept?.detached, true);
	dropLiveRun();
	assert.equal(runtime.live, undefined);
	assert.notEqual(await kept!.exited, undefined, "the kept claude is stopped");

	// A different message than the steer starts a new run instead of reading on.
	const { message } = await run([{ type: "system", subtype: "init", session_id: "claude-steer" }, ...say(0, "Fresh."), result()], [
		prompt,
		first,
		{ role: "user", content: "something else", timestamp: 0 },
	]);
	assert.deepEqual(texts(message), ["Fresh."]);
});
