import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AgySubagentWatcher, decodeArgs, messageText, transcriptPath } from "../extensions/antigravity/subagents.ts";
import { projectSlug, readTranscript, SubagentWatcher, subagentsDir, type Transcript } from "../extensions/claude-code/subagents.ts";
import type { Subagent } from "../extensions/shared/agent-bus.ts";
import { JsonlTail, MAX_STEPS, STALE_MS, subagentStatus } from "../extensions/shared/subagent-files.ts";
import { BOX_ROWS, SubagentBrowser } from "../extensions/subagents/browser.ts";
import { panelLines, sortAgents } from "../extensions/subagents/panel.ts";

const work = realpathSync(mkdtempSync(join(tmpdir(), "subagents-test-")));
const theme = {
	fg: (_c: string, t: string) => t,
	bg: (_c: string, t: string) => t,
	bold: (t: string) => t,
	inverse: (t: string) => t,
};
const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;

test("a JSONL tail returns only complete new lines, and starts over when the file shrinks", () => {
	const file = join(work, "tail.jsonl");
	writeFileSync(file, `${line({ a: 1 })}{"a":`);
	const tail = new JsonlTail(file);
	assert.deepEqual(tail.read(), { entries: [{ a: 1 }], reset: false });
	appendFileSync(file, `2}\n${line({ a: "ü" })}`);
	assert.deepEqual(tail.read().entries, [{ a: 2 }, { a: "ü" }], "the unfinished line comes once complete");
	assert.deepEqual(tail.read().entries, [], "nothing new");
	writeFileSync(file, line({ a: 3 }));
	assert.deepEqual(tail.read(), { entries: [{ a: 3 }], reset: true });
});

test("a subagent is running while its CLI runs or it was busy lately, done once finished, else stopped", () => {
	assert.equal(subagentStatus(true, 0, true, 1), "done");
	assert.equal(subagentStatus(false, 0, true, STALE_MS * 10), "running");
	assert.equal(subagentStatus(false, 1000, false, 1000 + STALE_MS - 1), "running");
	assert.equal(subagentStatus(false, 1000, false, 1000 + STALE_MS), "stopped");
});

test("a Claude subagent transcript becomes prompt, thinking, text, tool and result steps", () => {
	const into: Transcript = { steps: [] };
	readTranscript(
		[
			{ type: "user", timestamp: "2026-11-03T10:00:00Z", message: { content: "Find the callers" } },
			{ type: "assistant", timestamp: "2026-11-03T10:00:02Z", message: { content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "Looking." }, { type: "tool_use", name: "Grep", input: { pattern: "useSession" } }] } },
			{ type: "user", timestamp: "2026-11-03T10:00:03Z", message: { content: [{ type: "tool_result", content: "a.ts\nb.ts\nc.ts\nd.ts\ne.ts" }] } },
			{ type: "user", timestamp: "2026-11-03T10:00:04Z", message: { content: [{ type: "tool_result", is_error: true, content: [{ type: "text", text: "boom" }] }] } },
			{ type: "attachment" },
		],
		into,
	);
	assert.deepEqual(into.steps, [
		{ kind: "prompt", text: "Find the callers" },
		{ kind: "thinking", text: "hm" },
		{ kind: "text", text: "Looking." },
		{ kind: "tool", name: "Grep", detail: "useSession" },
		{ kind: "result", text: "a.ts\nb.ts\nc.ts … +2 lines", isError: false },
		{ kind: "result", text: "boom", isError: true },
	]);
	assert.equal(into.startedAt, Date.parse("2026-11-03T10:00:00Z"));
	assert.equal(into.lastAt, Date.parse("2026-11-03T10:00:04Z"));
	assert.deepEqual(into.lastTool, { name: "Grep", detail: "useSession" });

	const long: Transcript = { steps: [] };
	readTranscript([{ type: "user", message: { content: "p" } }, ...Array.from({ length: MAX_STEPS + 5 }, () => ({ type: "assistant", message: { content: [{ type: "text", text: "x" }] } }))], long);
	assert.equal(long.steps.length, MAX_STEPS);
	assert.equal(long.steps[0].kind, "prompt", "the prompt stays when old steps go");
});

