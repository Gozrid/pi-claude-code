/**
 * Mermaid diagrams that do not fit (logic of mermaid.ts)
 *
 * pi draws ```mermaid blocks itself, but leaves one as source when it is wider
 * than the chat. A flowchart that is too wide is drawn again turned (left-right
 * becomes top-down and back); what is too wide either way is reported, so the
 * model can redraw it.
 */

import { Marked } from "@earendil-works/pi-tui";

/** What grok-mermaid's render() returns, as far as it is used here. */
export interface Art {
	width: number;
	plain: string[];
	styled: { cls: string; text: string }[][];
	warnings: string[];
}
export type Render = (source: string) => Art | null | undefined;
/** Colours a span of a diagram by its class (border, text, edge, …). */
export type Style = (cls: string, text: string) => string;

export type Fit =
	| { kind: "fits"; art: Art }
	| { kind: "turned"; art: Art }
	| { kind: "tooWide"; width: number }
	/** Not drawn for another reason (syntax, diagram type); pi shows that itself. */
	| { kind: "skip" };

const parser = new Marked();

const isMermaid = (token: { type: string; lang?: string }) =>
	token.type === "code" && token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid";

/** The sources of the ```mermaid blocks at the top level, as pi draws them. */
export function mermaidSources(markdown: string): string[] {
	if (!/mermaid/i.test(markdown)) return [];
	return parser
		.lexer(markdown)
		.filter(isMermaid)
		.map((token) => (token as { text: string }).text);
}

const HEADER = /^(\s*)(flowchart|graph)(?:\s+(TB|TD|BT|RL|LR))?(\s*;?\s*)$/i;

/** The flowchart turned: left-right becomes top-down, top-down (the default) left-right. */
export function turned(source: string): string | undefined {
	const lines = source.split("\n");
	let frontMatter = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!.trim();
		if (i === 0 && line === "---") {
			frontMatter = true;
			continue;
		}
		if (frontMatter) {
			if (line === "---") frontMatter = false;
			continue;
		}
		if (!line || line.startsWith("%%")) continue;
		const match = HEADER.exec(lines[i]!);
		if (!match) return undefined;
		const [, indent, keyword, direction = "TD", rest] = match;
		const other = /^(LR|RL)$/i.test(direction) ? "TD" : "LR";
		lines[i] = `${indent}${keyword} ${other}${rest}`;
		return lines.join("\n");
	}
	return undefined;
}

const drawn = (art: Art | null | undefined): art is Art => !!art && art.warnings.length === 0;

/** How a diagram fits into `available` columns: as written, turned, or not at all. */
export function fitDiagram(source: string, available: number, render: Render): Fit {
	const art = render(source);
	if (!drawn(art)) return { kind: "skip" };
	if (art.width <= available) return { kind: "fits", art };
	const other = turned(source);
	const turnedArt = other === undefined ? undefined : render(other);
	if (drawn(turnedArt)) {
		if (turnedArt.width <= available) return { kind: "turned", art: turnedArt };
		return { kind: "tooWide", width: Math.min(art.width, turnedArt.width) };
	}
	return { kind: "tooWide", width: art.width };
}

/** A diagram row as inline code, so Markdown keeps its spaces (as pi does). */
export function codeSpan(line: string): string {
	const content = line || " ";
	const longest = Math.max(0, ...Array.from(content.matchAll(/`+/g), (m) => m[0].length));
	const fence = "`".repeat(longest + 1);
	const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
	return `${fence}${padding}${content}${padding}${fence}`;
}

/**
 * Draws the mermaid blocks pi left as source because they were too wide, turned
 * where that fits. `onTooWide` hears of every block that fits neither way.
 */
export function turnTooWide(
	markdown: string,
	available: number,
	render: Render,
	style?: Style,
	onTooWide?: (source: string, width: number) => void,
): string {
	if (!/mermaid/i.test(markdown)) return markdown;
	let changed = false;
	const parts = parser.lexer(markdown).map((token) => {
		if (!isMermaid(token)) return token.raw;
		const fit = fitDiagram((token as { text: string }).text, available, render);
		if (fit.kind === "tooWide") onTooWide?.((token as { text: string }).text, fit.width);
		if (fit.kind !== "turned") return token.raw;
		changed = true;
		const lines = style ? fit.art.styled.map((row) => row.map((span) => style(span.cls, span.text)).join("")) : fit.art.plain;
		return `${lines.map(codeSpan).join("  \n")}\n`;
	});
	return changed ? parts.join("") : markdown;
}

/** The note to the model about diagrams it should draw narrower. */
export function tooWideNote(diagrams: { source: string; width: number }[], available: number): string {
	const list = diagrams.map(({ source, width }) => {
		const first = source.split("\n").find((line) => line.trim() && !line.trim().startsWith("%%"))?.trim() ?? "mermaid";
		return `- \`${first}\` … needs ${width} columns`;
	});
	const what = diagrams.length === 1 ? "A Mermaid diagram in your last answer is" : `${diagrams.length} Mermaid diagrams in your last answer are`;
	return [
		`${what} too wide for the user's terminal: only ${available} columns are available, so it shows as source code instead of a drawing.`,
		...list,
		"",
		`Please draw ${diagrams.length === 1 ? "it" : "them"} again so each fits into ${available} columns: top-down layout (flowchart TD), shorter labels, fewer nodes side by side, or several smaller diagrams. Settings like %%{init}%% font sizes or spacing have no effect in the terminal.`,
	].join("\n");
}
