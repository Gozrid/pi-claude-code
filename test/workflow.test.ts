/**
 * pi-bridge: workflows, big tasks planned as a tree of parts done by subagents.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { bridgeTools, type Host, SERVER_INSTRUCTIONS } from "../extensions/pi-bridge/tools.ts";
import {
	addPart,
	afterRestart,
	buildWorkflow,
	cancelPart,
	decideFailure,
	findPart,
	nextParts,
	progressOf,
	removePart,
	restartPart,
	statusOf,
	updatePart,
	type Workflow,
	WorkflowStore,
} from "../extensions/pi-bridge/workflow.ts";
import { RETRY, type ReviewResult, SKIP, WorkflowRunner } from "../extensions/pi-bridge/workflow-runner.ts";
import { typedText, WorkflowBrowser, workflowLines, type WorkflowColors } from "../extensions/pi-bridge/workflow-view.ts";

const CAR = {
	title: "Build a car model",
	parallel: 2,
	parts: [
		{ title: "Wheels", parts: [{ title: "Screws", detail: "M6 screws" }, { title: "Rubber" }] },
		{ title: "Body", dependsOn: ["1"], parts: [{ title: "Frame" }, { title: "Doors", dependsOn: ["2.1"], model: "haiku" }] },
		{ title: "Windows", parts: ["Front", "Back"] },
	],
};

const build = (input: Record<string, unknown> = CAR) => buildWorkflow(input, { id: 1, cwd: "/p", now: 0 });
const running = (w: Workflow) => {
	w.state = "running";
	return w;
};
const ids = (result: ReturnType<typeof nextParts>) => (result.kind === "start" ? result.parts.map((p) => p.id) : result.kind);
const tempStore = () => new WorkflowStore(join(mkdtempSync(join(tmpdir(), "workflows-")), "workflows"));

test("a plan gets ids by position and keeps details, models and dependencies", () => {
	const w = build();
	assert.equal(w.state, "review");
	assert.equal(w.parallel, 2);
	assert.deepEqual(
		w.parts.map((p) => [p.id, p.parts.map((c) => c.id)]),
		[
			["1", ["1.1", "1.2"]],
			["2", ["2.1", "2.2"]],
			["3", ["3.1", "3.2"]],
		],
	);
	assert.equal(findPart(w, "1.1")?.detail, "M6 screws");
	assert.equal(findPart(w, "2.2")?.model, "haiku");
	assert.deepEqual(findPart(w, "2")?.dependsOn, ["1"]);
	assert.equal(progressOf(w).total, 6);
});

test("a plan it cannot run is refused with the reason", () => {
	assert.throws(() => build({ parts: [{ title: "A" }] }), /needs a `title`/);
	assert.throws(() => build({ title: "T", parts: [] }), /needs `parts`/);
	assert.throws(() => build({ title: "T", parts: [{ title: "A", parts: [{ title: "" }] }] }), /Part 1\.1 has no title/);
	assert.throws(() => build({ title: "T", parts: [{ title: "A", dependsOn: ["9"] }] }), /depends on 9, which does not exist/);
	assert.throws(() => build({ title: "T", parts: [{ title: "A", parts: [{ title: "B", dependsOn: ["1"] }] }] }), /above or below/);
	assert.throws(
		() => build({ title: "T", parts: [{ title: "A", dependsOn: ["2"] }, { title: "B", parts: [{ title: "C", dependsOn: ["1"] }] }] }),
		/go in a circle/,
	);
});

test("parts start when what they wait for is done, at most `parallel` at once; big parts' dependencies hold for their parts", () => {
	const w = running(build());
	// 2 waits for all of 1; 2.2 also for 2.1. Two at once.
	assert.deepEqual(ids(nextParts(w, 1)), ["1.1", "1.2"]);
	assert.equal(nextParts(w, 1).kind, "wait");
	updatePart(w, "1.1", "done", { result: "screwed", tokens: 1200 }, 2);
	assert.deepEqual(ids(nextParts(w, 3)), ["3.1"]);
	updatePart(w, "1.2", "done", { tokens: 800 }, 4);
	assert.equal(statusOf(findPart(w, "1")!), "done");
	assert.deepEqual(ids(nextParts(w, 5)), ["2.1"]);
	updatePart(w, "2.1", "done", {}, 6);
	updatePart(w, "3.1", "skipped", {}, 6);
	assert.deepEqual(ids(nextParts(w, 7)), ["2.2", "3.2"]);
	updatePart(w, "2.2", "done", {}, 8);
	updatePart(w, "3.2", "done", {}, 8);
	assert.equal(nextParts(w, 9).kind, "done");
	assert.equal(w.state, "done");
	assert.equal(progressOf(w).tokens, 2000);
	assert.throws(() => updatePart(w, "2", "done", {}, 9), /big part; report its small parts \(2\.1, 2\.2\)/);
});

test("a failed part is handed out once more, failing again it waits for the user's decision", () => {
	const w = running(build({ title: "T", parts: [{ title: "A" }, { title: "B", dependsOn: ["1"] }] }));
	nextParts(w, 0);
	assert.equal(updatePart(w, "1", "failed", { result: "boom" }, 1).outcome, "retry");
	assert.equal(findPart(w, "1")!.status, "pending");
	assert.deepEqual(ids(nextParts(w, 2)), ["1"]);
	assert.equal(updatePart(w, "1", "failed", {}, 3).outcome, "ask");
	assert.deepEqual(w.asking, ["1"]);
	assert.equal(nextParts(w, 4).kind, "asking");

	assert.match(decideFailure(w, "1", "retry", "use the other API", 5), /tried again with this hint: use the other API/);
	assert.equal(findPart(w, "1")!.note, "use the other API");
	assert.deepEqual(ids(nextParts(w, 6)), ["1"]);
	// One more failure asks again.
	assert.equal(updatePart(w, "1", "failed", {}, 7).outcome, "ask");
	decideFailure(w, "1", "skip", undefined, 8);
	assert.deepEqual(ids(nextParts(w, 9)), ["2"]);

	const p = running(build({ title: "T", parts: [{ title: "A" }] }));
	nextParts(p, 0);
	updatePart(p, "1", "failed", {}, 1);
	nextParts(p, 1);
	updatePart(p, "1", "failed", {}, 2);
	decideFailure(p, "1", "pause", undefined, 3);
	assert.equal(p.state, "paused");
	assert.equal(nextParts(p, 4).kind, "paused");
});

test("the user's edits keep ids stable and reach the agent as news; started parts are cancelled, not removed", () => {
	const w = running(build());
	nextParts(w, 0); // 1.1 and 1.2 run
	assert.throws(() => removePart(w, "1", 1), /has started; cancel it instead/);
	removePart(w, "3.1", 1);
	assert.equal(addPart(w, "3", "Roof window", 2).id, "3.3");
	assert.equal(addPart(w, undefined, "Paint", 2).id, "4");
	assert.throws(() => addPart(w, "1.1", "Nut", 2), /has already started/);
	const stopped = cancelPart(w, "1", 3);
	assert.deepEqual(
		stopped.map((p) => p.id),
		["1.1", "1.2"],
	);
	// What the agent reports for a cancelled part changes nothing.
	assert.equal(updatePart(w, "1.1", "done", {}, 4).outcome, "ignored");
	assert.equal(findPart(w, "1.1")!.status, "skipped");
	restartPart(w, "1.2", 5);
	assert.equal(findPart(w, "1.2")!.status, "pending");
	assert.deepEqual(w.news, [
		'The user removed part 3.1 "Front".',
		'The user added part 3.3 "Roof window" to 3 "Windows".',
		'The user added part 4 "Paint".',
		'The user cancelled part 1 "Wheels". Stop the subagents still working on 1.1, 1.2 and ignore their results.',
		'The user wants part 1.2 "Rubber" done again from the start.',
	]);
	// In review nothing is news: the agent gets the whole edited plan.
	const r = build();
	addPart(r, undefined, "Extra", 0);
	assert.deepEqual(r.news, []);
});

test("after a restart a running workflow is paused and the agent learns which parts were running", () => {
	const w = running(build());
	nextParts(w, 0);
	afterRestart(w, 1);
	assert.equal(w.state, "paused");
	assert.match(w.news[0], /while parts 1\.1, 1\.2 were running.*as pending/);
});

test("the runner: review approved, parts handed out, failure asked about, the agent woken when it goes on", async () => {
	const store = tempStore();
	let review: ReviewResult = { kind: "feedback", text: "split the body" };
	const asked: string[] = [];
	const woken: string[] = [];
	let answer: { selected: string[]; own?: string; extra?: { prompt: string; text: string } } = { selected: [SKIP] };
	const runner = new WorkflowRunner({
		store,
		now: () => 1000,
		review: async (w) => {
			addPart(w, "3", "Mirror", 0);
			return review;
		},
		ask: async (questions) => {
			asked.push(questions[0].question);
			return [{ question: questions[0].question, ...answer }];
		},
		wake: (_w, text) => woken.push(text),
	});

	const sentBack = await runner.plan(CAR, "/p");
	assert.match(sentBack, /wants this changed: split the body/);
	assert.match(sentBack, /3\.3 Mirror/);
	assert.deepEqual(readdirSync(store.dir), [], "a plan not approved is not kept");
	assert.equal(runner.current, undefined);

	review = { kind: "approved" };
	const approved = await runner.plan(CAR, "/p");
	assert.match(approved, /approved workflow #1 "Build a car model" \(7 small parts, up to 2 at once\)/);
	assert.match(approved, /Call workflow_next/);
	assert.equal(store.load(1)?.state, "running");

	const first = runner.next(undefined);
	assert.match(first, /Start these 2 part\(s\)/);
	assert.match(first, /1\.1 Screws\n {2}subagent description: "W1 1\.1 Screws"\n {2}within: 1 Wheels\n {2}task: M6 screws/);
	assert.match(runner.update({ id: "1.1", status: "failed" }), /handed out once more/);
	runner.next(undefined);
	assert.match(runner.update({ id: "1.1", status: "failed" }), /the user is asked/);
	await new Promise((r) => setImmediate(r));
	assert.match(asked[0], /Part 1\.1 "Screws" of workflow #1 failed 2 times/);
	assert.equal(findPart(runner.current!, "1.1")!.status, "skipped");
	assert.match(woken[0], /skipped part 1\.1/);

	// Retry with a hint goes back to pending with the hint as note.
	answer = { selected: [RETRY], extra: { prompt: "Hint", text: "use M5" } };
	runner.next(undefined);
	runner.update({ id: "1.2", status: "failed" });
	runner.next(undefined);
	runner.update({ id: "1.2", status: "failed" });
	await new Promise((r) => setImmediate(r));
	assert.equal(findPart(runner.current!, "1.2")!.note, "use M5");
	assert.equal(findPart(runner.current!, "1.2")!.status, "pending");

	// Paused: nothing new starts; continuing wakes the agent.
	runner.pause(runner.current!, true);
	assert.match(runner.next(undefined), /What the user changed since your last call:\n- The user paused the workflow\.\n\nThe user paused workflow #1/);
	runner.pause(runner.current!, false);
	assert.match(woken.at(-1)!, /continued workflow #1/);

	assert.match(runner.status({}, "/p"), /^Workflow #1 "Build a car model" · running/);
	assert.match(runner.status({ list: true }, "/p"), /^#1 Build a car model · running/);
});

test("an idle agent is woken when the user frees parts again", () => {
	const woken: string[] = [];
	const runner = new WorkflowRunner({ store: tempStore(), wake: (_w, text) => woken.push(text) });
	const w = running(build({ title: "T", parts: [{ title: "A" }] }));
	runner.current = w;
	runner.next(undefined);
	runner.update({ id: "1", status: "done" });
	assert.match(runner.next(undefined), /is finished/);
	assert.equal(runner.apply(w, (wf, now) => restartPart(wf, "1", now)), undefined);
	assert.equal(woken.length, 1);
	assert.match(woken[0], /Call workflow_next \(workflow 1\)/);
	assert.match(runner.apply(w, (wf, now) => removePart(wf, "9", now)) ?? "", /No part 9/);
});

test("a workflow left open is continued after pi starts again, paused", () => {
	const store = tempStore();
	const w = running(build());
	nextParts(w, 0);
	store.save(w);
	const runner = new WorkflowRunner({ store });
	assert.equal(runner.restore("/elsewhere"), undefined);
	const restored = runner.restore("/p");
	assert.equal(restored?.state, "paused");
	assert.equal(store.load(1)?.state, "paused");
});

/** A theme with plain ANSI codes. */
const CODES = { accent: 36, dim: 2, muted: 90, success: 32, error: 31, warning: 33, text: 39 } as const;
const colors: WorkflowColors = {
	fg: (color, text) => `\x1b[${CODES[color]}m${text}\x1b[39m`,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
	strikethrough: (text) => `\x1b[9m${text}\x1b[29m`,
};
const plain = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));

