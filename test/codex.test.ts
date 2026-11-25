import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
	cachedModels,
	login,
	defaultModel,
	instanceId,
	listModels,
	providerModel,
	saveModels,
	windows,
} from "../extensions/codex/accounts.ts";
import { CodexClient, withClient } from "../extensions/codex/client.ts";
import { answerRequest, initialMode, modeParams } from "../extensions/codex/protocol.ts";
import { streamTurn } from "../extensions/codex/stream.ts";
import { type TurnEvents, type TurnOptions } from "../extensions/codex/turn.ts";
import { CodexSubagents } from "../extensions/codex/subagents.ts";
import { brandFor } from "../extensions/shared/brand.ts";
import { logoFor } from "../extensions/provider-logo/logos.ts";
import { chooseCostume, clawdArt, clawdFrame } from "../extensions/provider-logo/clawd.ts";
import { crabFrame } from "../extensions/chat-crab/crab.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-codex-test-"));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_CODEX_SCRATCH_DIR = dir;
const bin = fileURLToPath(new URL("fake-codex.mjs", import.meta.url));
const instance = { id: "codex-cli", name: "Codex", command: `"${process.execPath}" "${bin}"` };
const model = { ...providerModel(instance, defaultModel), api: "codex-cli", provider: instance.id } as any;
const user = (content: string): Message => ({ role: "user", content, timestamp: Date.now() });

function opts(messages: Message[], log: string): TurnOptions {
	return {
		pi: { events: { emit() {} }, getAllTools: () => [] } as any,
		ctx: { cwd: dir, hasUI: false, isProjectTrusted: () => false } as any,
		instance: { ...instance, command: `PI_FAKE_CODEX_LOG="${log}" ${instance.command}` },
		model: "gpt-fake",
		effort: "high",
		session: "pi-1",
		mode: "workspace-write",
		reset: 0,
		context: { messages },
	};
}

const clientFor = (o: TurnOptions) => new CodexClient(o.instance.command, o.ctx.cwd);
const logOf = (file: string) =>
	readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));

test("Codex lists account models, native efforts, cache and usage windows", async () => {
	const models = await withClient(instance.command, dir, listModels);
	assert.equal(models[0].id, "gpt-fake");
	assert.equal(models.at(-1)?.name, "CLI default → Fake");
	const m = providerModel(instance, models[0]);
	assert.deepEqual(m.input, ["text", "image"]);
	assert.equal(m.thinkingLevelMap?.high, "high");
	assert.equal(m.thinkingLevelMap?.max, null);
	saveModels(instance, models);
	assert.deepEqual(cachedModels(instance), models);
	assert.deepEqual(cachedModels({ ...instance, command: "another account" }), []);
	assert.equal(instanceId("Work", [{ ...instance, id: "codex-cli-work" }]), "codex-cli-work-2");
	assert.deepEqual(windows({ primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1000 } }), [
		{ id: "primary", label: "5h", percent: 12, resetsAt: 1_000_000 },
	]);
});

