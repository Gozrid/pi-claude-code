import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { usageWindows as agyWindows, parseUsage } from "../extensions/antigravity/usage.ts";
import { usageWindows as claudeWindows, usageFromGetUsage } from "../extensions/claude-code/usage.ts";
import type { UsageAccount } from "../extensions/shared/agent-bus.ts";
import { darkenBackdrop, shadeLine } from "../extensions/shared/backdrop.ts";
import { chart, easeOut, plot, sequential, stackedBars, valueAt } from "../extensions/usage-graph/chart.ts";
import { History, KEEP_MS, newSamples, parseHistory, RECORD_EVERY_MS, type Sample } from "../extensions/usage-graph/history.ts";
import { accountViews, animationMs, frame, headTabAt, renderAccount, renderModels, tabSpans } from "../extensions/usage-graph/index.ts";
import { Glide, OPENING_MS, openingTitle, RESIZE_MS, shownRows, TITLE_MS, UNFOLD_MS, unfoldedSize } from "../extensions/shared/opening.ts";
import { bucketStart, ModelLog, modelViews, parseModelLog, sampleFromMessage, type TokenSample, totalTokens } from "../extensions/usage-graph/models.ts";

const theme = {
	fg: (_c: string, t: string) => t,
	bold: (t: string) => t,
} as any;

const account = (percent: number, resetsAt?: number): UsageAccount => ({
	id: "claude-work",
	name: "Claude · Work",
	windows: [{ id: "session", label: "5h session", percent, ...(resetsAt !== undefined && { resetsAt }) }],
});

test("claude: session, weekly and per-model limits become chart windows", () => {
	const usage = usageFromGetUsage({
		rate_limits_available: true,
		rate_limits: {
			five_hour: { utilization: 40, resets_at: "2026-11-02T15:00:00Z" },
			seven_day: { utilization: 20 },
			limits: [
				{ kind: "seven_day", percent: 20 },
				{ kind: "seven_day", group: "weekly", percent: 55, scope: { model: { display_name: "Opus" } } },
			],
		},
	});
	assert.deepEqual(
		claudeWindows(usage).map((w) => [w.id, w.label, w.percent]),
		[
			["session", "5h session", 40],
			["weekly", "weekly", 20],
			["weekly:Opus", "weekly (Opus)", 55],
		],
	);
	assert.equal(claudeWindows(usage)[0].resetsAt, Date.parse("2026-11-02T15:00:00Z"));
	assert.deepEqual(claudeWindows(undefined), []);
});

test("antigravity: every bucket of every group becomes a chart window", () => {
	const usage = parseUsage(
		JSON.stringify({
			groups: [
				{
					name: "Gemini Models",
					buckets: [
						{ id: "gemini-5h", window: "5h", remaining_fraction: 0.75 },
						{ id: "gemini-weekly", window: "weekly", remaining_fraction: 0.5, reset_time: "2026-11-05T00:00:00Z" },
					],
				},
			],
		}),
	);
	assert.deepEqual(
		agyWindows(usage).map((w) => [w.id, w.label, w.percent]),
		[
			["gemini-5h", "Gemini Models · 5h", 25],
			["gemini-weekly", "Gemini Models · weekly", 50],
		],
	);
});

test("a sample is recorded on change, else at most every half hour", () => {
	const first = newSamples([account(10)], new Map(), 1000);
	assert.equal(first.length, 1);
	const last = new Map([["claude-work\u0000session", first[0]]]);
	assert.equal(newSamples([account(10)], last, 2000).length, 0);
	assert.equal(newSamples([account(10.04)], last, 2000).length, 0);
	assert.equal(newSamples([account(12)], last, 2000).length, 1);
	assert.equal(newSamples([account(10, 5000)], last, 2000).length, 1);
	assert.equal(newSamples([account(10)], last, 1000 + RECORD_EVERY_MS).length, 1);
});

