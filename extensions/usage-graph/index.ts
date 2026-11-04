/**
 * Usage graph: the plan usage of every connected CLI account and the tokens of
 * every model over time.
 *
 * The provider extensions (claude-code, antigravity) publish the usage limits of
 * all their accounts on USAGE_CHANNEL (see ../shared/agent-bus.ts); this
 * extension records them in ~/.pi/agent/usage-history.jsonl. The tokens of
 * every answer, of any model, go to ~/.pi/agent/usage-models.jsonl.
 *
 *   /usage   Accounts: one chart per account, a line per limit (5h session,
 *            weekly, per model …); Models: a stacked bar per time slot, a
 *            coloured segment per model. Tab switches the view, ←/→ the range,
 *            r reads fresh limits; the chat behind the dialog is darkened
 *
 * Every 15 minutes while pi is idle it asks the providers for fresh usage of
 * all accounts, so accounts that are not selected are charted too.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type OverlayOptions, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	type UsageAccount,
	USAGE_CHANNEL,
	USAGE_REFRESH_CHANNEL,
	type UsageEvent,
	type UsageRefreshRequest,
} from "../shared/agent-bus.ts";
import { formatDuration, formatTokens } from "../shared/format.ts";
import { darkenBackdrop } from "../shared/backdrop.ts";
import { chart, formatAgo, type Point, sequential, stackedBars, valueAt } from "./chart.ts";
import { History, type Sample } from "./history.ts";
import { Glide, OPENING_MS, openingTitle, shownRows, UNFOLD_MS, unfoldedSize } from "../shared/opening.ts";
import { ModelLog, type ModelView, modelViews, sampleFromMessage } from "./models.ts";

type Theme = ExtensionContext["ui"]["theme"];
type Color = Parameters<Theme["fg"]>[0];

/** Time ranges, with the time slot the Models view sums tokens over. */
const RANGES = [
	{ label: "5h", ms: 5 * 3600_000, slot: 10 * 60_000, slotLabel: "10 minutes" },
	{ label: "24h", ms: 24 * 3600_000, slot: 3600_000, slotLabel: "hour" },
	{ label: "7d", ms: 7 * 24 * 3600_000, slot: 6 * 3600_000, slotLabel: "6 hours" },
	{ label: "30d", ms: 30 * 24 * 3600_000, slot: 24 * 3600_000, slotLabel: "day" },
];
const VIEWS = ["Accounts", "Models"] as const;
type View = (typeof VIEWS)[number];
const DEFAULT_RANGE = 1;
const REFRESH_EVERY_MS = 15 * 60_000;
const CHART_HEIGHT = 7;
/**
 * The graphs build up one part after another: a line takes LINE_MS, a bar
 * BAR_MS; the whole at least ANIMATION_MIN_MS and at most ANIMATION_MAX_MS.
 */
const LINE_MS = 500;
const BAR_MS = 70;
const ANIMATION_MIN_MS = 700;
const ANIMATION_MAX_MS = 3000;
const FRAME_MS = 33;

/** The dialog's size and place once open. */
const FULL_LAYOUT = { width: "90%", minWidth: 60, maxHeight: "90%", anchor: "center" } satisfies OverlayOptions;

export function animationMs(parts: number, partMs: number): number {
	return Math.max(ANIMATION_MIN_MS, Math.min(ANIMATION_MAX_MS, parts * partMs));
}
const LINE_COLORS: Color[] = ["accent", "success", "warning", "syntaxKeyword", "syntaxString", "syntaxType", "syntaxNumber", "error"];

export interface AccountView {
	id: string;
	name: string;
	/** When its usage was last read. */
	updatedAt: number;
	windows: { id: string; label: string; points: Point[] }[];
}

