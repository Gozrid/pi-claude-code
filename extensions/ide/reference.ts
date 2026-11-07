/**
 * The IDE's selection as pi uses it: what the editor's hint shows, the
 * reference Alt+K inserts (the same `@path#L12-30` Claude Code writes) and the
 * context that goes with the next message.
 *
 * The IDEs count lines and characters from 0; everything here shown or sent
 * counts lines from 1.
 */

import { isAbsolute, relative } from "node:path";

/** The editor state an IDE reports with selection_changed. */
export interface IdeSelection {
	filePath: string;
	/** First and last selected line, from 1. Undefined when nothing is selected (only the file is open). */
	lineStart?: number;
	lineEnd?: number;
	/** The selected text. */
	text?: string;
}

interface Position {
	line?: unknown;
	character?: unknown;
}

/** Reads selection_changed's params (VS Code and JetBrains send the same shape). */
export function selectionFromParams(params: unknown): IdeSelection | undefined {
	const p = params as { filePath?: unknown; text?: unknown; selection?: { start?: Position; end?: Position } | null } | undefined;
	if (!p || typeof p.filePath !== "string" || !p.filePath) return undefined;
	const start = p.selection?.start;
	const end = p.selection?.end;
	const text = typeof p.text === "string" ? p.text : "";
	if (!start || !end || typeof start.line !== "number" || typeof end.line !== "number" || !text) return { filePath: p.filePath };
	const empty = start.line === end.line && start.character === end.character;
	if (empty) return { filePath: p.filePath };
	let last = end.line;
	// A selection ending at the start of a line does not take that line.
	if (end.character === 0 && last > start.line) last--;
	return { filePath: p.filePath, lineStart: start.line + 1, lineEnd: last + 1, text };
}

/** Reads at_mentioned's params (Cmd+Alt+K in the IDE); lines from 0 as the IDEs send them. */
export function mentionFromParams(params: unknown): IdeSelection | undefined {
	const p = params as { filePath?: unknown; lineStart?: unknown; lineEnd?: unknown } | undefined;
	if (!p || typeof p.filePath !== "string" || !p.filePath) return undefined;
	if (typeof p.lineStart !== "number" || typeof p.lineEnd !== "number") return { filePath: p.filePath };
	return { filePath: p.filePath, lineStart: p.lineStart + 1, lineEnd: p.lineEnd + 1 };
}

/** The path as the chat shows it: relative to the project when inside it, else absolute. */
export function displayPath(filePath: string, cwd: string): string {
	const rel = relative(cwd, filePath);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : filePath;
}

/** `12-30`, `12`, or undefined without selection. */
function lineRange(sel: IdeSelection): string | undefined {
	if (sel.lineStart === undefined) return undefined;
	const end = sel.lineEnd ?? sel.lineStart;
	return end === sel.lineStart ? `${sel.lineStart}` : `${sel.lineStart}-${end}`;
}

/** The reference Alt+K inserts: `@src/foo.ts#L12-30`, or `@src/foo.ts` for a whole file. */
export function referenceFor(sel: IdeSelection, cwd: string): string {
	const range = lineRange(sel);
	return `@${displayPath(sel.filePath, cwd)}${range ? `#L${range}` : ""}`;
}

/** Inserted text with the spaces it needs around it, like Claude Code does. */
export function insertion(reference: string, before: string): string {
	return `${before && !/\s$/.test(before) ? " " : ""}${reference} `;
}

/** `src/foo.ts:12-30`, or `src/foo.ts` for the open file. */
export function locationLabel(sel: IdeSelection, cwd: string): string {
	const range = lineRange(sel);
	return `${displayPath(sel.filePath, cwd)}${range ? `:${range}` : ""}`;
}

export function lineCount(sel: IdeSelection): number {
	return sel.lineStart === undefined ? 0 : (sel.lineEnd ?? sel.lineStart) - sel.lineStart + 1;
}

/** Selections longer than this go along as a reference only; the model reads the file itself. */
export const MAX_ATTACHED_CHARS = 20_000;

/** What identifies a selection: the same one is sent only once. */
export function selectionKey(sel: IdeSelection): string {
	return `${sel.filePath}\0${sel.lineStart ?? ""}\0${sel.lineEnd ?? ""}\0${sel.text ?? ""}`;
}

/**
 * The context the next message takes along: the selected lines with their text,
 * or the file open in the IDE when nothing is selected.
 */
export function contextFor(sel: IdeSelection, cwd: string, ideName: string): string {
	const path = displayPath(sel.filePath, cwd);
	if (sel.lineStart === undefined) {
		return `<ide_context>The user has ${path} open in ${ideName}. This may or may not be related to the current task.</ide_context>`;
	}
	const lines = sel.lineEnd === sel.lineStart ? `line ${sel.lineStart}` : `lines ${sel.lineStart} to ${sel.lineEnd}`;
	const text = sel.text ?? "";
	if (!text || text.length > MAX_ATTACHED_CHARS) {
		return `<ide_selection>The user selected ${lines} of ${path} in ${ideName} (${text.length} characters, too long to include; read the file for them). This may or may not be related to the current task.</ide_selection>`;
	}
	return `<ide_selection>The user selected ${lines} of ${path} in ${ideName}:\n${text}\n\nThis may or may not be related to the current task.</ide_selection>`;
}
