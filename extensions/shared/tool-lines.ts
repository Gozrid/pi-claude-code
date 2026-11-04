/**
 * The blocks a CLI provider writes into the answer for the tools its CLI runs.
 * Each call and each result is one text block: a header line, then the details
 * as Markdown (code, output, diff, table, image) below it:
 *   ⏺ **Bash** Run the tests
 *
 *   ```bash
 *   npm test
 *   ```
 *   ⎿ 12 lines
 *
 *   ```
 *   …
 *   ```
 *   ✗ `command not found`
 * chat-view groups these blocks under one heading, shows the details collapsed
 * and chat-crab tells them from the answer, so every provider writes them the
 * same way. They are only for the chat: the CLI keeps the real tool results.
 *
 * Not an extension itself; pi loads only the entries listed in package.json.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { truncate } from "./format.ts";

/** Most lines and characters of a tool's input or output kept in the chat; the rest is cut. */
const MAX_LINES = 300;
const MAX_CHARS = 30_000;
/** Output up to this long stays in the header line, without details below. */
const INLINE_CHARS = 120;
/** Most columns of a table made from a JSON list. */
const MAX_COLUMNS = 6;

/** Inline code that survives backticks and line breaks in `s`. */
export function codeSpan(s: string): string {
	const oneLine = s.replace(/\s*\n\s*/g, " ⏎ ");
	const ticks = "`".repeat((oneLine.match(/`+/g) ?? []).reduce((n, t) => Math.max(n, t.length), 0) + 1);
	return `${ticks} ${oneLine} ${ticks}`;
}

/** A fenced block whose fence is longer than any backtick run in `body`. */
export function fence(body: string, lang = ""): string {
	const longest = (body.match(/`+/g) ?? []).reduce((n, t) => Math.max(n, t.length), 0);
	const ticks = "`".repeat(Math.max(3, longest + 1));
	return `${ticks}${lang}\n${body}\n${ticks}`;
}

/** Text that Markdown shows as written. */
const plain = (s: string) => s.replace(/\s*\n\s*/g, " ").replace(/([\\`*_[\]<>#|~])/g, "\\$1");

/** At most MAX_LINES lines and MAX_CHARS characters, with a note on what was cut. */
function cap(text: string): string {
	let lines = text.split("\n");
	let cut = 0;
	if (lines.length > MAX_LINES) {
		cut = lines.length - MAX_LINES;
		lines = lines.slice(0, MAX_LINES);
	}
	let out = lines.join("\n");
	if (out.length > MAX_CHARS) {
		const kept = out.slice(0, MAX_CHARS);
		cut += out.split("\n").length - kept.split("\n").length + 1;
		out = kept.slice(0, kept.lastIndexOf("\n") > 0 ? kept.lastIndexOf("\n") : MAX_CHARS);
	}
	return cut > 0 ? `${out}\n… ${cut} more lines` : out;
}

// =============================================================================
// Tool names
// =============================================================================

/** How some MCP servers write their names. */
const SERVER_NAMES: Record<string, string> = {
	freecad: "FreeCAD",
	github: "GitHub",
	gitlab: "GitLab",
	pi: "pi",
	figma: "Figma",
	blender: "Blender",
	playwright: "Playwright",
};

/** "mcp__freecad__execute_code" → { server: "FreeCAD", tool: "execute_code" } */
export function mcpTool(name: string): { server: string; tool: string } | undefined {
	const m = /^mcp__(.+?)__(.+)$/.exec(name);
	if (!m) return undefined;
	const raw = m[1].replace(/^claude_ai_/, "");
	const server = SERVER_NAMES[raw.toLowerCase()] ?? raw.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
	return { server, tool: m[2] };
}

/** "FreeCAD › execute_code", or the tool's own name. */
export function toolTitle(name: string): string {
	const mcp = mcpTool(name);
	return mcp ? `${mcp.server} › ${mcp.tool}` : name;
}

// =============================================================================
// Calls
// =============================================================================

/** Keys of an MCP call's arguments that name what it works on, in order of preference. */
const SUBJECT_KEYS = [
	"doc_name",
	"document",
	"obj_name",
	"object_name",
	"name",
	"label",
	"view_name",
	"file_path",
	"path",
	"url",
	"query",
	"title",
	"id",
];

/** Keys holding source code, shown as a code block. */
const CODE_KEYS = new Set(["code", "script", "source", "python", "sql", "command"]);

/** The language of the code in an argument, for highlighting. */
function codeLanguage(key: string, server: string | undefined, args: Record<string, unknown>): string {
	const named = args.language ?? args.lang;
	if (typeof named === "string") return named.toLowerCase();
	if (key === "sql") return "sql";
	if (key === "command") return "bash";
	if (key === "python" || /freecad|blender|python|jupyter/i.test(server ?? "")) return "python";
	return "";
}

/** "⏺ **Bash** summary" */
export function toolCallLine(name: string, summary?: string): string {
	return `⏺ **${toolTitle(name)}**${summary ? ` ${codeSpan(summary)}` : ""}`;
}

/** Arguments without the keys already shown, pretty-printed, or "" when none are left. */
function restJson(input: Record<string, unknown>, shown: Set<string>): string {
	const rest = Object.fromEntries(Object.entries(input).filter(([k, v]) => !shown.has(k) && v !== undefined));
	return Object.keys(rest).length > 0 ? fence(cap(JSON.stringify(rest, null, 2)), "json") : "";
}

/** A Read call's range, e.g. "lines 10–59". */
function lineRange(input: Record<string, unknown>): string {
	const offset = Number(input.offset);
	const limit = Number(input.limit);
	if (!offset && !limit) return "";
	const from = offset || 1;
	return limit ? `lines ${from}–${from + limit - 1}` : `from line ${from}`;
}

/**
 * The block for a tool call: the tool and what it works on in the header, code
 * and further arguments below it. Knows the arguments of Claude Code's tools
 * and of MCP tools; `summary` replaces the header text for other tools.
 */
export function toolCallBlock(name: string, input: unknown, cwd: string, summary?: string): string {
	const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
	const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : undefined);
	const title = `⏺ **${toolTitle(name)}**`;
	const block = (header: string, ...body: string[]) => [header, ...body.filter(Boolean)].join("\n\n");
	const path = str("file_path") ?? str("notebook_path") ?? str("path");

	const mcp = mcpTool(name);
	if (mcp) {
		const shown = new Set<string>();
		const subject = SUBJECT_KEYS.filter((k) => typeof args[k] === "string" || typeof args[k] === "number")
			.slice(0, 2)
			.map((k) => {
				shown.add(k);
				return k.endsWith("path") ? displayPath(String(args[k]), cwd) : String(args[k]);
			});
		const code = Object.entries(args).filter(
			([k, v]) => typeof v === "string" && (CODE_KEYS.has(k) || (v.includes("\n") && v.length > 80)),
		) as [string, string][];
		for (const [k] of code) shown.add(k);
		for (const k of ["language", "lang"]) if (code.length > 0 && typeof args[k] === "string") shown.add(k);
		const head = subject.length > 0 ? `${title} ${codeSpan(truncate(subject.join(" · "), 120))}` : title;
		return block(head, ...code.map(([k, v]) => fence(cap(v.replace(/\n+$/, "")), codeLanguage(k, mcp.server, args))), restJson(args, shown));
	}

	switch (name) {
		case "Bash": {
			const command = str("command") ?? "";
			const description = str("description");
			if (!description && !command.includes("\n") && command.length <= 80) return block(`${title} ${codeSpan(command)}`);
			const background = args.run_in_background ? " · in the background" : "";
			return block(`${title} ${plain(truncate(description ?? command.split("\n")[0], 120))}${background}`, fence(cap(command), "bash"));
		}
		case "Read": {
			const range = lineRange(args);
			return block(`${title} ${codeSpan(displayPath(path ?? "", cwd))}${range ? ` · ${range}` : ""}`);
		}
		case "Edit":
		case "MultiEdit":
		case "Write":
		case "NotebookEdit":
			return block(`${title} ${codeSpan(displayPath(path ?? "", cwd))}`);
		case "Grep":
		case "Glob": {
			const where = path ? ` in ${codeSpan(displayPath(path, cwd))}` : "";
			const glob = str("glob") ? ` · ${codeSpan(str("glob")!)}` : "";
			return block(`${title} ${codeSpan(str("pattern") ?? "")}${where}${glob}`);
		}
		case "Agent":
		case "Task": {
			const prompt = str("prompt");
			const kind = str("subagent_type") ? ` · ${str("subagent_type")}` : "";
			return block(`${title} ${plain(truncate(str("description") ?? "", 120))}${kind}`, prompt ? fence(cap(prompt), "markdown") : "");
		}
	}

	const pick = summary ?? str("url") ?? str("query") ?? path ?? str("pattern") ?? str("description") ?? str("prompt");
	if (typeof pick === "string") {
		const shown = new Set(["url", "query", "file_path", "notebook_path", "path", "pattern", "description", "prompt"]);
		const head = `${title}${pick ? ` ${codeSpan(truncate(displayPath(pick, cwd), 160))}` : ""}`;
		return block(head, summary === undefined ? restJson(args, shown) : "");
	}
	const json = JSON.stringify(args);
	if (json === "{}") return title;
	return json.length <= 80 ? block(`${title} ${codeSpan(json)}`) : block(title, restJson(args, new Set()));
}

// =============================================================================
// Results
// =============================================================================

/** The first non-empty line of a tool's output, with the number of lines after it. */
export function summarizeText(text: string): string {
	const lines = text.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length === 0) return "(no output)";
	const first = truncate(lines[0].trim(), 160);
	return lines.length > 1 ? `${first} (+${lines.length - 1} lines)` : first;
}

/** "⎿ `first line (+3 lines)`", or with ✗ for a failed call. */
export function toolResultLine(text: string, isError = false): string {
	return `${isError ? "✗" : "⎿"} ${codeSpan(summarizeText(text))}`;
}

const isPlainValue = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);

/** A list of objects as a Markdown table, or undefined when it does not make one. */
export function jsonTable(value: unknown): string | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	if (!value.every((row) => row && typeof row === "object" && !Array.isArray(row))) return undefined;
	const rows = value as Record<string, unknown>[];
	const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
	// Plain values first: they read best in a cell.
	const plainKeys = keys.filter((k) => rows.every((r) => r[k] === undefined || isPlainValue(r[k])));
	if (plainKeys.length === 0) return undefined;
	const columns = [...plainKeys, ...keys.filter((k) => !plainKeys.includes(k))].slice(0, MAX_COLUMNS);
	const cell = (v: unknown) =>
		v === undefined
			? ""
			: truncate(isPlainValue(v) ? String(v) : JSON.stringify(v), 40)
					.replace(/\s*\n\s*/g, " ")
					.replace(/([\\|`*_])/g, "\\$1");
	const hidden = keys.length - columns.length;
	return [
		`| ${columns.join(" | ")} |`,
		`|${columns.map(() => " --- ").join("|")}|`,
		...rows.slice(0, MAX_LINES).map((r) => `| ${columns.map((k) => cell(r[k])).join(" | ")} |`),
		...(rows.length > MAX_LINES ? [`\n… ${rows.length - MAX_LINES} more rows`] : []),
		...(hidden > 0 ? [`\n${hidden} more ${hidden === 1 ? "field" : "fields"} per row not shown`] : []),
	].join("\n");
}

