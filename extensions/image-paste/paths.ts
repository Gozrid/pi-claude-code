/**
 * Image paths in a prompt (logic of image-paste)
 *
 * Finds the paths of image files in the text, the way they get there: pasted
 * with Ctrl+V (pi writes a clipboard image to a temp file and pastes its path),
 * dragged into the terminal (spaces escaped as "\ "), quoted, as file:// URL or
 * typed with ~. Paths with plain spaces count as well, as long as the file exists.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export interface FoundPath {
	/** Where the path stands in the text, quotes and file:// included. */
	start: number;
	end: number;
	/** The file it names. */
	path: string;
}

const IMAGE_END = /\.(?:png|jpe?g|gif|webp)(?=$|[\s'"`)\]>,;:!?]|\.(?:\s|$))/gi;
/** How far back a path may begin before its extension. */
const MAX_LENGTH = 1024;

const opensPath = (char: string | undefined) => char === undefined || /[\s'"`(\[<]/.test(char);

/** The files a stretch of text may mean: unescaped, ~ expanded, macOS's narrow space before AM/PM. */
function candidates(raw: string, home: string): string[] {
	const out = new Set<string>();
	const add = (p: string) => {
		const expanded = p.startsWith("~/") ? join(home, p.slice(2)) : p;
		out.add(expanded);
		out.add(expanded.replace(/ (AM|PM)(?=\.)/g, " $1"));
	};
	if (raw.startsWith("file://")) {
		try {
			add(decodeURIComponent(raw.slice("file://".length)));
		} catch {}
		return [...out];
	}
	add(raw.replace(/\\(.)/g, "$1"));
	add(raw);
	return [...out];
}

/** The image files named in `text`, in order; `isImage` says whether a path is one. */
export function findImagePaths(text: string, isImage: (path: string) => boolean, home = homedir()): FoundPath[] {
	const found: FoundPath[] = [];
	for (const match of text.matchAll(IMAGE_END)) {
		const end = match.index + match[0].length;
		const floor = Math.max(found.at(-1)?.end ?? 0, end - MAX_LENGTH);
		// Nearest start first: the shortest path that exists.
		for (let start = match.index; start >= floor; start--) {
			const fileUrl = text.startsWith("file://", start);
			if (!fileUrl && !(text[start] === "/" || (text[start] === "~" && text[start + 1] === "/"))) continue;
			if (!opensPath(text[start - 1])) continue;
			const path = candidates(text.slice(start, end), home).find(isImage);
			if (!path) continue;
			const quote = text[start - 1];
			const quoted = (quote === "'" || quote === '"') && text[end] === quote;
			found.push({ start: quoted ? start - 1 : start, end: quoted ? end + 1 : end, path });
			break;
		}
	}
	return found;
}

/** The text with a note after each path saying which attached image it is. */
export function markAttached(text: string, found: FoundPath[], numberOf: (path: string) => number): string {
	let out = "";
	let at = 0;
	for (const f of found) {
		out += `${text.slice(at, f.end)} [image ${numberOf(f.path)} attached]`;
		at = f.end;
	}
	return out + text.slice(at);
}