test("above the editor: the workflow's progress, its big parts and the small parts running", () => {
	const w = running(build());
	nextParts(w, 0);
	updatePart(w, "1.1", "done", { tokens: 245_100 }, 1);
	assert.deepEqual(plain(workflowLines(colors, w, 200, 0)), [
		"◆ Workflow #1 Build a car model · 1 of 6 done · 1 running · 245.1k tokens · click for the tree",
		"⠋ 1 Wheels 1/2 ── ○ 2 Body 0/2 ── ○ 3 Windows 0/2",
		"  ⠋ 1.2 Rubber",
	]);
	w.state = "paused";
	assert.match(plain(workflowLines(colors, w, 200))[0], /· paused · click for the tree$/);
	for (const line of workflowLines(colors, w, 20)) assert.ok(visibleWidth(line) <= 20, line);
});

const popupTheme = { ...colors, fg: (c: any, t: string) => colors.fg(c in CODES ? c : "text", t), bg: (_c: any, t: string) => t };

function browser(w: Workflow, extra: Partial<ConstructorParameters<typeof WorkflowBrowser>[0]> = {}) {
	const runner = new WorkflowRunner({ store: tempStore() });
	runner.current = w;
	return new WorkflowBrowser({
		theme: popupTheme,
		workflow: () => w,
		apply: (change) => runner.apply(w, change),
		markdown: (text) => [text],
		rows: () => 20,
		requestRender: () => {},
		close: () => {},
		...extra,
	});
}

