/**
 * Diffs of Claude's file edits, from the structured results of its edit tools.
 */

import { type FileDiff, fromHunks, type Hunk, simpleDiff } from "../shared/diff.ts";

export const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/**
 * The diff of a finished edit tool call, or undefined when there is nothing to show.
 * `result` is the call's structured result (`tool_use_result`), `input` its arguments.
 */
export function editDiff(name: string, input: any, result: any): FileDiff | undefined {
	if (!EDIT_TOOLS.has(name)) return undefined;
	if (Array.isArray(result?.structuredPatch) && result.structuredPatch.length > 0) {
		return fromHunks(result.structuredPatch as Hunk[]);
	}
	// A new file: its whole content is added.
	const created = result?.type === "create" ? result.content : name === "Write" ? input?.content : undefined;
	if (typeof created === "string") {
		const lines = created.replace(/\n$/, "").split("\n");
		return { lines: lines.map((l) => `+${l}`), added: lines.length, removed: 0 };
	}
	if (name === "Edit" && typeof input?.old_string === "string" && typeof input?.new_string === "string") {
		return simpleDiff(input.old_string, input.new_string);
	}
	if (name === "MultiEdit" && Array.isArray(input?.edits)) {
		const parts = input.edits
			.filter((e: any) => typeof e?.old_string === "string" && typeof e?.new_string === "string")
			.map((e: any) => simpleDiff(e.old_string, e.new_string));
		if (parts.length === 0) return undefined;
		return {
			lines: parts.flatMap((p: FileDiff, i: number) => (i === 0 ? p.lines : ["@@", ...p.lines])),
			added: parts.reduce((n: number, p: FileDiff) => n + p.added, 0),
			removed: parts.reduce((n: number, p: FileDiff) => n + p.removed, 0),
		};
	}
	return undefined;
}