/** "1 line", "12 lines" */
const lineCount = (n: number) => (n === 1 ? "1 line" : `${n} lines`);

/** Lines as Claude's Read tool returns them: "    12→code" or "    12\tcode". */
const NUMBERED = /^\s*(\d+)(?:→|\t)(.*)$/;

/** A file's text without the line numbers Claude's Read tool puts in front, and where it starts. */
export function numberedText(text: string): { content: string; startLine: number } | undefined {
	const lines = text.replace(/\n+$/, "").split("\n");
	const matches = lines.map((l) => NUMBERED.exec(l));
	if (matches.length === 0 || matches.some((m) => !m)) return undefined;
	const start = Number(matches[0]![1]);
	if (matches.some((m, i) => Number(m![1]) !== start + i)) return undefined;
	return { content: matches.map((m) => m![2]).join("\n"), startLine: start };
}

export interface ResultOptions {
	isError?: boolean;
	/** The tool's name, when the result does not follow its call directly. */
	name?: string;
	/** A file's content: highlighted after its path, with line numbers from `startLine` (or the tool's own numbers). */
	file?: { path: string; startLine?: number };
	/** Images of the result, as file paths. */
	images?: string[];
}

/**
 * The block for a tool's result: a short header and the output below it, as a
 * table (list of objects), indented JSON, a file with line numbers or plain text.
 */