test("a Codex turn streams reasoning, a read, approval, image input and text; the next turn resumes only new input", async () => {
	const log = join(dir, "rounds");
	const first = user("inspect");
	first.content = [
		{ type: "text", text: "inspect" },
		{ type: "image", mimeType: "image/png", data: "cGlw" },
	];
	const o = opts([first], log);
	const tasks: unknown[] = [],
		tools: unknown[] = [];
	const stream = streamTurn(model, o, clientFor(o), { tasks: (t) => tasks.push(t), tool: (t) => tools.push(t) });
	const events = [];
	for await (const event of stream) events.push(event.type);
	const result = await stream.result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.equal(events[0], "start");
	assert.equal(events.at(-1), "done");
	assert.ok(events.includes("thinking_end"));
	assert.deepEqual(tasks[0], [{ id: "1", subject: "Read the file", status: "in_progress" }]);
	assert.deepEqual(tools, [
		{ type: "start", name: "Read", detail: "README.md" },
		{ type: "end", isError: false },
	]);
	assert.deepEqual(result.content.at(-1), { type: "text", text: "Pip ready" });
	assert.equal(result.usage.input, 60);
	assert.equal(result.usage.cacheRead, 20);
	assert.equal(result.usage.totalTokens, 88);
	const messages = [first, result, user("next")];
	const second = opts(messages, log);
	const next = await streamTurn(model, second, clientFor(second), {}).result();
	assert.equal(next.stopReason, "stop", next.errorMessage);
	const entries = logOf(log);
	assert.equal(entries.filter((entry) => entry.method === "thread/start").length, 1);
	assert.ok(entries.some((entry) => entry.method === "thread/resume" && entry.params.threadId === "thread-a"));
	assert.ok(entries.some((entry) => entry.result?.decision === "decline"));
	const turns = entries.filter((entry) => entry.method === "turn/start");
	assert.equal(turns[0].params.input[1].url, "data:image/png;base64,cGlw");
	assert.equal(turns[1].params.input.length, 1);
	assert.equal(turns[1].params.input[0].text, "next");
	assert.ok(entries.find((entry) => entry.method === "thread/start").params.config.mcp_servers.native.enabled === false);
});

test("forks, provider switches and /codex-new replay multiline history on a fresh thread", async () => {
	const log = join(dir, "fork");
	const start = opts([user("first")], log);
	const answer: AssistantMessage = await streamTurn(model, start, clientFor(start), {}).result();
	answer.content = [{ type: "text", text: "one\ntwo" }];
	for (const change of ["fork", "provider", "new", "old tip"]) {
		const o = opts([user("first"), { ...answer }, user("next")], log);
		const previous = o.context.messages[1] as AssistantMessage;
		if (change === "fork") o.session = "forked-pi-session";
		if (change === "provider") previous.provider = "another-provider";
		if (change === "new") o.reset = answer.timestamp + 1;
		if (change === "old tip") previous.responseId = answer.responseId!.replace("turn-1", "older-turn");
		const result = await streamTurn(model, o, clientFor(o), {}).result();
		assert.equal(result.stopReason, "stop", change);
		const sent = logOf(log)
			.filter((e) => e.method === "turn/start")
			.at(-1);
		assert.ok(sent.params.input[0].text.includes("one\ntwo"), change);
	}
	assert.equal(logOf(log).filter((e) => e.method === "thread/start").length, 5);
	assert.ok(!logOf(log).some((entry) => entry.method === "thread/resume"));
});

test("Codex steer keeps its turn, Escape interrupts it and a crashed CLI ends the stream", async () => {
	const log = join(dir, "interrupt");
	const controller = new AbortController();
	const o = { ...opts([user("wait")], log), signal: controller.signal };
	let ready!: (fn: Parameters<NonNullable<TurnEvents["ready"]>>[0]) => void;
	const active = new Promise<Parameters<NonNullable<TurnEvents["ready"]>>[0]>((r) => {
		ready = r;
	});
	const stream = streamTurn(model, o, clientFor(o), { ready });
	await (
		await active
	)("one more thing");
	controller.abort();
	assert.equal((await stream.result()).stopReason, "aborted");
	const entries = logOf(log);
	assert.equal(entries.find((e) => e.method === "turn/steer").params.expectedTurnId, "turn-1");
	assert.ok(entries.some((e) => e.method === "turn/interrupt"));
	const crash = opts([user("crash")], log);
	const error = await streamTurn(model, crash, clientFor(crash), {}).result();
	assert.equal(error.stopReason, "error");
	assert.match(error.errorMessage!, /exited \(9\)/);
});

