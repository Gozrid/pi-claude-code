/**
 * What the provider extensions share to follow the transcripts their CLIs
 * write for subagents (see SUBAGENTS_CHANNEL in agent-bus.ts): a reader for
 * files appended line by line, the status of a subagent and its steps.
 *
 * Not an extension itself; pi loads only the entries listed in package.json.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { SubagentStatus, SubagentStep } from "./agent-bus.ts";

/** A subagent that never finished counts as stopped after this long without a step, unless its CLI still runs. */
export const STALE_MS = 2 * 60_000;
/** Steps kept per subagent; the oldest go first (the prompt stays). */
export const MAX_STEPS = 400;
/** Lines and characters of a tool result shown. */
const RESULT_LINES = 3;
const RESULT_CHARS = 400;

/** Status of a subagent: done once its CLI says so; otherwise running while the CLI runs or it was busy lately. */
export function subagentStatus(finished: boolean, lastActive: number, cliRuns: boolean, now: number): SubagentStatus {
	if (finished) return "done";
	return cliRuns || now - lastActive < STALE_MS ? "running" : "stopped";
}

/** A tool result as a step: its first lines. */
export function resultStep(text: string, isError: boolean): SubagentStep {
	const lines = text.split("\n").filter((line) => line.trim());
	const shown = lines.slice(0, RESULT_LINES).join("\n");
	const more = lines.length > RESULT_LINES ? ` … +${lines.length - RESULT_LINES} lines` : "";
	return { kind: "result", text: `${shown.length > RESULT_CHARS ? `${shown.slice(0, RESULT_CHARS)}…` : shown}${more}`, isError };
}

/** Drops the oldest steps beyond MAX_STEPS, keeping the prompt. */
export function trimSteps(steps: SubagentStep[]): void {
	const over = steps.length - MAX_STEPS;
	if (over > 0) steps.splice(steps[0]?.kind === "prompt" ? 1 : 0, over);
}

/**
 * Follows a file a CLI appends JSON lines to: each read returns only the
 * complete lines added since the last one.
 */export class JsonlTail {
	/** Bytes up to the end of the last complete line read. */
	private offset = 0;
	/** ms since the epoch the file last changed; 0 before the first read. */
	mtime = 0;

	readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	/**
	 * The entries added since the last read, parsed; lines that are not JSON are
	 * skipped. `reset` is true when the file was replaced or shortened, so
	 * whatever was built from earlier lines has to start over. Throws when the
	 * file cannot be read.
	 */
	read(): { entries: any[]; reset: boolean } {
		const stat = statSync(this.path);
		this.mtime = stat.mtimeMs;
		let reset = false;
		if (stat.size < this.offset) {
			this.offset = 0;
			reset = true;
		}
		if (stat.size === this.offset) return { entries: [], reset };
		const fd = openSync(this.path, "r");
		let text: string;
		try {
			const buffer = Buffer.alloc(stat.size - this.offset);
			const read = readSync(fd, buffer, 0, buffer.length, this.offset);
			// Only complete lines; an unfinished one (and a character split in it) is read next time.
			const end = buffer.subarray(0, read).lastIndexOf(0x0a) + 1;
			this.offset += end;
			text = buffer.subarray(0, end).toString("utf8");
		} finally {
			closeSync(fd);
		}
		const lines = text.split("\n");
		const entries: any[] = [];
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				entries.push(JSON.parse(line));
			} catch {
				// Not a complete JSON entry.
			}
		}
		return { entries, reset };
	}
}
