/**
 * The way back to the IDE: file references in the chat (`src/foo.ts:12`,
 * `@src/foo.ts#L12-30`) become links that open the file at that line in the
 * connected IDE, and `/ide open` finds the spot for the IDE's openFile tool,
 * which takes a text to look for rather than a line.
 */

import { isAbsolute, resolve } from "node:path";

export interface FileRef {
	path: string;
	line?: number;
	lineEnd?: number;
}

/** `src/foo.ts:12`, `src/foo.ts:12-30`, `src/foo.ts:12:5`, `@src/foo.ts#L12-30`, `src/foo.ts`. */
export function parseFileRef(text: string): FileRef | undefined {
	const match = /^@?([^\s:#`]+?)(?::(\d+)(?:[-:](\d+))?|#L(\d+)(?:-L?(\d+))?)?$/.exec(text.trim());
	if (!match) return undefined;
	const [, path, line, second, hashLine, hashEnd] = match;
	const start = Number(line ?? hashLine) || undefined;
	// `:12:5` is a column, `:12-30` a range.
	const end = hashEnd ? Number(hashEnd) : second && text.includes(`${line}-${second}`) ? Number(second) : undefined;
	return { path, line: start, lineEnd: end };
}

/** URL schemes that open a file at a line, by the name the IDE gives in its lock file. Others get no links. */
export function openUrl(ideName: string, file: string, line?: number): string | undefined {
	const encoded = encodeURI(file);
	const vscode = (scheme: string) => `${scheme}://file${encoded}${line ? `:${line}` : ""}`;
	const jetbrains = (scheme: string) => `${scheme}://open?file=${encodeURIComponent(file)}${line ? `&line=${line}` : ""}`;
	if (/^Visual Studio Code/.test(ideName)) return vscode("vscode");
	if (/^Cursor/.test(ideName)) return vscode("cursor");
	if (/^Windsurf/.test(ideName)) return vscode("windsurf");
	if (/^IntelliJ IDEA/.test(ideName)) return jetbrains("idea");
	if (/^WebStorm/.test(ideName)) return jetbrains("webstorm");
	if (/^PyCharm/.test(ideName)) return jetbrains("pycharm");
	return undefined;
}

/** Does it look like a file path at all (has a folder or an extension)? */
function pathLike(path: string): boolean {
	return /[/\\]/.test(path) || /\.[A-Za-z0-9]{1,8}$/.test(path);
}

const PLAIN_REF = /(?<![\w/.@[(`-])(@?(?:[\w.~-]+\/)*[\w.-]+\.[A-Za-z0-9]{1,8}(?::\d+(?:-\d+)?|#L\d+(?:-L?\d+)?))(?![\w/])/g;

/**
 * Turns the file references in Markdown into links: code spans holding a
 * reference, and `path:line` / `@path#L12` in plain text. Fenced code and
 * existing links stay as they are. `link` gives the URL, or undefined for
 * references to leave alone (e.g. files that do not exist).
 */
export function linkFileReferences(markdown: string, link: (ref: FileRef) => string | undefined): string {
	const out: string[] = [];
	let fence: string | undefined;
	for (const line of markdown.split("\n")) {
		const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence) {
			if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
			out.push(line);
			continue;
		}
		if (marker) {
			fence = marker;
			out.push(line);
			continue;
		}
		out.push(linkLine(line, link));
	}
	return out.join("\n");
}

function linkLine(line: string, link: (ref: FileRef) => string | undefined): string {
	// Code spans, existing links and autolinks stay whole; only the text between them is searched.
	const parts = line.split(/(`+[^`]*`+|\[[^\]]*\]\([^)]*\)|<[a-z]+:[^>]*>|https?:\/\/\S+)/i);
	return parts
		.map((part, i) => {
			if (i % 2 === 1) {
				const code = /^(`+)([^`]+)\1$/.exec(part);
				if (!code) return part;
				const ref = parseFileRef(code[2]);
				if (!ref || !pathLike(ref.path)) return part;
				const url = link(ref);
				return url ? `[${part}](${url})` : part;
			}
			return part.replace(PLAIN_REF, (whole) => {
				const ref = parseFileRef(whole);
				const url = ref && link(ref);
				return url ? `[${whole}](${url})` : whole;
			});
		})
		.join("");
}

/** The absolute path of a reference, relative ones from pi's folder; `~` is home. */
export function absolutePath(path: string, cwd: string, home: string): string {
	if (path === "~" || path.startsWith("~/")) return home + path.slice(1);
	return isAbsolute(path) ? path : resolve(cwd, path);
}

/**
 * The text openFile looks for to land on `line` (from 1): from the start of that
 * line (or the next one with text), as many lines as it takes to be found there first.
 */
export function anchorFor(content: string, line: number): string | undefined {
	const lines = content.split("\n");
	let first = Math.min(Math.max(line, 1), lines.length) - 1;
	while (first < lines.length && !lines[first].trim()) first++;
	if (first >= lines.length) return undefined;
	const offset = lines.slice(0, first).reduce((sum, l) => sum + l.length + 1, 0);
	for (let last = first; last < lines.length; last++) {
		const candidate = lines.slice(first, last + 1).join("\n");
		if (content.indexOf(candidate) === offset) return candidate;
	}
	return undefined;
}
