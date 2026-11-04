/**
 * The subagents of the current Claude Code session, for the subagents
 * extension (SUBAGENTS_CHANNEL).
 *
 * In print mode Claude streams only the parent's Agent tool call, not what the
 * subagent does, and a background subagent keeps working after the call has
 * returned. So this reads what Claude Code writes for each subagent instead:
 *
 *   <config dir>/projects/<cwd slug>/<session id>/subagents/
 *     agent-<id>.jsonl      its transcript, appended as it works
 *     agent-<id>.meta.json  description, agent type, finished flag
 *
 * SubagentWatcher polls that folder and reads only what each transcript gained
 * since the last poll.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Subagent, SubagentStep } from "../shared/agent-bus.ts";
import { JsonlTail, resultStep, subagentStatus, trimSteps } from "../shared/subagent-files.ts";
import { summarizeToolInput, toolResultText } from "./stream.ts";

/** The folder name Claude Code gives a project: every character but letters and digits becomes "-". */
export const projectSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");

/**
 * The subagents folder of a Claude session: under the project's slug, or,
 * where Claude shortened a long path, under whichever project has the session.
 */
export function subagentsDir(projectsDir: string, cwd: string, sessionId: string): string {
	const guess = join(projectsDir, projectSlug(cwd), sessionId);
	if (!existsSync(guess)) {
		try {
			const found = readdirSync(projectsDir).find((project) => existsSync(join(projectsDir, project, sessionId)));
			if (found) return join(projectsDir, found, sessionId, "subagents");
		} catch {
			// No projects folder yet.
		}
	}
	return join(guess, "subagents");
}

/** What a transcript has shown so far. */
export interface Transcript {
	steps: SubagentStep[];
	startedAt?: number;
	lastAt?: number;
	lastTool?: { name: string; detail?: string };
	/** Ids of the hand-back calls read so far, whose results are skipped. */
	handbacks?: Set<string>;
}

/** The tool a subagent hands its final report back with; its `message` is the subagent's output. */
const HANDBACK = "SubagentHandback";

/** Adds the steps of transcript entries to `into`. */
export function readTranscript(entries: any[], into: Transcript): void {
	for (const entry of entries) {
		if (entry?.type !== "user" && entry?.type !== "assistant") continue;
		const at = Date.parse(entry.timestamp ?? "");
		if (Number.isFinite(at)) {
			into.startedAt ??= at;
			into.lastAt = at;
		}
		const content = entry.message?.content;
		const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
		for (const block of blocks) {
			if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
				// The prompt is the first entry; later user text is Claude's own bookkeeping.
				if (entry.type === "assistant") into.steps.push({ kind: "text", text: block.text.trim() });
				else if (into.steps.length === 0) into.steps.push({ kind: "prompt", text: block.text.trim() });
			} else if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
				into.steps.push({ kind: "thinking", text: block.thinking.trim() });
			} else if (block?.type === "tool_use" && block.name === HANDBACK && typeof block.input?.message === "string") {
				// The report itself, shown as the subagent's text rather than as a tool call.
				(into.handbacks ??= new Set()).add(String(block.id));
				if (block.input.message.trim()) into.steps.push({ kind: "text", text: block.input.message.trim() });
			} else if (block?.type === "tool_use") {
				const detail = summarizeToolInput(block.input) || undefined;
				into.lastTool = { name: String(block.name), detail };
				into.steps.push({ kind: "tool", name: String(block.name), detail });
			} else if (block?.type === "tool_result" && into.handbacks?.has(String(block.tool_use_id))) {
				// Claude's receipt for the hand-back.
			} else if (block?.type === "tool_result") {
				into.steps.push(resultStep(toolResultText(block.content), !!block.is_error));
			}
		}
	}
	trimSteps(into.steps);
}

interface AgentFile extends Transcript {
	id: string;
	tail: JsonlTail;
	meta: { description?: string; agentType?: string; finished?: boolean };
}

/**
 * Follows the subagents folder of one session; `poll` reads what changed and
 * returns the subagents when anything did, otherwise undefined.
 */
export class SubagentWatcher {
	private dir: string | undefined;
	private files = new Map<string, AgentFile>();
	private signature: string | undefined;

	poll(dir: string | undefined, cliRuns: boolean, now = Date.now()): Subagent[] | undefined {
		if (dir !== this.dir) {
			this.dir = dir;
			this.files.clear();
		}
		if (dir) this.read(dir);
		const agents = [...this.files.values()].map(
			(file): Subagent => ({
				id: file.id,
				description: file.meta.description || file.id,
				type: file.meta.agentType,
				status: subagentStatus(!!file.meta.finished, Math.max(file.tail.mtime, file.lastAt ?? 0), cliRuns, now),
				startedAt: file.startedAt,
				lastAt: file.lastAt,
				lastTool: file.lastTool,
				steps: file.steps,
			}),
		);
		const signature = JSON.stringify(agents.map((a) => [a.id, a.status, a.description, a.steps.length]));
		if (signature === this.signature) return undefined;
		this.signature = signature;
		return agents;
	}

	private read(dir: string): void {
		let names: string[];
		try {
			names = readdirSync(dir).filter((name) => /^agent-.+\.jsonl$/.test(name));
		} catch {
			return;
		}
		for (const name of names) {
			const id = name.slice("agent-".length, -".jsonl".length);
			let file = this.files.get(id);
			if (!file) {
				file = { id, tail: new JsonlTail(join(dir, name)), steps: [], meta: {} };
				this.files.set(id, file);
			}
			if (!file.meta.finished) {
				try {
					file.meta = JSON.parse(readFileSync(join(dir, `agent-${id}.meta.json`), "utf8"));
				} catch {
					// Written a moment after the transcript.
				}
			}
			try {
				const { entries, reset } = file.tail.read();
				if (reset) Object.assign(file, { steps: [], startedAt: undefined, lastAt: undefined, lastTool: undefined, handbacks: undefined });
				readTranscript(entries, file);
			} catch {
				// Removed or unreadable meanwhile; tried again next time.
			}
		}
	}
}