test("Codex approvals follow the decision offered, and native questions return the selected label", async () => {
	const ctx = {
		hasUI: true,
		ui: { confirm: async () => true, select: async (_title: string, options: string[]) => options[0] },
	} as any;
	const signal = new AbortController().signal;
	assert.deepEqual(
		await answerRequest(ctx, "item/permissions/requestApproval", { permissions: { network: { enabled: true } } }, signal),
		{ permissions: { network: { enabled: true } }, scope: "turn" },
	);
	assert.deepEqual(
		await answerRequest(
			ctx,
			"item/commandExecution/requestApproval",
			{ command: "pwd", availableDecisions: ["decline"] },
			signal,
		),
		{ decision: "decline" },
	);
	assert.deepEqual(
		await answerRequest(
			ctx,
			"item/tool/requestUserInput",
			{ questions: [{ id: "q", question: "Which?", options: [{ label: "A", description: "First" }] }] },
			signal,
		),
		{ answers: { q: { answers: ["A"] } } },
	);
	assert.deepEqual(modeParams("default"), {});
	assert.deepEqual(modeParams("auto"), {
		sandbox: "workspace-write",
		approvalPolicy: "on-request",
		approvalsReviewer: "auto_review",
	});
	assert.equal(modeParams("plan").sandbox, "read-only");
	assert.equal(modeParams("workspace-write").approvalsReviewer, "user");
});

