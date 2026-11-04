/**
 * Mermaid diagrams (part of chat-view)
 *
 * pi draws ```mermaid blocks as box-drawing art itself (setting markdown.mermaid),
 * but shows one as source when it is wider than the chat. Such a flowchart is
 * drawn turned instead, left-right as top-down or the other way round, if that
 * fits. If an answer still has a diagram too wide either way, a note goes back
 * to the model once the round is over, asking it to draw the diagram narrower;
 * at most MAX_NOTES times in a row, until the user writes again.
 *
 * The drawing comes from grok-mermaid, which pi ships; without it nothing changes.
 *
 * PI_MERMAID_FEEDBACK=0 turns the note to the model off.
 */

import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mermaidSources, type Render, type Style, tooWideNote, turnTooWide } from "./diagrams.ts";

type Theme = ExtensionContext["ui"]["theme"];

const NOTE = "mermaid-too-wide";
/** Notes in a row without the user writing in between. */
const MAX_NOTES = 2;

/** Where pi is installed: the running pi, else the managed install. */
function piPaths(): string[] {
	const paths: string[] = [];
	try {
		if (process.argv[1]) paths.push(realpathSync(process.argv[1]));
	} catch {}
	const install = process.env.PI_MANAGED_INSTALL_ROOT ?? join(homedir(), ".pi", "agent", "install");
	try {
		const version = readFileSync(join(install, "current-version"), "utf8").trim();
		paths.push(join(install, "releases", version, "node_modules", "resolve-from-here.js"));
	} catch {}
	return paths;
}

/** grok-mermaid's render() from pi's own dependencies. */
export async function loadRenderer(): Promise<Render | undefined> {
	for (const from of piPaths()) {
		try {
			const entry = createRequire(from).resolve("grok-mermaid");
			const module = (await import(pathToFileURL(entry).href)) as { render?: Render };
			if (typeof module.render === "function") return module.render;
		} catch {}
	}
	return undefined;
}

/** The colours pi gives its diagrams. */
const themeStyle =
	(theme: Theme): Style =>
	(cls, text) => {
		switch (cls) {
			case "border":
				return theme.fg("borderMuted", text);
			case "text":
				return theme.fg("text", text);
			case "edge":
				return theme.fg("accent", text);
			case "edgeLabel":
				return theme.fg("muted", text);
			case "title":
				return theme.fg("accent", theme.bold(text));
			default:
				return text;
		}
	};

const assistantText = (messages: unknown[]): string[] =>
	(messages as { role?: string; content?: unknown }[])
		.filter((m) => m.role === "assistant" && Array.isArray(m.content))
		.flatMap((m) => (m.content as { type: string; text?: string }[]).filter((c) => c.type === "text" && c.text).map((c) => c.text!));

export function mermaidDiagrams(pi: ExtensionAPI) {
	const feedback = process.env.PI_MERMAID_FEEDBACK !== "0";
	let render: Render | undefined;
	let theme: Theme | undefined;
	/** Width of the last finished assistant message drawn, and its diagrams too wide either way. */
	let width: number | undefined;
	const tooWide = new Map<string, number>();
	/** Diagrams of the round just ended, checked once it has settled. */
	let roundSources: string[] = [];
	let notes = 0;

	const mode = (): string => {
		try {
			return (pi.getSettings() as { markdown?: { mermaid?: string } }).markdown?.mermaid ?? "streaming";
		} catch {
			return "streaming";
		}
	};

	pi.registerMarkdownTransformer((markdown, context) => {
		if (!render || context.messageType === "assistant-thinking" || !/mermaid/i.test(markdown)) return markdown;
		const current = mode();
		if (current === "off" || (context.isStreaming && current !== "streaming")) return markdown;
		const finished = context.messageType === "assistant" && !context.isStreaming;
		if (finished) width = context.availableWidth;
		return turnTooWide(markdown, context.availableWidth, render, theme && themeStyle(theme), (source, needed) => {
			if (finished) tooWide.set(source, needed);
		});
	});

	pi.on("session_start", async (_event, ctx) => {
		theme = ctx.ui.theme;
		render ??= await loadRenderer();
		notes = 0;
	});

	pi.on("input", async (event) => {
		if (event.source !== "extension") notes = 0;
		return { action: "continue" };
	});

	pi.on("agent_start", async () => {
		tooWide.clear();
		roundSources = [];
	});

	pi.on("agent_end", async (event) => {
		roundSources = assistantText(event.messages).flatMap(mermaidSources);
	});

	pi.on("agent_settled", async (event, ctx) => {
		const sources = roundSources;
		roundSources = [];
		if (!feedback || event.aborted || !render || sources.length === 0 || mode() === "off" || notes >= MAX_NOTES) return;
		theme = ctx.ui.theme;
		// The last row of the answer may not be drawn yet; the chat's width is then the terminal's.
		const available = width ?? Math.max(20, (process.stdout.columns ?? 80) - 2);
		const wide = sources.flatMap((source) => {
			const known = tooWide.get(source);
			if (known !== undefined) return [{ source, width: known }];
			let needed: number | undefined;
			turnTooWide(`\`\`\`mermaid\n${source}\n\`\`\``, available, render!, undefined, (_s, w) => (needed = w));
			return needed === undefined ? [] : [{ source, width: needed }];
		});
		if (wide.length === 0) return;
		notes++;
		pi.sendMessage({ customType: NOTE, content: tooWideNote(wide, available), display: true }, { triggerTurn: true });
	});
}
