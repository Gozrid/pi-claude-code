/**
 * Grouped messages (part of chat-view)
 *
 * An assistant message that thought or used tools before answering is laid out
 * in two parts: the work, framed by a line on the left, with consecutive
 * thoughts under one "✻ Thinking" heading and consecutive tool calls (the
 * "⏺ / ⎿" lines of the claude-code provider) under one "⚙ Tools" heading; and
 * below it, set apart under an "Answer" rule, what the model finally says.
 * While the message streams, its text shows as a note; it becomes the answer
 * only once the message ends. Messages that only answer then look as before.
 * The tool calls show as tool blocks (see tool-blocks.ts): details collapsed
 * until pi's Ctrl+O expands the tool output.
 *
 * The mouse (pi's fullscreen mode): a click on a tool block expands or collapses
 * just that block, a click on a thinking section shows or hides just that
 * thought, as pi does for its own tools and thinking. Ctrl+O and pi's thinking
 * toggle set every block again.
 *
 * pi has no hook for this, so the extension finds pi's AssistantMessageComponent
 * in the TUI and wraps its layout; without it, nothing changes.
 *
 * Usage:
 *   /group [on|off]   group the work and set the answer apart (toggles without an argument)
 *
 * PI_GROUP_MESSAGES=0 starts with it off.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, MouseRegion, Spacer, type TUI, type TuiMouseEvent, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { barCodeBlocks } from "./code-blocks.ts";
import { groupMessage, type Section } from "./grouping.ts";
import { splitToolBlock, toolBlock } from "./tool-blocks.ts";

type Theme = ExtensionContext["ui"]["theme"];

/** A widget that draws nothing; it only hands over the TUI. */
const WIDGET = "grouped-messages";
/** pi's own layout, kept on the class so a reloaded extension wraps it, not an earlier wrapper. */
const ORIGINAL = Symbol.for("pi-claude-code.chat-view.updateContent");
/** Tool blocks of a message expanded or collapsed by a click, apart from Ctrl+O: block key → expanded. */
const TOOL_OVERRIDES = Symbol.for("pi-claude-code.chat-view.toolOverrides");

/** The fields of pi's AssistantMessageComponent the layout uses. */
interface AssistantMessageLike extends Component {
	contentContainer: { children: Component[]; clear(): void; addChild(c: Component): void };
	hideThinkingBlock: boolean;
	markdownTheme: ConstructorParameters<typeof Markdown>[3];
	outputPad: number;
	markdownTransformers: ((markdown: string, context: object) => unknown)[];
	lastMessage?: { content: { type: string }[] };
	isStreaming: boolean;
	updateContent(message: unknown, isStreaming?: boolean): void;
	/** pi calls this on Ctrl+O for every component in the chat that has it. */
	setExpanded?(expanded: boolean): void;
	/** Thinking runs shown or hidden by a click, apart from pi's setting; pi clears it when the setting changes. */
	thinkingVisibilityOverrides?: Map<number, boolean>;
	[TOOL_OVERRIDES]?: Map<string, boolean>;
}

type PatchedProto = AssistantMessageLike & { [ORIGINAL]?: AssistantMessageLike["updateContent"] };

const isAssistantMessage = (c: unknown) => !!c && (c as object).constructor?.name.startsWith("AssistantMessageComponent");

function assistantMessages(tui: TUI): AssistantMessageLike[] {
	const found: AssistantMessageLike[] = [];
	const stack: unknown[] = [...tui.children];
	while (stack.length > 0) {
		const node = stack.pop() as { children?: unknown[]; entries?: { component: unknown }[] } | undefined;
		if (isAssistantMessage(node)) {
			found.push(node as unknown as AssistantMessageLike);
			continue;
		}
		if (Array.isArray(node?.children)) stack.push(...node.children);
		if (Array.isArray(node?.entries)) stack.push(...node.entries.map((e) => e.component));
	}
	return found;
}

/** Rows computed from the width. */
class Rows implements Component {
	private readonly rows: (width: number) => string[];
	constructor(rows: (width: number) => string[]) {
		this.rows = rows;
	}
	render(width: number): string[] {
		return this.rows(width).map((row) => truncateToWidth(row, width));
	}
	invalidate(): void {}
}

