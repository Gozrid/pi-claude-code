/**
 * Diffs of a CLI's file edits as Markdown `diff` blocks, which pi colours like
 * its own edit tool (added green, removed red).
 *
 * Not an extension itself; pi loads only the entries listed in package.json.
 */

/** Longest diff shown in the chat; the rest is summarized. */
const MAX_LINES = 40;

export interface Hunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: string[];
}

export interface FileDiff {
	/** Lines of the diff block, without the fence. */
	lines: string[];
	added: number;
	removed: number;
}

export function fromHunks(hunks: Hunk[]): FileDiff {
	const lines: string[] = [];
	let added = 0;
	let removed = 0;
	for (const hunk of hunks) {
		lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
		for (const line of hunk.lines) {
			if (line.startsWith("+")) added++;
			else if (line.startsWith("-")) removed++;
			lines.push(line);
		}
	}
	return { lines, added, removed };
}

/** A plain old → new diff for when the CLI sent no patch: shared lines at both ends stay as context. */
export function simpleDiff(oldText: string, newText: string): FileDiff {
	const before = oldText.split("\n");
	const after = newText.split("\n");
	let head = 0;
	while (head < before.length && head < after.length && before[head] === after[head]) head++;
	let tail = 0;
	while (
		tail < before.length - head &&
		tail < after.length - head &&
		before[before.length - 1 - tail] === after[after.length - 1 - tail]
	)
		tail++;
	const removed = before.slice(head, before.length - tail);
	const added = after.slice(head, after.length - tail);
	return {
		lines: [
			...before.slice(0, head).map((l) => ` ${l}`),
			...removed.map((l) => `-${l}`),
			...added.map((l) => `+${l}`),
			...before.slice(before.length - tail).map((l) => ` ${l}`),
		],
		added: added.length,
		removed: removed.length,
	};
}

/**
 * The diff of a whole file before and after an edit, with `context` unchanged
 * lines around the change; `before` undefined means the file was created.
 */
export function fileDiff(before: string | undefined, after: string, context = 3): FileDiff | undefined {
	if (before === undefined) {
		const lines = after.replace(/\n$/, "").split("\n");
		return { lines: lines.map((l) => `+${l}`), added: lines.length, removed: 0 };
	}
	if (before === after) return undefined;
	const diff = simpleDiff(before, after);
	const first = diff.lines.findIndex((l) => !l.startsWith(" "));
	const last = diff.lines.length - 1 - [...diff.lines].reverse().findIndex((l) => !l.startsWith(" "));
	return { ...diff, lines: diff.lines.slice(Math.max(0, first - context), last + 1 + context) };
}

/** "+3 −1" */
export function diffStats(diff: FileDiff): string {
	return [diff.added > 0 ? `+${diff.added}` : "", diff.removed > 0 ? `−${diff.removed}` : ""].filter(Boolean).join(" ");
}

/** A fenced `diff` block, cut after MAX_LINES lines. */
export function diffBlock(diff: FileDiff): string {
	const shown = diff.lines.slice(0, MAX_LINES);
	const rest = diff.lines.length - shown.length;
	// A fence longer than any backtick run inside keeps the block closed.
	const longest = shown.reduce((n, l) => Math.max(n, (l.match(/`+/g) ?? []).reduce((m, t) => Math.max(m, t.length), 0)), 0);
	const fence = "`".repeat(Math.max(3, longest + 1));
	return [`${fence}diff`, ...shown, ...(rest > 0 ? [`… ${rest} more lines`] : []), fence].join("\n");
}