test("a Claude subagent's hand-back is its output as text, without the tool call or Claude's receipt", () => {
	const into: Transcript = { steps: [] };
	readTranscript(
		[
			{ type: "user", message: { content: "Write a poem" } },
			{ type: "assistant", message: { content: [{ type: "thinking", thinking: "  ", signature: "x" }] } },
			{ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "SubagentHandback", input: { message: "Roses are red." } }] } },
		],
		into,
	);
	readTranscript([{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "Delivered." }] } }], into);
	assert.deepEqual(into.steps, [
		{ kind: "prompt", text: "Write a poem" },
		{ kind: "text", text: "Roses are red." },
	]);
	assert.equal(into.lastTool, undefined);
});

test("Claude's subagents folder is found under the project slug, or under whichever project has the session", () => {
	const projects = join(work, "claude", "projects");
	assert.equal(projectSlug("/Users/me/Pro.jekt"), "-Users-me-Pro-jekt");
	assert.equal(subagentsDir(projects, "/a/b", "s1"), join(projects, "-a-b", "s1", "subagents"));
	mkdirSync(join(projects, "-shortened-123", "s2"), { recursive: true });
	assert.equal(subagentsDir(projects, "/a/b", "s2"), join(projects, "-shortened-123", "s2", "subagents"));
});

test("the Claude watcher follows the session's subagents and reports only changes", () => {
	const dir = join(work, "claude-session", "subagents");
	mkdirSync(dir, { recursive: true });
	const watcher = new SubagentWatcher();
	assert.deepEqual(watcher.poll(dir, true), [], "no subagents yet");
	assert.equal(watcher.poll(dir, true), undefined, "unchanged");

	writeFileSync(join(dir, "agent-a1.meta.json"), JSON.stringify({ description: "Review PR 13", agentType: "general-purpose" }));
	writeFileSync(join(dir, "agent-a1.jsonl"), line({ type: "user", timestamp: "2026-11-03T10:00:00Z", message: { content: "Review it" } }));
	let agents = watcher.poll(dir, true)!;
	assert.equal(agents.length, 1);
	assert.deepEqual({ ...agents[0], steps: agents[0].steps.length }, {
		id: "a1",
		description: "Review PR 13",
		type: "general-purpose",
		status: "running",
		startedAt: Date.parse("2026-11-03T10:00:00Z"),
		lastAt: Date.parse("2026-11-03T10:00:00Z"),
		lastTool: undefined,
		steps: 1,
	});

	appendFileSync(join(dir, "agent-a1.jsonl"), line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "gh pr diff 13" } }] } }));
	agents = watcher.poll(dir, true)!;
	assert.deepEqual(agents[0].lastTool, { name: "Bash", detail: "gh pr diff 13" });
	assert.equal(agents[0].steps.length, 2);

	writeFileSync(join(dir, "agent-a1.meta.json"), JSON.stringify({ description: "Review PR 13", agentType: "general-purpose", finished: true }));
	assert.equal(watcher.poll(dir, false)![0].status, "done");
	assert.deepEqual(watcher.poll(undefined, false), [], "another session (or provider) has none");
});

test("agy tool arguments are JSON-encoded; decodeArgs gives the plain values", () => {
	assert.deepEqual(decodeArgs({ CommandLine: '"ls -la"', Wait: "5000", Opts: '{"a":1}', Bad: '"x' }), { CommandLine: "ls -la", Wait: "5000", Opts: { a: 1 }, Bad: '"x' });
});