test("history appends to its file, skips broken lines and drops old samples on load", () => {
	const dir = mkdtempSync(join(tmpdir(), "usage-graph-"));
	const file = join(dir, "history.jsonl");
	const now = Date.now();
	const old: Sample = { t: now - KEEP_MS - 1, a: "x", n: "X", w: "s", l: "s", p: 1 };
	writeFileSync(file, `${JSON.stringify(old)}\n{"t": broken\n`);

	const history = new History(file);
	history.load(now);
	assert.equal(history.samples.length, 0);
	assert.equal(readFileSync(file, "utf8"), "");

	history.record([account(30)], now);
	history.record([account(30)], now + 1);
	history.record([account(35)], now + 2);
	const again = new History(file);
	again.load(now + 3);
	assert.deepEqual(
		again.samples.map((s) => s.p),
		[30, 35],
	);
	assert.equal(parseHistory(readFileSync(file, "utf8")).length, 2);
});

test("a value holds until the next sample and drops to 0 after its reset", () => {
	const points = [
		{ t: 100, p: 20, r: 500 },
		{ t: 200, p: 60, r: 500 },
	];
	assert.equal(valueAt(points, 50), undefined);
	assert.equal(valueAt(points, 150), 20);
	assert.equal(valueAt(points, 300), 60);
	assert.equal(valueAt(points, 600), 0);
});

test("the plot draws braille dots: low values at the bottom, high ones at the top", () => {
	const low = plot([{ points: [{ t: 0, p: 0 }], color: String }], 0, 100, 4, 2);
	assert.equal(low[0], "    ");
	assert.equal(low[1], "⣀⣀⣀⣀");
	const high = plot([{ points: [{ t: 0, p: 100 }], color: String }], 0, 100, 4, 2);
	assert.equal(high[0], "⠉⠉⠉⠉");
	// Nothing before the first sample.
	const late = plot([{ points: [{ t: 50, p: 0 }], color: String }], 0, 100, 4, 1);
	assert.equal(late[0], "  ⣀⣀");
});

test("the chart has a percent axis and a time axis ending in now", () => {
	const lines = chart([{ points: [{ t: 0, p: 50 }], color: String }], { from: 0, to: 24 * 3600_000, width: 40, height: 5, dim: String });
	assert.equal(lines.length, 7);
	assert.match(lines[0], /^ 100%┤/);
	assert.match(lines[2], /^  50%┤/);
	assert.match(lines[4], /^   0%┤/);
	assert.match(lines[5], /^ {5}└─+$/);
	assert.match(lines[6], /-24h.*-12h.*now$/);
});

test("accounts are grouped from the samples and drawn with a legend per window", () => {
	const now = 10 * 3600_000;
	const samples: Sample[] = [
		{ t: now - 3600_000, a: "b", n: "Claude · Work", w: "session", l: "5h session", p: 20, r: now + 3600_000 },
		{ t: now - 3600_000, a: "a", n: "Antigravity · Home", w: "g", l: "Gemini · 5h", p: 95 },
		{ t: now - 60_000, a: "b", n: "Claude · Work", w: "session", l: "5h session", p: 42, r: now + 3600_000 },
	];
	const views = accountViews(samples);
	assert.deepEqual(
		views.map((v) => v.name),
		["Antigravity · Home", "Claude · Work"],
	);
	assert.equal(views[1].windows[0].points.length, 2);
	const lines = renderAccount(theme, views[1], 60, now - 5 * 3600_000, now);
	assert.match(lines[0], /^Claude · Work · read 1m ago$/);
	assert.match(lines[lines.length - 1], /━━ 5h session +▓{4}░{6} +42\.0% · reset in 1hr 0m$/);
});

test("the backdrop draws a line in one shade without its colours, images stay", () => {
	assert.equal(shadeLine("\x1b[1m\x1b[38;5;2mok\x1b[0m done", "<S>"), "<S>ok done\x1b[0m");
	assert.equal(shadeLine("", "<S>"), "");
	const image = "\x1b_Ga=T;data\x1b\\";
	assert.equal(shadeLine(image, "<S>"), image);
});

class FakeTui {
	renders = 0;
	requestRender() {
		this.renders++;
	}
	compositeOverlays(lines: string[], _w: number, _h: number) {
		return [...lines, "overlay"];
	}
}

/** Like pi's createInteractiveTuiReference: every read of a method gives a new function. */
function piProxy(tui: object): any {
	return new Proxy(
		{},
		{
			get: (_t, p) => {
				const v = Reflect.get(tui, p, tui);
				return typeof v === "function" ? (...args: unknown[]) => Reflect.apply(v, tui, args) : v;
			},
			set: (_t, p, v) => Reflect.set(tui, p, v, tui),
			getPrototypeOf: () => Reflect.getPrototypeOf(tui),
		},
	);
}

