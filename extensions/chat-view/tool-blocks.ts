/**
 * Tool blocks (part of chat-view)
 *
 * How the CLI providers' tool calls and results (see shared/tool-lines.ts) look
 * in the work part of a grouped message: the header line with the tool and what
 * it works on, the details below it indented and cut after a few rows until the
 * tool output is expanded (pi's Ctrl+O, the same key as for pi's own tools, or
 * a click on the block in fullscreen mode, see grouped-messages.ts).
 * Code is highlighted, file contents carry line numbers, error lines in plain
 * output are red and images show inline where the terminal can draw them.
 * Only the display changes; the message text stays as the provider wrote it.
 */

import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { type ExtensionContext, keyHint } from "@earendil-works/pi-coding-agent";
import { type Component, getCapabilities, Image, Markdown, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Theme = ExtensionContext["ui"]["theme"];
type MarkdownTheme = ConstructorParameters<typeof Markdown>[3];
type Transform = (markdown: string, availableWidth: number) => string;

/** Rows of a tool's details shown while collapsed. */
export const COLLAPSED_ROWS = 8;
/** Widest image, in cells, collapsed and expanded. */
const IMAGE_CELLS = { collapsed: 40, expanded: 80 };

/** Lines of plain output that report an error. */
const ERROR_LINE = /^\s*(Traceback \(most recent call last\)|(\w+\.)*\w*(Error|Exception)\b|error\b|fatal\b|FAILED\b|✗)/i;
/** "typescript:12": the language and the first line number of a file's content. */
const NUMBERED_LANG = /^(.*):(\d+)$/;
const IMAGE = /^!\[([^\]]*)\]\((.+)\)$/;

/** A tool block split into its header line and the Markdown below it. */
export function splitToolBlock(text: string): { mark: string; header: string; body: string } {
	const [first, ...rest] = text.trim().split("\n");
	return { mark: first.slice(0, 1), header: first.slice(1).trim(), body: rest.join("\n").trim() };
}

/** The body's Markdown and images, in order. */
export function bodyParts(body: string): ({ kind: "markdown"; text: string } | { kind: "image"; path: string; alt: string })[] {
	const parts: ({ kind: "markdown"; text: string } | { kind: "image"; path: string; alt: string })[] = [];
	let markdown: string[] = [];
	const flush = () => {
		const text = markdown.join("\n").trim();
		if (text) parts.push({ kind: "markdown", text });
		markdown = [];
	};
	for (const line of body.split("\n")) {
		const image = IMAGE.exec(line.trim());
		if (image) {
			flush();
			parts.push({ kind: "image", alt: image[1], path: image[2] });
		} else markdown.push(line);
	}
	flush();
	return parts;
}

/** Line numbers in front of highlighted lines, from `start`. */
export function numberLines(lines: string[], start: number, dim: (s: string) => string): string[] {
	const width = String(start + lines.length - 1).length;
	return lines.map((line, i) => `${dim(`${String(start + i).padStart(width)} │`)} ${line}`);
}

/** pi's Markdown theme with line numbers for file contents and red error lines in plain output. */
function toolTheme(base: MarkdownTheme, theme: Theme): MarkdownTheme {
	const highlight = base.highlightCode ?? ((code: string) => code.split("\n").map((l) => theme.fg("mdCodeBlock", l)));
	// A prototype keeps the code-block line chat-view gave the theme (a getter).
	const tool = Object.create(base) as MarkdownTheme;
	tool.highlightCode = (code: string, lang?: string) => {
		const numbered = lang ? NUMBERED_LANG.exec(lang) : null;
		if (numbered) return numberLines(highlight(code, numbered[1] || undefined), Number(numbered[2]), (s) => theme.fg("dim", s));
		if (lang) return highlight(code, lang);
		return code.split("\n").map((l) => (ERROR_LINE.test(l) ? theme.fg("error", l) : theme.fg("toolOutput", l)));
	};
	return tool;
}

/**
 * Rows of a component without the empty row a closing code fence leaves, cut
 * after `max` rows with a line saying how to see the rest.
 */
class Collapsed implements Component {
	private readonly child: Component;
	private readonly max: number;
	private readonly hint: (hidden: number) => string;
	constructor(child: Component, max: number, hint: (hidden: number) => string) {
		this.child = child;
		this.max = max;
		this.hint = hint;
	}
	render(width: number): string[] {
		const rows = [...this.child.render(width)];
		while (rows.length > 0 && !rows[rows.length - 1].trim()) rows.pop();
		if (rows.length <= this.max + 1) return rows;
		return [...rows.slice(0, this.max), truncateToWidth(this.hint(rows.length - this.max), width)];
	}
	invalidate(): void {
		this.child.invalidate?.();
	}
}

/** A component drawn behind a prefix. */
class Indented implements Component {
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

/** A line of text. */
const line = (text: string): Component => ({ render: (width) => [truncateToWidth(text, width)], invalidate() {} });

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/** Images by path and width; a new Image for every layout would send the picture to the terminal again. */
const images = new Map<string, Component>();

function image(path: string, alt: string, cells: number, theme: Theme): Component {
	const key = `${path}|${cells}`;
	const cached = images.get(key);
	if (cached) return cached;
	const mime = MIME[extname(path).toLowerCase()];
	let made: Component;
	if (!mime || !existsSync(path)) made = line(theme.fg("dim", `🖼 ${alt} · ${path}${existsSync(path) ? "" : " (gone)"}`));
	else if (!getCapabilities().images) made = line(theme.fg("dim", `🖼 ${alt} · ${path}`));
	else {
		made = new Image(readFileSync(path).toString("base64"), mime, { fallbackColor: (s) => theme.fg("dim", s) }, {
			maxWidthCells: cells,
			filename: path,
		});
	}
	if (images.size > 200) images.delete(images.keys().next().value!);
	images.set(key, made);
	return made;
}

export interface ToolBlockOptions {
	theme: Theme;
	markdownTheme: MarkdownTheme;
	transform: Transform;
	expanded: boolean;
}

/** The components for one tool block: its header and, indented below, its details. */
export function toolBlock(text: string, { theme, markdownTheme, transform, expanded }: ToolBlockOptions): Component[] {
	const { mark, header, body } = splitToolBlock(text);
	const error = mark === "✗";
	const markColour = error ? "error" : mark === "⏺" ? "accent" : "dim";
	const md = (t: string, mdTheme: MarkdownTheme, style?: ConstructorParameters<typeof Markdown>[4]) =>
		new Markdown(t, 0, 0, mdTheme, style, { transform });

	const parts: Component[] = [
		new Indented(md(header, markdownTheme, error ? { color: (t) => theme.fg("error", t) } : undefined), `${theme.fg(markColour, mark)} `),
	];
	if (!body) return parts;

	const bodyTheme = toolTheme(markdownTheme, theme);
	const hint = (hidden: number) =>
		`${theme.fg("dim", `… ${hidden} more ${hidden === 1 ? "line" : "lines"} · click or `)}${keyHint("app.tools.expand", "to expand")}`;
	for (const part of bodyParts(body)) {
		const child =
			part.kind === "image"
				? image(part.path, part.alt, expanded ? IMAGE_CELLS.expanded : IMAGE_CELLS.collapsed, theme)
				: new Collapsed(md(part.text, bodyTheme), expanded ? Number.POSITIVE_INFINITY : COLLAPSED_ROWS, hint);
		parts.push(new Indented(child, "  "));
	}
	return parts;
}