/** A component drawn behind a prefix, e.g. the frame line of the work part. */
class Prefixed implements Component {
	private readonly child: Component;
	private readonly prefix: string;
	constructor(child: Component, prefix: string) {
		this.child = child;
		this.prefix = prefix;
	}
	render(width: number): string[] {
		const inner = Math.max(1, width - visibleWidth(this.prefix));
		return this.child.render(inner).map((row) => this.prefix + row);
	}
	invalidate(): void {
		this.child.invalidate?.();
	}
}

/** A left click: the mouse toggles what was clicked. */
const isClick = (event: TuiMouseEvent) => event.type === "click" && event.button === "left";

/** Components stacked as one, so a click anywhere on them reaches one handler. */
function stack(parts: Component[], onClick: () => void): Component {
	const box = new Container();
	for (const part of parts) box.addChild(part);
	return new MouseRegion(box, (event) => {
		if (!isClick(event)) return undefined;
		onClick();
		return { handled: true };
	});
}

/** pi's Markdown transform chain, as AssistantMessageComponent applies it. */
function transform(self: AssistantMessageLike, messageType: string) {
	return (markdown: string, availableWidth: number) => {
		let out = markdown;
		for (const transformer of self.markdownTransformers ?? []) {
			try {
				const next = transformer(out, { messageType, isStreaming: self.isStreaming, availableWidth });
				if (typeof next === "string") out = next;
			} catch {
				// Keep the current Markdown, like pi does.
			}
		}
		return out;
	};
}

/** The work part and the answer, built in place of pi's flat list of blocks. */
function layout(
	self: AssistantMessageLike,
	theme: Theme,
	message: { content: { type: string }[] },
	expanded: boolean,
): Component[] | undefined {
	const { work, answer } = groupMessage(message.content, self.isStreaming);
	if (work.length === 0) return undefined;

	const pad = " ".repeat(self.outputPad);
	const frame = (s: string) => theme.fg("borderMuted", s);
	const heading = (corner: string, text: string) => new Rows(() => [`${pad}${frame(`${corner}─ `)}${text}`]);
	const body = (child: Component) => new Prefixed(child, `${pad}${frame("│")}  `);
	const markdown = (text: string, type: string, style?: ConstructorParameters<typeof Markdown>[4]) =>
		new Markdown(text, 0, 0, self.markdownTheme, style, { transform: transform(self, type) });

	const relayout = () => {
		if (self.lastMessage) self.updateContent(self.lastMessage);
	};
	const toolOverrides = (self[TOOL_OVERRIDES] ??= new Map());
	let thinkingRun = 0;

	const parts: Component[] = [new Spacer(1)];
	work.forEach((section: Section, i) => {
		const corner = i === 0 ? "╭" : "├";
		if (i > 0) parts.push(new Rows(() => [`${pad}${frame("│")}`]));
		if (section.kind === "thinking") {
			const run = thinkingRun++;
			const hidden = self.thinkingVisibilityOverrides?.get(run) ?? self.hideThinkingBlock;
			const thought: Component[] = [
				heading(corner, theme.style("✻ Thinking", { fg: "thinkingText", italic: true }) + (hidden ? theme.fg("dim", " · hidden") : "")),
			];
			if (!hidden) {
				thought.push(
					body(markdown(section.texts.join("\n\n"), "assistant-thinking", { color: (t) => theme.fg("thinkingText", t), italic: true })),
				);
			}
			parts.push(
				stack(thought, () => {
					(self.thinkingVisibilityOverrides ??= new Map()).set(run, !hidden);
					relayout();
				}),
			);
		} else if (section.kind === "tools") {
			const count = section.calls === 1 ? "1 call" : `${section.calls} calls`;
			parts.push(heading(corner, `${theme.style("⚙ Tools", { fg: "toolTitle", bold: true })}${theme.fg("dim", ` · ${count}`)}`));
			section.texts.forEach((text, j) => {
				const key = `${i}:${j}`;
				const open = toolOverrides.get(key) ?? expanded;
				const options = { theme, markdownTheme: self.markdownTheme, transform: transform(self, "assistant"), expanded: open };
				const block = toolBlock(text, options).map(body);
				// Only blocks with details have something to expand.
				if (!splitToolBlock(text).body) parts.push(...block);
				else
					parts.push(
						stack(block, () => {
							toolOverrides.set(key, !open);
							relayout();
						}),
					);
			});
		} else {
			parts.push(heading(corner, theme.fg("muted", "✎ Note")));
			parts.push(body(markdown(section.text, "assistant")));
		}
	});
	parts.push(new Rows(() => [`${pad}${frame("╰─")}`]));

	if (answer) {
		parts.push(new Spacer(1));
		parts.push(
			new Rows((width) => {
				const title = `${theme.style("● Answer", { fg: "accent", bold: true })} `;
				const rule = Math.max(0, width - self.outputPad * 2 - visibleWidth(title));
				return [`${pad}${title}${theme.fg("borderAccent", "─".repeat(rule))}`];
			}),
		);
		parts.push(new Spacer(1));
		parts.push(new Markdown(answer, self.outputPad, 0, self.markdownTheme, undefined, { transform: transform(self, "assistant") }));
	}
	return parts;
}