test("pi-auto approves simple branch switches and sends other requests to the normal dialog", async () => {
	const cwd = realpathSync(mkdtempSync(join(dir, "checkout-")));
	execFileSync("git", ["init", "--quiet", "--template="], { cwd });
	let prompts = 0;
	const ctx = {
		cwd,
		isProjectTrusted: () => true,
		hasUI: true,
		ui: {
			confirm: async () => {
				prompts++;
				return false;
			},
		},
	} as any;
	const signal = new AbortController().signal;
	const method = "item/commandExecution/requestApproval";
	const request = { cwd, command: "/bin/zsh -lc 'git switch feature/sample'", availableDecisions: ["accept", "decline"] };
	const approve = (overrides = {}, mode = "pi-auto") =>
		answerRequest(ctx, method, { ...request, ...overrides }, signal, undefined, mode);

	assert.equal(initialMode(undefined), "pi-auto");
	assert.equal(initialMode("auto"), "auto");
	assert.equal(initialMode("default"), "default");
	assert.deepEqual(modeParams("pi-auto"), modeParams("workspace-write"));
	assert.deepEqual(await approve(), { decision: "accept" });
	assert.deepEqual(await approve({ command: "git switch -c feat/example main" }), { decision: "accept" });
	assert.deepEqual(await approve({ availableDecisions: ["decline"] }), { decision: "decline" });
	assert.equal(prompts, 0);

	for (const overrides of [
		{ command: "git switch --discard-changes main" },
		{ command: "git switch main; whoami" },
		{ command: "git switch main\nwhoami" },
		{ command: "git switch $BRANCH" },
		{ command: "git -C other switch main" },
		{ cwd: dir },
		{ kind: "stdin" },
		{ kind: { requiredHumanApproval: {} } },
		{ additionalPermissions: { fileSystem: { write: [dir] } } },
		{ networkApprovalContext: {} },
		{ environmentId: "remote" },
	]) {
		const before: number = prompts;
		assert.deepEqual(await approve(overrides), { decision: "decline" });
		assert.equal(prompts, before + 1);
	}

	assert.deepEqual(await approve({}, "workspace-write"), { decision: "decline" });
	ctx.isProjectTrusted = () => false;
	assert.deepEqual(await approve(), { decision: "decline" });
	ctx.isProjectTrusted = () => true;
	execFileSync("git", ["config", "core.hooksPath", "hooks"], { cwd });
	assert.deepEqual(await approve(), { decision: "decline" });
	execFileSync("git", ["config", "--unset", "core.hooksPath"], { cwd });
	mkdirSync(join(cwd, ".git", "hooks"));
	writeFileSync(join(cwd, ".git", "hooks", "post-checkout"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	assert.deepEqual(await approve(), { decision: "decline" });
});

test("pi-auto skips the extra retry prompt for an already approved branch switch", async () => {
	const cwd = realpathSync(mkdtempSync(join(dir, "retry-")));
	execFileSync("git", ["init", "--quiet", "--template="], { cwd });
	const log = join(dir, "checkout");
	const o = { ...opts([user("retry checkout")], log), mode: "pi-auto" };
	o.ctx = { ...o.ctx, cwd, isProjectTrusted: () => true };
	const denials: string[] = [];
	const result = await streamTurn(model, o, clientFor(o), {
		denied: (_tool, detail) => denials.push(detail),
	}).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.ok(logOf(log).some((entry) => entry.result?.decision === "accept"));
	assert.deepEqual(denials, []);
});

test("child thread output stays on its agent and unrelated sessions are ignored", () => {
	const seen: any[] = [];
	const agents = new CodexSubagents((a) => seen.push(structuredClone(a)));
	const receive = (method: string, p: Record<string, unknown>) => agents.receive("main", method, p);
	receive("thread/started", { thread: { parentThreadId: "main", id: "child", preview: "Review" } });
	receive("item/completed", { threadId: "other", item: { type: "agentMessage", text: "unrelated" } });
	receive("item/completed", { threadId: "child", item: { type: "agentMessage", text: "Looks good" } });
	receive("turn/completed", { threadId: "child", turn: { status: "completed" } });
	assert.deepEqual(seen.at(-1).steps, [{ kind: "text", text: "Looks good" }]);
	assert.equal(seen.at(-1).status, "done");
});

test("Pip has its own art, costumes, workspace scenes and buddy only on Codex CLI accounts", () => {
	assert.equal(brandFor({ provider: "codex-cli-work", id: "gpt-fake" }).mascot, "pip");
	assert.equal(brandFor({ provider: "openai-codex", id: "gpt-fake" }).mascot, undefined);
	assert.equal(logoFor("codex-cli-work", "gpt-fake", "Work").name, "Codex CLI");
	chooseCostume("none");
	try {
		assert.notDeepEqual(clawdArt("pip"), clawdArt());
		assert.notDeepEqual(clawdFrame(0, "pip"), clawdFrame(700, "pip"));
		for (const mood of ["sleep", "thinking", "terminal", "reading", "typing", "cheer"] as const) {
			const pip = crabFrame(mood, 200, { direction: 1, mascot: "pip" });
			assert.equal(pip.art.length, 6);
			assert.ok(pip.art.every((row) => row.length === 10));
			assert.notDeepEqual(pip.art, crabFrame(mood, 200, { direction: 1 }).art);
		}
		assert.ok(crabFrame("delegating", 0, { direction: 1, mascot: "pip" }).buddy);
		const plain = clawdArt("pip");
		chooseCostume("christmas");
		assert.notDeepEqual(clawdArt("pip"), plain);
	} finally {
		chooseCostume(undefined);
	}
});

test("browser sign-in presents the CLI's URL and waits for completion", async () => {
	process.env.PI_CODEX_NO_BROWSER = "1";
	let shown = "";
	await login(instance, dir, (url) => {
		shown = url;
	});
	assert.equal(shown, "https://example.test/codex");
});

test("an interactive session reuses one initialized app-server, then shuts it down", async () => {
	const log = join(dir, "interactive");
	const o = opts([user("first")], log);
	const client = clientFor(o);
	let parked = 0;
	o.park = (idle) => {
		assert.equal(idle, client);
		parked++;
	};
	try {
		const first = await streamTurn(model, o, client, {}).result();
		assert.equal(first.stopReason, "stop");
		assert.equal(client.signal.aborted, false);
		o.context.messages.push(first, user("second"));
		const second = await streamTurn(model, o, client, {}).result();
		assert.equal(second.stopReason, "stop");
		assert.equal(parked, 2);
		assert.equal(logOf(log).filter((line) => line.method === "initialize").length, 1);
	} finally {
		client.close();
	}
	assert.equal(client.signal.aborted, true);
});
