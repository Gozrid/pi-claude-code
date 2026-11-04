/**
 * Subagents for pi
 *
 * Above the editor, the subagents a CLI agent (Claude Code, Antigravity) runs
 * right now:
 *   Subagents 2 running · click to watch
 *   ◐ Review PR 13  general-purpose · 1m 12s · Bash gh pr diff 13
 * A click on it, or /subagents, opens a popup with every subagent of the
 * session in a box on the left and the selected one's output on the right,
 * live while it runs (browser.ts).
 *
 * The subagents come from the provider extensions over pi's event bus
 * (SUBAGENTS_CHANNEL in ../shared/agent-bus.ts).
 */

import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown, type OverlayOptions, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { type Subagent, SUBAGENTS_CHANNEL, type SubagentsEvent } from "../shared/agent-bus.ts";
import { darkenBackdrop } from "../shared/backdrop.ts";
import { OPENING_MS, UNFOLD_MS, unfoldedSize } from "../shared/opening.ts";
import { SubagentBrowser } from "./browser.ts";
import { panelLines, sortAgents } from "./panel.ts";

const WIDGET = "subagents";
const POPUP_LAYOUT = { width: "90%", minWidth: 40, maxHeight: "90%", anchor: "center" } satisfies OverlayOptions;
/** Frames of the opening animation. */
const FRAME_MS = 33;

export default function (pi: ExtensionAPI) {
	/** The latest subagents per provider extension; only the one with a model selected has any. */
	const lists = new Map<string, Subagent[]>();
	const all = () => [...lists.values()].flat();
	const running = () => sortAgents(all()).filter((a) => a.status === "running");
	let current: ExtensionContext | undefined;
	/** Asks the open popup and the panel to draw again. */
	let refreshPopup: (() => void) | undefined;
	let refreshPanel: (() => void) | undefined;

	/** The open popup. */
	let popup: SubagentBrowser | undefined;
	const openPopup = (ctx: ExtensionContext, selected?: string) => {
		if (ctx.mode !== "tui" || popup) return;
		const markdownTheme = getMarkdownTheme();
		let closed = false;
		let restoreBackdrop: (() => void) | undefined;
		let frames: ReturnType<typeof setInterval> | undefined;
		let clock: ReturnType<typeof setInterval> | undefined;
		// Starts small; the opening unfolds it (pi reads this object on every render).
		const layout: OverlayOptions = { ...POPUP_LAYOUT, width: 12, minWidth: undefined };
		const stop = () => {
			if (closed) return;
			closed = true;
			if (frames) clearInterval(frames);
			if (clock) clearInterval(clock);
			restoreBackdrop?.();
			popup = undefined;
			refreshPopup = undefined;
		};
		void ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				const close = () => {
					stop();
					done();
				};
				const browser = new SubagentBrowser({
					theme,
					load: all,
					markdown: (text, width) => new Markdown(text, 0, 0, markdownTheme).render(width),
					rows: () => Math.floor(tui.terminal.rows * 0.9),
					requestRender: () => tui.requestRender(),
					selected,
					close,
				});
				popup = browser;
				refreshPopup = () => tui.requestRender();
				// Opens like the wish popup: the frame unfolds while the chat behind it darkens, then the title is typed.
				const openedAt = Date.now();
				restoreBackdrop = darkenBackdrop(tui, theme, UNFOLD_MS);
				frames = setInterval(() => {
					tui.requestRender();
					if (Date.now() - openedAt >= OPENING_MS && frames) {
						clearInterval(frames);
						frames = undefined;
					}
				}, FRAME_MS);
				frames.unref?.();
				// Run times tick on while a subagent runs.
				clock = setInterval(() => {
					if (running().length > 0) tui.requestRender();
				}, 1000);
				clock.unref?.();
				const render = (width: number) => {
					const elapsed = Date.now() - openedAt;
					if (elapsed < UNFOLD_MS) {
						const fullWidth = Math.max(POPUP_LAYOUT.minWidth, Math.floor(tui.terminal.columns * 0.9));
						const size = unfoldedSize(elapsed, fullWidth, browser.height());
						// Takes effect with the next frame.
						layout.width = size.width;
						layout.minWidth = undefined;
						return browser.renderUnfolding(width, size.rows);
					}
					Object.assign(layout, POPUP_LAYOUT);
					return browser.render(width, elapsed < OPENING_MS ? elapsed : undefined);
				};
				return {
					render,
					invalidate: () => browser.invalidate(),
					handleInput: (data: string) => browser.handleInput(data),
					handleMouse: (event: TuiMouseEvent) => browser.handleMouse(event),
					dispose: stop,
				};
			},
			{ overlay: true, overlayOptions: layout },
		);
	};

	/** Whether the panel is up. */
	let shown = false;
	const renderPanel = (ctx: ExtensionContext | undefined = current) => {
		if (!ctx?.hasUI || ctx.mode !== "tui") return;
		current = ctx;
		const show = running().length > 0;
		if (show === shown) {
			refreshPanel?.();
			return;
		}
		shown = show;
		try {
			if (!show) {
				refreshPanel = undefined;
				ctx.ui.setWidget(WIDGET, undefined);
				return;
			}
			ctx.ui.setWidget(WIDGET, (tui, theme) => {
				let lines: string[] = [];
				let agents: Subagent[] = [];
				refreshPanel = () => tui.requestRender();
				// Run times tick on.
				const clock = setInterval(() => tui.requestRender(), 1000);
				clock.unref?.();
				return {
					render: (width: number) => {
						agents = running();
						lines = panelLines(theme, agents, Date.now(), width);
						return lines;
					},
					handleMouse: (event: TuiMouseEvent) => {
						if (event.button !== "left" || event.y < 0 || event.y >= lines.length) return undefined;
						if (event.type === "click") openPopup(current ?? ctx, agents[event.y - 1]?.id ?? agents[0]?.id);
						if (event.type === "press" || event.type === "release" || event.type === "click") return { handled: true, render: false };
						return undefined;
					},
					invalidate() {},
					dispose: () => clearInterval(clock),
				};
			});
		} catch {
			// Stale context after a reload or session switch.
			current = undefined;
			shown = false;
		}
	};

	pi.events.on(SUBAGENTS_CHANNEL, (data) => {
		const event = data as SubagentsEvent;
		if (!event?.source) return;
		lists.set(event.source, event.agents ?? []);
		renderPanel();
		refreshPopup?.();
	});

	pi.registerCommand("subagents", {
		description: "Watch the subagents of this session: each in a box, the selected one's output live",
		handler: async (_arg, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("The subagent popup needs the interactive terminal UI", "warning");
				return;
			}
			openPopup(ctx, running()[0]?.id);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		shown = false;
		renderPanel(ctx);
	});
	pi.on("agent_start", async (_event, ctx) => renderPanel(ctx));
	pi.on("agent_end", async (_event, ctx) => renderPanel(ctx));
	pi.on("session_shutdown", async () => {
		current = undefined;
		refreshPanel = undefined;
	});
}