test("the agy watcher lists the conversation's subagents from agy's records and follows each one's transcript", () => {
	const brain = join(work, "brain");
	const parent = "11111111-1111-4111-8111-111111111111";
	const done = "22222222-2222-4222-8222-222222222222";
	const canceled = "33333333-3333-4333-8333-333333333333";
	const records = join(brain, parent, ".system_generated", "subagents");
	const messages = join(brain, parent, ".system_generated", "messages", "undelivered");
	mkdirSync(records, { recursive: true });
	mkdirSync(messages, { recursive: true });
	for (const id of [done, canceled]) mkdirSync(join(brain, id, ".system_generated", "logs"), { recursive: true });
	const record = (id: string, role: string) =>
		writeFileSync(join(records, `${id}.json`), JSON.stringify({ conversationId: id, subagentDescriptor: { typeName: "research", role }, state: "SUBAGENT_STATE_ALIVE", spawnStepIndex: 2 }));
	// As agy writes them (taken from a real run): the task as a message from the parent, tool arguments JSON-encoded.
	const task = (text: string) => ({
		step_index: 0,
		source: "SYSTEM",
		type: "SYSTEM_MESSAGE",
		status: "DONE",
		created_at: "2026-11-03T22:27:23Z",
		content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-03T22:27:23Z sender=${parent} priority=MESSAGE_PRIORITY_HIGH content=${text}\n</SYSTEM_MESSAGE>`,
	});

	const watcher = new AgySubagentWatcher(brain);
	assert.deepEqual(watcher.poll(parent, true), [], "no subagents yet");

	record(done, "File reader");
	writeFileSync(
		transcriptPath(brain, done),
		line(task("Read a.txt and report its content.")) +
			line({ step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-03T22:27:30Z", tool_calls: [{ name: "view_file", args: { AbsolutePath: '"/w/a.txt"' } }] }),
	);
	let agents = watcher.poll(parent, true)!;
	assert.equal(agents.length, 1);
	assert.deepEqual(
		{ ...agents[0], steps: agents[0].steps.length },
		{
			id: done,
			description: "File reader",
			type: "research",
			status: "running",
			startedAt: Date.parse("2026-11-03T22:27:23Z"),
			lastAt: Date.parse("2026-11-03T22:27:30Z"),
			lastTool: { name: "Read", detail: "/w/a.txt" },
			steps: 2,
		},
	);

	appendFileSync(
		transcriptPath(brain, done),
		line({ step_index: 2, type: "GENERIC", status: "DONE", content: "Created At: x\nCompleted At: y\nhello" }) +
			line({ step_index: 3, type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "send_message", args: { Message: '"hello"' } }] }) +
			line({ step_index: 4, type: "GENERIC", status: "DONE", content: `Message sent to "${parent}".` }) +
			line({ step_index: 5, type: "PLANNER_RESPONSE", status: "DONE", content: "Reported the file contents back to the caller." }),
	);
	agents = watcher.poll(parent, true)!;
	assert.equal(agents[0].status, "done", "a model step without tool calls ends its turn, though agy keeps it alive");
	const shown = (a: Subagent) => a.steps.map((s) => (s.kind === "tool" ? `tool ${s.name} ${s.detail}` : `${s.kind} ${s.text}`));
	assert.deepEqual(shown(agents[0]), [
		"prompt Read a.txt and report its content.",
		"tool Read /w/a.txt",
		"result hello",
		"tool send_message hello",
		`result Message sent to "${parent}".`,
		"text Reported the file contents back to the caller.",
	]);

	// Another one, ended with agy's run: agy says so in a message to the parent.
	record(canceled, "Directory lister");
	writeFileSync(
		transcriptPath(brain, canceled),
		line(task("List the files.")) +
			line({ step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "run_command", args: { CommandLine: '"ls -A"' } }] }) +
			line({ step_index: 2, type: "GENERIC", status: "ERROR", content: "Created At: x\nEncountered error in step execution: permission check failed" }),
	);
	agents = watcher.poll(parent, true)!;
	assert.equal(agents[1].status, "running");
	assert.deepEqual(agents[1].steps.at(-1), { kind: "result", text: "Encountered error in step execution: permission check failed", isError: true });
	writeFileSync(join(messages, "m1.json"), JSON.stringify({ sender: "system", content: `Subagent "${canceled}" has been explicitly canceled by the user and will be idle until you send a message to it directly.` }));
	agents = watcher.poll(parent, true)!;
	assert.deepEqual(agents.map((a) => a.status), ["done", "stopped"]);
	assert.equal(watcher.poll(parent, true), undefined, "unchanged");
	assert.deepEqual(watcher.poll(undefined, false), [], "another session (or provider) has none");
});

test("a message to an agy subagent is the text after content= in agy's wrapper", () => {
	assert.equal(messageText("<SYSTEM_MESSAGE>\n[Message] timestamp=t sender=s content=Do it.\nNow.\n</SYSTEM_MESSAGE>"), "Do it.\nNow.");
	assert.equal(messageText("[Notice] All your subagents have been stopped."), undefined);
});

const agent = (over: Partial<Subagent>): Subagent => ({ id: "x", description: "Agent", status: "running", steps: [], ...over });

test("the panel lists the running subagents with type, run time and their tool", () => {
	const now = Date.parse("2026-11-03T10:01:12Z");
	const running = [agent({ id: "a", description: "Review PR 13", type: "general-purpose", startedAt: Date.parse("2026-11-03T10:00:00Z"), lastTool: { name: "Bash", detail: "gh pr\ndiff 13" } })];
	assert.deepEqual(panelLines(theme, running, now, 200), ["Subagents 1 running · click to watch", "◐ Review PR 13  general-purpose · 1m 12s · Bash gh pr diff 13"]);
	assert.deepEqual(panelLines(theme, [], now, 200), []);
	assert.match(panelLines(theme, [agent({ startedAt: now - 3 * 3_600_000 - 16 * 60_000 })], now, 200)[1], /  3hr 16m$/, "long runs in hours");
	assert.ok(panelLines(theme, running, now, 20).every((l) => visibleWidth(l) <= 20));
	const sorted = sortAgents([
		agent({ id: "old-done", status: "done", startedAt: 1 }),
		agent({ id: "run2", startedAt: 5 }),
		agent({ id: "new-done", status: "done", startedAt: 9 }),
		agent({ id: "run1", startedAt: 2 }),
	]);
	assert.deepEqual(sorted.map((a) => a.id), ["run1", "run2", "new-done", "old-done"], "running first, oldest first; then latest first");
});

test("the popup shows a box per subagent on the left and the selected one's output on the right, following it live", () => {
	const steps: Subagent["steps"] = [
		{ kind: "prompt", text: "Review the pull request" },
		{ kind: "thinking", text: "First the diff." },
		{ kind: "tool", name: "Bash", detail: "gh pr diff 13" },
		{ kind: "result", text: "diff --git a/x", isError: false },
	];
	const agents = [
		agent({ id: "a", description: "Review PR 13", type: "general-purpose", startedAt: 0, lastAt: 20_000, steps }),
		agent({ id: "b", description: "Find callers", type: "Explore", status: "done", startedAt: 0, lastAt: 12_000, steps: [{ kind: "text", text: "Two callers." }] }),
	];
	const events: string[] = [];
	const rows = 24;
	const popup = new SubagentBrowser({
		theme,
		load: () => agents,
		markdown: (text) => text.split("\n"),
		rows: () => rows,
		requestRender() {},
		close: () => events.push("close"),
	});
	let lines = popup.render(100, undefined, 62_000);
	assert.equal(lines.length, rows);
	assert.ok(lines.every((l) => visibleWidth(l) === 100), "every line as wide as the popup");
	let screen = lines.join("\n");
	assert.match(screen, / All 2 .* Running 1 .* Done 1 .* Stopped 0 .*● live/, "filter tabs with counts");
	assert.match(screen, /│ ◐ Review PR 13 /, "a box per subagent");
	assert.match(screen, /│ general-purpose · 1m 2s /);
	assert.match(screen, /│ ✓ Find callers /);
	assert.match(screen, /│ done · 0 tool calls /);
	assert.match(screen, /◐ running · general-purpose · 1m 2s/, "the selected one's header");
	assert.match(screen, /Prompt[\s\S]*Review the pull request[\s\S]*Thinking[\s\S]*First the diff\.[\s\S]*● Bash gh pr diff 13[\s\S]*⎿ diff --git a\/x/, "its output in order");
	assert.match(screen, /◐ working… · last step 42s ago/, "a running one shows it is still at work between steps");
	assert.doesNotMatch(screen, /Two callers/);

	// A click on the second box (three body rows down from the frame, one box further) selects it.
	popup.handleMouse({ type: "click", button: "left", x: 5, y: 3 + BOX_ROWS + 1 } as any);
	screen = popup.render(100, undefined, 62_000).join("\n");
	assert.match(screen, /Two callers/);
	assert.doesNotMatch(screen, /● live/, "a finished one is not live");

	// Back to the running one: new steps keep the newest in view until scrolled up.
	popup.handleInput("\x1b[A");
	for (let i = 0; i < 40; i++) steps.push({ kind: "tool", name: "Read", detail: `file${i}.ts` });
	screen = popup.render(100, undefined, 62_000).join("\n");
	assert.match(screen, /file39\.ts/, "follows the newest step");
	popup.handleInput("\x1b[5~");
	screen = popup.render(100, undefined, 62_000).join("\n");
	assert.doesNotMatch(screen, /file39\.ts/, "page up leaves it");
	assert.match(screen, /paused · end follows/);
	steps.push({ kind: "tool", name: "Read", detail: "later.ts" });
	assert.doesNotMatch(popup.render(100, undefined, 62_000).join("\n"), /later\.ts/, "stays where it was scrolled to");
	popup.handleInput("\x1b[F");
	assert.match(popup.render(100, undefined, 62_000).join("\n"), /later\.ts/, "end follows again");

	popup.handleInput("\x1b");
	assert.deepEqual(events, ["close"]);
});

test("the popup opens like the wish popup and works in one column on a narrow terminal", async () => {
	const { OPENING_MS, UNFOLD_MS } = await import("../extensions/shared/opening.ts");
	const popup = new SubagentBrowser({
		theme,
		load: () => [agent({ id: "a", description: "Solo", steps: [{ kind: "text", text: "hello" }] })],
		markdown: (text) => [text],
		rows: () => 16,
		requestRender() {},
		close() {},
	});
	const unfolding = popup.renderUnfolding(30, 6);
	assert.equal(unfolding.length, 6);
	assert.doesNotMatch(popup.render(100, UNFOLD_MS + 1).join("\n"), /Solo/, "rows appear only after the frame");
	assert.match(popup.render(100, OPENING_MS).join("\n"), /Subagents/);

	let screen = popup.render(50).join("\n");
	assert.match(screen, /◐ Solo/);
	assert.doesNotMatch(screen, /hello/, "narrow: the boxes first");
	popup.handleInput("\r");
	screen = popup.render(50).join("\n");
	assert.match(screen, /hello/, "enter opens the output");
	assert.match(screen, /esc back/);
});

test("the popup's tabs filter the subagents by status, by key or by a click", () => {
	const agents = [
		agent({ id: "a", description: "Still busy", startedAt: 0 }),
		agent({ id: "b", description: "All finished", status: "done", startedAt: 0, lastAt: 1_000 }),
	];
	const popup = new SubagentBrowser({ theme, load: () => agents, markdown: (text) => [text], rows: () => 20, requestRender() {}, close() {} });
	let screen = popup.render(100, undefined, 5_000).join("\n");
	assert.match(screen, /◐ Still busy[\s\S]*✓ All finished/, "all by default");
	popup.handleInput("\t");
	screen = popup.render(100, undefined, 5_000).join("\n");
	assert.match(screen, /◐ Still busy/);
	assert.doesNotMatch(screen, /All finished/, "tab: only the running ones");
	popup.handleInput("\t");
	screen = popup.render(100, undefined, 5_000).join("\n");
	assert.match(screen, /✓ All finished/);
	assert.doesNotMatch(screen, /Still busy/, "then only the done ones");
	popup.handleInput("\t");
	assert.match(popup.render(100, undefined, 5_000).join("\n"), /No subagents here\./, "none stopped");
	// A click on the first tab (" All 2 " starts right inside the frame) shows all again.
	popup.handleMouse({ type: "click", button: "left", x: 3, y: 1 } as any);
	assert.match(popup.render(100, undefined, 5_000).join("\n"), /Still busy[\s\S]*All finished/);
	popup.handleInput("\x1b[Z");
	screen = popup.render(100, undefined, 5_000).join("\n");
	assert.match(screen, /No subagents here\./, "shift+tab goes back to stopped");
});