/** Groups the samples by account and window, accounts sorted by name, windows in the order first seen. */
export function accountViews(samples: readonly Sample[]): AccountView[] {
	const accounts = new Map<string, AccountView>();
	for (const s of samples) {
		let account = accounts.get(s.a);
		if (!account) {
			account = { id: s.a, name: s.n, updatedAt: s.t, windows: [] };
			accounts.set(s.a, account);
		}
		account.name = s.n;
		account.updatedAt = Math.max(account.updatedAt, s.t);
		let window = account.windows.find((w) => w.id === s.w);
		if (!window) {
			window = { id: s.w, label: s.l, points: [] };
			account.windows.push(window);
		}
		window.label = s.l;
		window.points.push({ t: s.t, p: s.p, ...(s.r !== undefined && { r: s.r }) });
	}
	return [...accounts.values()].sort((x, y) => x.name.localeCompare(y.name));
}

function bar(percent: number, width = 10): string {
	const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
	return "▓".repeat(filled) + "░".repeat(width - filled);
}

/** The lines of one account: name, chart and a legend line per window. */
export function renderAccount(theme: Theme, view: AccountView, width: number, from: number, now: number, progress = 1): string[] {
	const colorOf = (i: number) => (text: string) => theme.fg(LINE_COLORS[i % LINE_COLORS.length], text);
	const lines = [
		`${theme.bold(view.name)}${theme.fg("dim", ` · read ${formatAgo(now - view.updatedAt)} ago`)}`,
		...chart(
			view.windows.map((w, i) => ({ points: w.points, color: colorOf(i) })),
			{ from, to: now, width, height: CHART_HEIGHT, dim: (t) => theme.fg("dim", t), now, reveal: progress },
		),
	];
	const labelWidth = Math.min(32, Math.max(...view.windows.map((w) => w.label.length)));
	view.windows.forEach((w, i) => {
		// Counts up while its line is drawn.
		const value = (valueAt(w.points, now) ?? 0) * sequential(progress, i, view.windows.length);
		const last = w.points[w.points.length - 1];
		const reset = last?.r !== undefined && last.r > now ? theme.fg("dim", ` · reset in ${formatDuration(last.r - now)}`) : "";
		const valueColor: Color = value >= 90 ? "error" : value >= 75 ? "warning" : "text";
		lines.push(
			`  ${colorOf(i)("━━")} ${truncateToWidth(w.label, labelWidth).padEnd(labelWidth)}  ${theme.fg(valueColor, `${bar(value)} ${value.toFixed(1).padStart(5)}%`)}${reset}`,
		);
	});
	return lines;
}

/**
 * The Models view: a stacked bar per time slot, a coloured segment per model
 * (its tokens in that slot), and a legend line per model with its total, the
 * split and the cost.
 * `colorIndex` keeps a model's colour the same across ranges.
 */
export function renderModels(
	theme: Theme,
	views: readonly ModelView[],
	colorIndex: (id: string) => number,
	width: number,
	from: number,
	now: number,
	slotLabel: string,
	progress = 1,
): string[] {
	const colorOf = (id: string) => (text: string) => theme.fg(LINE_COLORS[colorIndex(id) % LINE_COLORS.length], text);
	// One bar per time slot, a segment per model stacked from the bottom, the busiest model lowest.
	const slots = views[0]?.buckets.length ?? 0;
	const values = Array.from({ length: slots }, (_, i) => views.map((v) => v.buckets[i]?.tokens ?? 0));
	const max = Math.max(0, ...values.map((bar) => bar.reduce((a, b) => a + b, 0)));
	if (views.length === 0 || max === 0) return [theme.fg("muted", "No answers recorded in this range yet.")];
	const colors = views.map((v) => colorOf(v.id));
	const lines = [
		`${theme.bold("Tokens per model")}${theme.fg("dim", ` · input and output per ${slotLabel}, without cache reads`)}`,
		...chart([], {
			from,
			to: now,
			width,
			height: CHART_HEIGHT,
			dim: (t) => theme.fg("dim", t),
			now,
			labels: { top: formatTokens(max), mid: formatTokens(Math.round(max / 2)), bottom: "0" },
			body: (w, h) => stackedBars(values, colors, max, w, h, progress),
		}),
	];
	const nameWidth = Math.min(32, Math.max(...views.map((v) => v.name.length)));
	for (const v of views) {
		const total = formatTokens(Math.round((v.input + v.output) * progress)).padStart(7);
		const read = v.cacheRead > 0 ? ` · cache read ${formatTokens(v.cacheRead)}` : "";
		const split = theme.fg("dim", ` · in ${formatTokens(v.input)} · out ${formatTokens(v.output)}${read}`);
		const cost = v.cost > 0 ? theme.fg("dim", ` · $${v.cost.toFixed(2)}`) : "";
		lines.push(`  ${colorOf(v.id)("██")} ${truncateToWidth(v.name, nameWidth).padEnd(nameWidth)}  ${total}${split}${cost}`);
	}
	return lines;
}