export function groupedMessages(pi: ExtensionAPI) {
	let enabled = process.env.PI_GROUP_MESSAGES !== "0";
	let theme: Theme | undefined;
	let tui: TUI | undefined;
	let toolsExpanded = () => false;
	let patched: PatchedProto | undefined;
	/** False once the session shut down: its ctx is stale, and its widget may still render. */
	let active = false;

	/** Wraps the layout of pi's AssistantMessageComponent, found through one of its instances. */
	const patch = (instance: AssistantMessageLike) => {
		const proto = Object.getPrototypeOf(instance) as PatchedProto;
		proto[ORIGINAL] ??= proto.updateContent;
		const original = proto[ORIGINAL]!;
		proto.updateContent = function (this: AssistantMessageLike, message: any, isStreaming = this.isStreaming) {
			if (theme && this.markdownTheme) barCodeBlocks(this.markdownTheme, theme);
			// pi lays out errors, aborts and truncation from the tool calls alone.
			const tail = { ...message, content: message.content.filter((c: { type: string }) => c.type === "toolCall") };
			const parts = enabled && theme ? layout(Object.assign(this, { isStreaming }), theme, message, toolsExpanded()) : undefined;
			if (!parts) return original.call(this, message, isStreaming);
			original.call(this, tail, isStreaming);
			this.lastMessage = message;
			const extra = [...this.contentContainer.children];
			this.contentContainer.clear();
			for (const part of [...parts, ...extra]) this.contentContainer.addChild(part);
		};
		proto.setExpanded = function (this: AssistantMessageLike) {
			// Ctrl+O sets every block of the chat again, also those clicked open or shut.
			this[TOOL_OVERRIDES]?.clear();
			if (this.lastMessage) this.updateContent(this.lastMessage);
		};
		patched = proto;
	};

	/**
	 * Puts pi's own layout back and stops wrapping it again. The class outlives a reload or
	 * session replacement, and pi lays out the chat again before session_start, when this
	 * instance's ctx is already stale and reading it throws.
	 */
	const stop = () => {
		active = false;
		toolsExpanded = () => false;
		if (!patched) return;
		patched.updateContent = patched[ORIGINAL]!;
		delete patched.setExpanded;
		patched = undefined;
	};

	/** Lays out every assistant message in the chat again. */
	const relayout = () => {
		if (!tui) return;
		for (const message of assistantMessages(tui)) message.invalidate?.();
		tui.requestRender();
	};

	const show = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		active = true;
		toolsExpanded = () => ctx.ui.getToolsExpanded();
		ctx.ui.setWidget(WIDGET, (ui, uiTheme) => {
			tui = ui;
			theme = uiTheme;
			return {
				render: () => {
					// The class shows up with the first assistant message.
					if (active && !patched && enabled) {
						const first = assistantMessages(ui)[0];
						if (first) {
							patch(first);
							relayout();
						}
					}
					return [];
				},
				invalidate() {},
			};
		});
	};

	pi.on("session_start", async (_event, ctx) => show(ctx));
	pi.on("session_shutdown", async () => stop());

	pi.registerCommand("group", {
		description: "Group thoughts and tool calls, and set the answer apart: /group [on|off]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			enabled = arg === "on" ? true : arg === "off" ? false : !enabled;
			relayout();
			ctx.ui.notify(`Grouped messages ${enabled ? "on" : "off"}`, "info");
		},
	});
}