export function toolResultBlock(text: string, options: ResultOptions = {}): string {
	const mark = options.isError ? "✗" : "⎿";
	const who = options.name ? `**${toolTitle(options.name)}** · ` : "";
	const images = (options.images ?? []).map((path, i) => `![image ${i + 1}](${path})`);
	const out = text.replace(/\s+$/, "").replace(/^\s*\n/, "");
	const lines = out.split("\n");
	const block = (header: string, body = "") => [`${mark} ${who}${header}`, body, ...images].filter(Boolean).join("\n\n");
	const imageNote = images.length === 1 ? "1 image" : images.length > 1 ? `${images.length} images` : "";

	if (!out.trim()) return block(imageNote || "(no output)");

	if (options.file && !options.isError) {
		// Without a start line the text comes numbered by the tool.
		const numbered = options.file.startLine === undefined ? numberedText(out) : undefined;
		const content = numbered?.content ?? out;
		const start = options.file.startLine ?? numbered?.startLine ?? 1;
		const lang = getLanguageFromPath(options.file.path) ?? "";
		return block(lineCount(content.split("\n").length), fence(cap(content), `${lang}:${start}`));
	}

	const trimmed = out.trim();
	if (/^[[{]/.test(trimmed)) {
		try {
			const value = JSON.parse(trimmed);
			const table = jsonTable(value);
			if (table) {
				const n = (value as unknown[]).length;
				return block(n === 1 ? "1 entry" : `${n} entries`, table);
			}
			if (value && typeof value === "object") {
				const keys = Array.isArray(value) ? `${value.length} items` : lineCount(JSON.stringify(value, null, 2).split("\n").length);
				return block(`JSON · ${keys}`, fence(cap(JSON.stringify(value, null, 2)), "json"));
			}
		} catch {}
	}

	// A failure's first line says what went wrong, as text the chat can colour; the rest follows below.
	if (options.isError) return block(plain(truncate(lines[0].trim(), INLINE_CHARS)), lines.length > 1 ? fence(cap(out)) : "");
	if (lines.length === 1 && out.length <= INLINE_CHARS) return block(codeSpan(out.trim()));
	return block([lineCount(lines.length), imageNote].filter(Boolean).join(" · "), fence(cap(out)));
}

/** Saves an image of a tool result in `dir`/images for the chat to show; returns its path. */
export function saveToolImage(dir: string, base64: string, mimeType: string): string | undefined {
	try {
		const ext = (mimeType.split("/")[1] ?? "png").replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "");
		const name = `${createHash("sha1").update(base64).digest("hex").slice(0, 16)}.${ext}`;
		const images = join(dir, "images");
		mkdirSync(images, { recursive: true });
		const path = join(images, name);
		writeFileSync(path, Buffer.from(base64, "base64"));
		return path;
	} catch {
		return undefined;
	}
}

/** A tool block reduced to its header line, for transcripts the model reads again. */
export function toolBlockHeader(text: string): string {
	return text.split("\n")[0];
}

/** A path relative to the working directory when it lies inside it. */
export function displayPath(path: string, cwd: string): string {
	return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}