/**
 * A rounded frame around `lines` (each `width - 4` wide), with `title` in the
 * top border and `hint` in the bottom one:
 *
 *   ╭─ Plan usage ──────────────╮
 *   │ …                         │
 *   ╰─ esc close ───────────────╯
 */
export function frame(theme: Theme, width: number, title: string, hint: string, lines: string[]): string[] {
	const border = (text: string) => theme.fg("borderAccent", text);
	const edge = (left: string, label: string, right: string) => {
		const room = width - 2;
		const text = truncateToWidth(label, Math.max(0, room - 4));
		const filler = Math.max(0, room - 3 - visibleWidth(text));
		return text ? `${border(`${left}─ `)}${text}${border(` ${"─".repeat(filler)}${right}`)}` : border(`${left}${"─".repeat(room)}${right}`);
	};
	return [edge("╭", title, "╮"), ...lines.map((line) => `${border("│")} ${line} ${border("│")}`), edge("╰", hint, "╯")];
}

export default function (pi: ExtensionAPI) {
	const history = new History();
	const models = new ModelLog();
	let loaded = false;
	let current: ExtensionContext | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	/** Re-renders the open /usage view. */
	let onChange: (() => void) | undefined;

	const ensureLoaded = () => {
		if (loaded) return;
		loaded = true;
		history.load();
		models.load();
	};

	/** Colour slot of a model: the order it first appeared in, so it keeps its colour. */
	const colorSlots = new Map<string, number>();
	const colorIndex = (id: string) => {
		let slot = colorSlots.get(id);
		if (slot === undefined) {
			for (const s of models.samples) if (!colorSlots.has(s.m)) colorSlots.set(s.m, colorSlots.size);
			slot = colorSlots.get(id) ?? colorSlots.size;
			colorSlots.set(id, slot);
		}
		return slot;
	};

	// The tokens of every finished answer, of any model.
	pi.on("message_end", async (event, ctx) => {
		const message = event.message as any;
		if (message?.role !== "assistant") return;
		ensureLoaded();
		let name: string | undefined;
		try {
			name = ctx.modelRegistry.find(message.provider, message.model)?.name;
		} catch {
			// Stale context: the id is shown instead.
		}
		const sample = sampleFromMessage(message, name, Date.now());
		if (!sample) return;
		models.record(sample);
		onChange?.();
	});

	pi.events.on(USAGE_CHANNEL, (data) => {
		const event = data as UsageEvent;
		if (!Array.isArray(event?.accounts)) return;
		ensureLoaded();
		if (history.record(event.accounts as UsageAccount[]).length > 0) onChange?.();
	});

	/** Asks every provider for fresh usage; resolves once all have answered. */
	const refresh = (cwd: string): Promise<unknown> => {
		const pending: Promise<unknown>[] = [];
		pi.events.emit(USAGE_REFRESH_CHANNEL, { cwd, pending: (p) => pending.push(p) } satisfies UsageRefreshRequest);
		return Promise.allSettled(pending);
	};

	pi.on("session_start", async (_event, ctx) => {
		ensureLoaded();
		current = ctx;
		if (ctx.hasUI && !ticker) {
			ticker = setInterval(() => {
				try {
					if (current?.isIdle()) void refresh(current.cwd);
				} catch {
					current = undefined;
				}
			}, REFRESH_EVERY_MS);
			ticker.unref?.();
		}
	});

	pi.on("session_shutdown", async () => {
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		current = undefined;
	});

	pi.registerCommand("usage", {
		description: "Chart the plan usage of every connected account and the tokens of every model over time",
		handler: async (_arg, ctx) => {
			ensureLoaded();
			if (!ctx.hasUI) return;
			// Starts small; the opening unfolds it (pi reads this object on every render).
			const layout: OverlayOptions = { ...FULL_LAYOUT, width: 12, minWidth: undefined };
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					let range = DEFAULT_RANGE;
					let view: View = "Accounts";
					let scroll = 0;
					let refreshing = true;
					const reread = () => {
						refreshing = true;
						tui.requestRender();
						void refresh(ctx.cwd).finally(() => {
							refreshing = false;
							tui.requestRender();
						});
					};
					onChange = () => tui.requestRender();
					const openedAt = Date.now();
					const restoreBackdrop = darkenBackdrop(tui, theme, UNFOLD_MS);

					// The graphs build up when the dialog has unfolded and when the range or the view changes.
					let animationStart = openedAt + UNFOLD_MS;
					/** Set by render from what the view shows: how long its build-up takes. */
					let duration = ANIMATION_MAX_MS;
					let frames: ReturnType<typeof setInterval> | undefined;
					const progress = () => Math.max(0, Math.min(1, (Date.now() - animationStart) / duration));
					// Once open, the frame glides to a new size instead of jumping.
					const rowsGlide = new Glide();
					const columnsGlide = new Glide();
					const stopFrames = () => {
						if (frames) clearInterval(frames);
						frames = undefined;
					};
					/** Whether anything still moves at `now`. */
					const moving = (now: number) =>
						now - animationStart < duration ||
						now - openedAt < OPENING_MS ||
						rowsGlide.moving(now) ||
						columnsGlide.moving(now);
					/** Renders frames until nothing moves any more. */
					const play = () => {
						if (frames) return;
						frames = setInterval(() => {
							if (!moving(Date.now())) stopFrames();
							tui.requestRender();
						}, FRAME_MS);
						frames.unref?.();
					};
					const animate = (delay = 0) => {
						animationStart = Date.now() + delay;
						play();
					};

					const close = () => {
						onChange = undefined;
						stopFrames();
						restoreBackdrop();
					};
					animate(UNFOLD_MS);
					reread();

					const pad = (line: string, width: number) => {
						const cut = truncateToWidth(line, width);
						return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
					};

					/** The rows inside the frame for a dialog `width` wide, each padded to `width - 4`. */
					const content = (width: number, now: number): string[] => {
							const from = now - RANGES[range].ms;
							const step = progress();
							// Inside the frame: "│ " and " │" on each side.
							const inner = Math.max(10, width - 4);
							const choice = (label: string, selected: boolean) =>
								selected ? theme.bold(theme.fg("accent", `[${label}]`)) : theme.fg("muted", ` ${label} `);
							const viewTabs = VIEWS.map((v) => choice(v, v === view)).join(" ");
							const rangeTabs = RANGES.map((r, i) => choice(r.label, i === range)).join(" ");
							const head = [
								`${viewTabs}${theme.fg("dim", "   │   ")}${rangeTabs}${refreshing ? theme.fg("dim", "  reading…") : ""}`,
								"",
							];

							const body: string[] = [];
							const views = view === "Accounts" ? accountViews(history.samples.filter((s) => s.t <= now)) : [];
							if (view === "Models") {
								const r = RANGES[range];
								const modelList = modelViews(models.samples, from, now, r.slot);
								duration = animationMs(modelList[0]?.buckets.length ?? 0, BAR_MS);
								body.push(...renderModels(theme, modelList, colorIndex, inner, from, now, r.slotLabel, step));
							} else if (views.length === 0) {
								body.push(
									theme.fg(
										"muted",
										refreshing
											? "Reading the usage of your accounts…"
											: "No usage recorded yet. It comes from the claude-code and antigravity extensions (accounts with a subscription).",
									),
								);
							}
							// All lines of all accounts, drawn one after another.
							const lineCount = views.reduce((n, v) => n + v.windows.length, 0);
							if (view === "Accounts") duration = animationMs(lineCount, LINE_MS);
							let before = 0;
							views.forEach((view, i) => {
								if (i > 0) body.push("");
								const own = view.windows.length;
								const share = own > 0 ? Math.max(0, Math.min(1, (step * lineCount - before) / own)) : 1;
								body.push(...renderAccount(theme, view, inner, from, now, step >= 1 ? 1 : share));
								before += own;
							});

							const foot = [""];
							const room = Math.max(3, Math.floor(tui.terminal.rows * 0.9) - head.length - foot.length - 2);
							scroll = Math.max(0, Math.min(scroll, body.length - room));
							const shown = body.slice(scroll, scroll + room);
							if (body.length > room) {
								foot[0] = theme.fg("dim", `${scroll > 0 ? "↑ " : "  "}${scroll + shown.length < body.length ? "↓ more" : ""}`);
							}

							return [...head, ...shown, ...foot].map((l) => pad(l, inner));
					};

					const hint = () => theme.fg("dim", "tab view · ←/→ range · ↑/↓ scroll · r read again · esc close");

					return {
						render(width: number): string[] {
							const now = Date.now();
							const elapsed = now - openedAt;
							if (elapsed >= OPENING_MS) {
								const rows = content(width, now);
								const height = rowsGlide.at(Math.min(rows.length + 2, Math.floor(tui.terminal.rows * 0.9)), now);
								const columns = columnsGlide.at(Math.max(FULL_LAYOUT.minWidth, Math.floor(tui.terminal.columns * 0.9)), now);
								// The width takes effect with the next frame; pi reads these options on every render.
								if (columnsGlide.moving(now)) Object.assign(layout, { width: columns, minWidth: undefined });
								else Object.assign(layout, FULL_LAYOUT);
								if (rowsGlide.moving(now) || columnsGlide.moving(now)) play();
								const blank = " ".repeat(Math.max(0, width - 4));
								const inside = Math.max(0, height - 2);
								const shown = [...rows.slice(0, inside), ...new Array(Math.max(0, inside - rows.length)).fill(blank)];
								return frame(theme, width, theme.bold("Usage"), hint(), shown);
							}
							// Opening: the frame unfolds from the middle, then the title is typed and the rows appear.
							const fullWidth = Math.max(FULL_LAYOUT.minWidth, Math.floor(tui.terminal.columns * 0.9));
							if (elapsed < UNFOLD_MS) {
								const rows = Math.min(content(fullWidth, now).length + 2, Math.floor(tui.terminal.rows * 0.9));
								const size = unfoldedSize(elapsed, fullWidth, rows);
								// Takes effect with the next frame; pi reads these options on every render.
								layout.width = size.width;
								layout.minWidth = undefined;
								const blank = " ".repeat(Math.max(0, width - 4));
								return frame(theme, width, "", "", new Array(Math.max(0, size.rows - 2)).fill(blank));
							}
							Object.assign(layout, FULL_LAYOUT);
							const rows = content(width, now);
							const visible = shownRows(elapsed, rows.length);
							const blank = " ".repeat(Math.max(0, width - 4));
							return frame(
								theme,
								width,
								openingTitle(theme, "Usage", elapsed),
								hint(),
								rows.map((row, i) => (i < visible ? row : blank)),
							);
						},
						invalidate() {},
						handleInput(data: string) {
							if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
								view = VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length];
								scroll = 0;
								animate();
							} else if (matchesKey(data, Key.left) || data === "h") {
								if (range > 0) animate();
								range = Math.max(0, range - 1);
							} else if (matchesKey(data, Key.right) || data === "l") {
								if (range < RANGES.length - 1) animate();
								range = Math.min(RANGES.length - 1, range + 1);
							}
							else if (matchesKey(data, Key.up) || data === "k") scroll = Math.max(0, scroll - 1);
							else if (matchesKey(data, Key.down) || data === "j") scroll += 1;
							else if (matchesKey(data, Key.pageUp)) scroll = Math.max(0, scroll - 10);
							else if (matchesKey(data, Key.pageDown)) scroll += 10;
							else if (data === "r") reread();
							else if (matchesKey(data, Key.escape) || data === "q") {
								close();
								done();
								return;
							}
							tui.requestRender();
						},
						dispose: close,
					};
				},
				{ overlay: true, overlayOptions: layout },
			);
		},
	});
}