test("the popup: review the plan, edit a title, add a part, choose a model and approve", () => {
	const w = build();
	let approved = false;
	const b = browser(w, { approve: () => (approved = true) });
	const screen = plain(b.render(100));
	assert.match(screen[0], /Review the plan · Workflow #1 · Build a car model/);
	assert.ok(screen.some((l) => l.includes("▾ ○ 1 Wheels 0/2")));
	assert.ok(screen.some((l) => l.includes("1.1 Screws") && l.includes("M6 screws")) || screen.some((l) => l.includes("M6 screws")));
	assert.match(screen.at(-1)!, /a approve · f feedback/);
	// 1.1 is selected first: rename it.
	b.handleInput("e");
	for (const key of ["\x7f", "\x7f", "\x7f", "\x7f", "\x7f", "\x7f", "Bolts"]) b.handleInput(key);
	b.handleInput("\r");
	assert.equal(findPart(w, "1.1")!.title, "Bolts");
	b.handleInput("n");
	b.handleInput("\x1b[200~Valve\n\x1b[201~");
	b.handleInput("\r");
	assert.equal(findPart(w, "1.3")!.title, "Valve");
	b.handleInput("m");
	assert.equal(findPart(w, "1.3")!.model, "haiku");
	b.handleInput("+");
	assert.equal(w.parallel, 3);
	b.handleInput("a");
	assert.ok(approved);
});

test("the popup while it runs: pause, cancel and restart the selected part", () => {
	const w = running(build());
	nextParts(w, 0);
	const paused: boolean[] = [];
	const b = browser(w, { pause: (p) => paused.push(p) });
	assert.match(plain(b.render(100)).at(-1)!, /p pause · c cancel · r restart/);
	b.handleInput("p");
	assert.deepEqual(paused, [true]);
	b.handleInput("c");
	assert.equal(findPart(w, "1.1")!.status, "skipped");
	b.handleInput("r");
	assert.equal(findPart(w, "1.1")!.status, "pending");
	b.handleInput("x");
	assert.equal(findPart(w, "1.1"), undefined);
	b.handleInput("x");
	assert.match(plain(b.render(100))[1], /has started; cancel it instead/);
	for (const line of b.render(60)) assert.ok(visibleWidth(line) <= 60, line);
});

test("typed text: paste markers dropped, line breaks as spaces, other keys nothing", () => {
	assert.equal(typedText("abc"), "abc");
	assert.equal(typedText("\x1b[200~a\nb\x1b[201~"), "a b");
	assert.equal(typedText("\x1b[A"), "");
});

test("the tools: plan needs a UI, next and update need a workflow, the instructions name them", async () => {
	const host: Host = { pi: {} as any, ctx: () => undefined, sessionRules: new Set(), workflows: new WorkflowRunner({ store: tempStore() }) };
	const tools = bridgeTools(host);
	const call = (name: string, args: Record<string, unknown>) => tools.find((t) => t.name === name)!.call(args, { provider: "p", kind: "claude", data: { cwd: "/p" } } as any);
	assert.match((await call("workflow_plan", CAR)).text, /without a user interface/);
	assert.match((await call("workflow_next", {})).text, /No workflow is running/);
	assert.match((await call("workflow_update", { id: "1", status: "done" })).text, /No workflow is running/);
	assert.match((await call("workflow_status", { list: true })).text, /No workflows saved/);
	assert.match(SERVER_INSTRUCTIONS, /workflow_plan/);
});