const backdropTheme = { appearance: "dark", colors: { dim: { kind: "rgb", r: 100, g: 100, b: 100 } }, getColorMode: () => "truecolor" } as any;

test("the backdrop darkens only the visible lines while open", () => {
	const tui = new FakeTui();
	const restore = darkenBackdrop(tui as any, backdropTheme);
	const out = tui.compositeOverlays(["scrollback", "\x1b[31mred\x1b[0m", "plain"], 80, 2);
	assert.equal(out[0], "scrollback");
	assert.match(out[1], /^\x1b\[38;2;45;45;45mred\x1b\[0m$/);
	assert.match(out[2], /^\x1b\[38;2;45;45;45mplain\x1b\[0m$/);
	assert.equal(out[3], "overlay");
	restore();
	restore();
	assert.deepEqual(tui.compositeOverlays(["\x1b[31mred"], 80, 2), ["\x1b[31mred", "overlay"]);
	assert.equal(tui.renders, 2);
});

test("through pi's renderer proxy the screen gets bright again on close, also after a stale wrapper", () => {
	const tui = new FakeTui();
	// A wrapper left behind by an earlier version that darkens for good.
	(tui as any).compositeOverlays = (lines: string[]) => lines.map(() => "stale");
	const proxy = piProxy(tui);
	const restore = darkenBackdrop(proxy, backdropTheme);
	assert.match(tui.compositeOverlays(["red"], 80, 5)[0], /^\x1b\[38;2;45;45;45mred/);
	restore();
	assert.deepEqual(tui.compositeOverlays(["red"], 80, 5), ["red", "overlay"]);
	// Opening again uses the installed wrapper.
	const again = darkenBackdrop(proxy, backdropTheme);
	assert.match(tui.compositeOverlays(["red"], 80, 5)[0], /^\x1b\[38;2;45;45;45mred/);
	again();
	assert.deepEqual(tui.compositeOverlays(["red"], 80, 5), ["red", "overlay"]);
});

test("the dialog has a rounded frame with the title on top and the keys below", () => {
	const lines = frame(theme, 20, "Plan usage", "esc close", ["a".padEnd(16), "b".padEnd(16)]);
	assert.deepEqual(lines, [
		"╭─ Plan usage ─────╮",
		"│ a                │",
		"│ b                │",
		"╰─ esc close ──────╯",
	]);
	assert.equal(visibleWidth(frame(theme, 12, "a very long title", "", [])[0]), 12);
});

test("an answer becomes a token sample of its model; answers without tokens are skipped", () => {
	const message = {
		role: "assistant",
		provider: "claude-work",
		model: "claude-opus-5-5",
		usage: { input: 10, output: 200, cacheRead: 5000, cacheWrite: 300, totalTokens: 5510, cost: { total: 0.12 } },
	};
	assert.deepEqual(sampleFromMessage(message, "Opus 5.5", 1000), {
		t: 1000,
		p: "claude-work",
		m: "claude-opus-5-5",
		n: "Opus 5.5",
		i: 10,
		o: 200,
		cr: 5000,
		cw: 300,
		c: 0.12,
	});
	assert.equal(sampleFromMessage({ ...message, usage: {} }, undefined, 1000), undefined);
	assert.equal(sampleFromMessage({ role: "user" }, undefined, 1000), undefined);
	assert.equal(sampleFromMessage(message, undefined, 1000)?.n, "claude-opus-5-5");
});

test("the token log appends, survives broken lines and drops old samples", () => {
	const file = join(mkdtempSync(join(tmpdir(), "usage-models-")), "models.jsonl");
	const now = Date.now();
	writeFileSync(file, `${JSON.stringify({ t: now - KEEP_MS - 1, p: "x", m: "old", n: "Old", i: 1, o: 1, cr: 0, cw: 0 })}\n{broken\n`);
	const log = new ModelLog(file);
	log.load(now);
	assert.equal(log.samples.length, 0);
	log.record({ t: now, p: "x", m: "a", n: "A", i: 1, o: 2, cr: 3, cw: 4 });
	const again = new ModelLog(file);
	again.load(now);
	assert.deepEqual(
		again.samples.map((s) => [s.m, totalTokens(s)]),
		[["a", 10]],
	);
	assert.equal(parseModelLog(readFileSync(file, "utf8")).length, 1);
});

test("tokens are summed per model and time slot, the busiest model first", () => {
	const hour = 3600_000;
	const from = bucketStart(Date.UTC(2026, 10, 2, 0), hour);
	const now = from + 3 * hour - 1;
	const sample = (t: number, m: string, o: number): TokenSample => ({ t, p: "x", m, n: m.toUpperCase(), i: 0, o, cr: 0, cw: 0 });
	const views = modelViews(
		[sample(from + 10, "a", 5), sample(from + 20, "b", 100), sample(from + 2 * hour + 5, "a", 7), sample(from - 1, "a", 999)],
		from,
		now,
		hour,
	);
	assert.deepEqual(
		views.map((v) => [v.name, v.buckets.map((b) => b.tokens)]),
		[
			["B", [100, 0, 0]],
			["A", [5, 0, 7]],
		],
	);
	assert.equal(views[1].buckets[2].t, from + 2 * hour);
});

test("the Models view draws a stacked bar per time slot with a token axis and a legend", () => {
	const hour = 3600_000;
	const now = bucketStart(Date.now(), hour) + hour - 1;
	const from = now - 5 * hour;
	const views = modelViews(
		[
			{ t: now - 2 * hour, p: "x", m: "opus", n: "Opus 5.5", i: 1000, o: 2000, cr: 10000, cw: 0, c: 1.5 },
			{ t: now - hour, p: "y", m: "gemini", n: "Gemini 3.8 Flash", i: 100, o: 400, cr: 0, cw: 0 },
			{ t: now - hour, p: "x", m: "opus", n: "Opus 5.5", i: 500, o: 500, cr: 0, cw: 0 },
		],
		from,
		now,
		hour,
	);
	// Each model marks its cells with its own letter, so the stacking shows.
	const tagged = { ...theme, fg: (c: string, t: string) => (c === "accent" ? t.replace(/█/g, "O") : c === "success" ? t.replace(/█/g, "G") : t) };
	const lines = renderModels(tagged, views, (id) => (id === "opus" ? 0 : 1), 70, from, now, "hour");
	assert.match(lines[0], /^Tokens per model · input and output per hour, without cache reads$/);
	// The scale is the tallest stack: 3.0k (Opus alone) vs 1.0k + 500 in the next hour.
	assert.match(lines[1], /^ 3\.0k┤/);
	const plotRows = lines.slice(1, 8).map((l) => l.replace(/^.*?[┤│]/, ""));
	assert.ok(plotRows.some((r) => r.includes("O")), "Opus has a bar");
	assert.ok(plotRows.slice(0, 3).every((r) => !r.includes("G")), "Gemini's stack is lower than Opus' tallest bar");
	const geminiRow = plotRows.findIndex((r) => r.includes("G"));
	const col = plotRows[geminiRow].indexOf("G");
	assert.equal(plotRows[6][col], "O", "Gemini stands on top of Opus' segment in the same hour");
	assert.ok(plotRows.some((r) => r.includes("G")), "Gemini has a segment");
	assert.match(lines.at(-2)!, /OO Opus 5\.5 +4\.0k · in 1\.5k · out 2\.5k · cache read 10\.0k · \$1\.50$/);
	assert.match(lines.at(-1)!, /GG Gemini 3\.8 Flash +500 · in 100 · out 400$/);
	assert.deepEqual(renderModels(theme, [], () => 0, 70, from, now, "hour"), ["No answers recorded in this range yet."]);
});

test("stacked bars: segments from the bottom in their colours, eighths at the top, merged when too many", () => {
	const a = (t: string) => t.replace(/./g, (ch) => (ch === "█" ? "A" : ch));
	const b = (t: string) => t.replace(/./g, (ch) => (ch === "█" ? "B" : ch));
	// One bar of 8 + 8 in a 2-row area of 16: A fills the bottom row, B the top one.
	assert.deepEqual(stackedBars([[8, 8]], [a, b], 16, 1, 2), ["B", "A"]);
	// Half a cell: ▄; empty slots stay blank; the bars stand at their places in time (columns 0, 2, 4).
	assert.deepEqual(stackedBars([[4, 0], [0, 0], [8, 0]], [a, b], 8, 6, 1), ["▄   A "]);
	// A tiny value still shows as the lowest eighth.
	assert.deepEqual(stackedBars([[1, 0]], [a, b], 1000, 1, 1), ["▁"]);
	// Six bars into three columns: pairs are merged.
	assert.deepEqual(stackedBars([[1, 0], [1, 0], [0, 0], [0, 0], [2, 0], [0, 0]], [a, b], 2, 3, 1), ["A A"]);
});

test("the build-up animation: lines and bars one after another, values counting up with their line", () => {
	assert.equal(easeOut(0), 0);
	assert.equal(easeOut(1), 1);
	assert.ok(easeOut(0.5) > 0.5, "each part fast at first");

	// Four parts: at 0.5 the first two are done, the third not started.
	assert.equal(sequential(0.5, 0, 4), 1);
	assert.equal(sequential(0.5, 1, 4), 1);
	assert.equal(sequential(0.5, 2, 4), 0);
	assert.equal(sequential(0.625, 2, 4), 0.5);
	assert.equal(sequential(1, 3, 4), 1);

	// Two lines: the first is drawn completely before the second starts.
	const low = { points: [{ t: 0, p: 0 }], color: String };
	const high = { points: [{ t: 0, p: 100 }], color: String };
	assert.deepEqual(plot([low, high], 0, 100, 4, 2, 100, 0.25), ["    ", "⣀⣀  "]);
	assert.deepEqual(plot([low, high], 0, 100, 4, 2, 100, 0.5), ["    ", "⣀⣀⣀⣀"]);
	assert.deepEqual(plot([low, high], 0, 100, 4, 2, 100, 0.75), ["⠉⠉  ", "⣀⣀⣀⣀"]);

	// Two bars: the left one grows completely, then the right one.
	const a = (t: string) => t;
	assert.deepEqual(stackedBars([[8], [8]], [a], 8, 2, 1, 0), ["  "]);
	assert.deepEqual(stackedBars([[8], [8]], [a], 8, 2, 1, 0.5), ["█ "]);
	assert.deepEqual(stackedBars([[8], [8]], [a], 8, 2, 1, 1), ["██"]);

	// Each legend value counts up while its own line is drawn.
	const now = 10 * 3600_000;
	const view = accountViews([
		{ t: now - 60_000, a: "b", n: "Claude · Work", w: "session", l: "5h session", p: 40 },
		{ t: now - 60_000, a: "b", n: "Claude · Work", w: "weekly", l: "weekly", p: 60 },
	])[0];
	const legend = (progress?: number) => renderAccount(theme, view, 60, now - 5 * 3600_000, now, progress).slice(-2).map((l) => l.match(/([\d.]+)%/)?.[1]);
	assert.deepEqual(legend(0), ["0.0", "0.0"]);
	assert.deepEqual(legend(0.25), ["20.0", "0.0"]);
	assert.deepEqual(legend(0.75), ["40.0", "30.0"]);
	assert.deepEqual(legend(), ["40.0", "60.0"]);

	// The whole build-up takes longer with more parts, within bounds.
	assert.equal(animationMs(1, 500), 700);
	assert.equal(animationMs(4, 500), 2000);
	assert.equal(animationMs(100, 70), 3000);
});

test("opening the dialog: the frame unfolds, the title is typed and lit, the rows appear from the top", () => {
	assert.deepEqual(unfoldedSize(0, 100, 30), { width: 12, rows: 2 });
	const mid = unfoldedSize(UNFOLD_MS / 2, 100, 30);
	assert.ok(mid.width > 12 && mid.width < 100 && mid.rows > 2 && mid.rows < 30);
	assert.deepEqual(unfoldedSize(UNFOLD_MS, 100, 30), { width: 100, rows: 30 });

	assert.equal(shownRows(UNFOLD_MS - 1, 10), 0, "nothing inside while unfolding");
	assert.ok(shownRows(UNFOLD_MS + TITLE_MS * 0.2, 10) > 0);
	assert.equal(shownRows(OPENING_MS, 10), 10);

	const marked = { fg: (_c: string, t: string) => t, bold: (t: string) => t, inverse: (t: string) => `[${t}]` } as any;
	const at = (t: number) => openingTitle(marked, "Usage", UNFOLD_MS + t);
	assert.equal(openingTitle(marked, "Usage", 0), "     ", "blank while unfolding, as wide as the title");
	assert.equal(at(0), "[U]    ");
	assert.match(at(TITLE_MS * 0.3), /^Us?a?\[.\] *$/, "typed so far, then the block cursor");
	assert.equal(at(TITLE_MS * 0.6).replace(/[[\]]/g, ""), "Usage", "the whole title during the shine");
	assert.equal(at(TITLE_MS), "Usage");
});

test("the backdrop fades in", async () => {
	class Tui {
		requestRender() {}
		compositeOverlays(lines: string[], _w: number, _h: number) {
			return lines;
		}
	}
	const tui = new Tui();
	const restore = darkenBackdrop(tui as any, backdropTheme, 60);
	const first = tui.compositeOverlays(["x"], 80, 5)[0];
	await new Promise((r) => setTimeout(r, 80));
	const later = tui.compositeOverlays(["x"], 80, 5)[0];
	assert.match(first, /^\x1b\[38;2;(\d+);/);
	assert.ok(Number(first.match(/38;2;(\d+)/)![1]) > Number(later.match(/38;2;(\d+)/)![1]), "darker once faded in");
	assert.match(later, /^\x1b\[38;2;45;45;45m/);
	restore();
});

test("a backdrop wrapper left behind by an older version is replaced, no code ends up on screen", () => {
	const tui = new FakeTui();
	// What the previous version installed: its entries carried the shade as a string.
	const oldState = { open: [] as any[] };
	(tui as any)[Symbol.for("pi-claude-code.usage-graph.backdrop")] = oldState;
	(tui as any).compositeOverlays = function (lines: string[], w: number, h: number) {
		const top = oldState.open[oldState.open.length - 1];
		return FakeTui.prototype.compositeOverlays.call(this, top ? lines.map((l) => `${top.shade}${l}`) : lines, w, h);
	};
	const restore = darkenBackdrop(piProxy(tui), backdropTheme);
	const out = tui.compositeOverlays(["chat line"], 80, 5);
	assert.match(out[0], /^\x1b\[38;2;45;45;45mchat line\x1b\[0m$/);
	assert.ok(!out.join("").includes("=>"), "no function source on screen");
	restore();
	assert.deepEqual(tui.compositeOverlays(["chat line"], 80, 5), ["chat line", "overlay"]);
});

test("the open dialog glides to a new size instead of jumping", () => {
	const glide = new Glide();
	assert.equal(glide.at(30, 1000), 30, "the first size is taken as it is");
	assert.equal(glide.moving(1000), false);

	// Taller content: from 30 towards 40, fast at first.
	assert.equal(glide.at(40, 2000), 30);
	const early = glide.at(40, 2000 + RESIZE_MS / 4);
	assert.ok(early > 30 && early < 40);
	assert.equal(glide.moving(2000 + RESIZE_MS / 4), true);
	assert.equal(glide.at(40, 2000 + RESIZE_MS), 40);
	assert.equal(glide.moving(2000 + RESIZE_MS), false);

	// A new target midway starts from where the size stands.
	glide.at(10, 3000);
	const mid = glide.at(10, 3000 + RESIZE_MS / 2);
	assert.ok(mid < 40 && mid > 10);
	assert.equal(glide.at(20, 3000 + RESIZE_MS / 2), mid);
	assert.equal(glide.at(20, 3000 + RESIZE_MS / 2 + RESIZE_MS), 20);
});

test("usage: a click on the head row hits the view and range tabs", () => {
	assert.deepEqual(tabSpans(["5h", "24h"], 3), [
		{ from: 3, to: 7 },
		{ from: 8, to: 13 },
	]);
	const views = ["Accounts", "Models"];
	const ranges = ["5h", "24h", "7d", "30d"];
	// "[Accounts]  Models    │   [5h]  24h …"
	assert.deepEqual(headTabAt(0, views, ranges), { view: 0 });
	assert.deepEqual(headTabAt(9, views, ranges), { view: 0 });
	assert.equal(headTabAt(10, views, ranges), undefined);
	assert.deepEqual(headTabAt(11, views, ranges), { view: 1 });
	assert.equal(headTabAt(20, views, ranges), undefined);
	const rangeStart = 19 + "   │   ".length;
	assert.deepEqual(headTabAt(rangeStart, views, ranges), { range: 0 });
	assert.deepEqual(headTabAt(rangeStart + 5, views, ranges), { range: 1 });
	assert.equal(headTabAt(200, views, ranges), undefined);
});
