/**
 * The subagents of the current agy conversation, for the subagents extension
 * (SUBAGENTS_CHANNEL).
 *
 * agy runs each subagent (`invoke_subagent`) in a conversation of its own and
 * keeps, under the conversation that started it:
 *   <brain>/<conversation>/.system_generated/subagents/<subagent>.json
 *     {"conversationId", "subagentDescriptor": {"typeName", "role"}, "state", "spawnStepIndex"}
 *   <brain>/<conversation>/.system_generated/messages/…json
 *     messages to the conversation, e.g. 'Subagent "<id>" has been explicitly canceled …'
 * The subagent's steps are in its own transcript,
 *   <brain>/<subagent>/.system_generated/logs/transcript.jsonl
 * where the task arrives as a SYSTEM_MESSAGE from the parent, model steps
 * (PLANNER_RESPONSE) list their tool calls and the results follow as GENERIC
 * steps. A model step without tool calls ends its turn: the subagent is done
 * (its `state` stays SUBAGENT_STATE_ALIVE, waiting for more messages).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Subagent, SubagentStep } from "../shared/agent-bus.ts";
import { JsonlTail, resultStep, subagentStatus, trimSteps } from "../shared/subagent-files.ts";
import { toolDetail, toolName } from "./stream.ts";

const generated = (brain: string, conversationId: string) => join(brain, conversationId, ".system_generated");
export const transcriptPath = (brain: string, conversationId: string) => join(generated(brain, conversationId), "logs", "transcript.jsonl");

/** agy writes tool arguments JSON-encoded ("\"ls\""); the plain values. */
export function decodeArgs(args: unknown): Record<string, unknown> {
	if (!args || typeof args !== "object") return {};
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		if (typeof value === "string" && /^["{[]/.test(value)) {
			try {
				out[key] = JSON.parse(value);
				continue;
			} catch {}
		}
		out[key] = value;
	}
	return out;
}

/** A result step without the "Created At: …" lines agy puts first. */
const resultBody = (content: unknown) =>
	(typeof content === "string" ? content : content == null ? "" : JSON.stringify(content))
		.split("\n")
		.filter((line) => !/^(Created|Completed) At: /.test(line))
		.join("\n")
		.trim();

/** The text of a message to the subagent: `[Message] … content=<text>` inside agy's SYSTEM_MESSAGE wrapper. */
export function messageText(content: unknown): string | undefined {
	if (typeof content !== "string") return undefined;
	const match = content.match(/\bcontent=([\s\S]*?)\s*(?:<\/SYSTEM_MESSAGE>|$)/);
	return match?.[1].trim() || undefined;
}

/** What a subagent's transcript has shown so far. */
export interface AgyTranscript {
	steps: SubagentStep[];
	startedAt?: number;
	lastAt?: number;
	lastTool?: { name: string; detail?: string };
	/** The last model step ended the turn (no tool calls). */
	turnOver: boolean;
}

/** Adds the steps of a subagent's transcript entries to `into`. */
export function readAgyTranscript(entries: any[], into: AgyTranscript): void {
	for (const entry of entries) {
		const time = Date.parse(entry?.created_at ?? "");
		if (Number.isFinite(time)) {
			into.startedAt ??= time;
			into.lastAt = time;
		}
		if (entry?.type === "SYSTEM_MESSAGE" || entry?.type === "USER_INPUT") {
			// The task, and later messages from the parent; agy's own notices carry no content= part.
			const text = entry.type === "USER_INPUT" ? String(entry.content ?? "").trim() : messageText(entry.content);
			if (text) {
				into.steps.push({ kind: "prompt", text });
				into.turnOver = false;
			}
		} else if (entry?.type === "PLANNER_RESPONSE") {
			if (typeof entry.content === "string" && entry.content.trim()) into.steps.push({ kind: "text", text: entry.content.trim() });
			const calls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
			for (const call of calls) {
				const name = toolName(String(call?.name ?? "tool"));
				const detail = toolDetail(decodeArgs(call?.args)) || undefined;
				into.lastTool = { name, detail };
				into.steps.push({ kind: "tool", name, detail });
			}
			into.turnOver = calls.length === 0;
		} else if (entry?.type === "GENERIC") {
			into.steps.push(resultStep(resultBody(entry.content), entry.status === "ERROR"));
		}
	}
	trimSteps(into.steps);
}

interface AgyAgent extends AgyTranscript {
	id: string;
	tail: JsonlTail;
	record: { subagentDescriptor?: { typeName?: string; role?: string }; state?: string };
}

/**
 * Follows the subagents of one agy conversation; `poll` returns them when
 * anything changed, otherwise undefined.
 */
export class AgySubagentWatcher {
	private readonly brain: string;
	private conversationId: string | undefined;
	private agents = new Map<string, AgyAgent>();
	/** Subagents agy reported as canceled, and the message files already read. */
	private canceled = new Set<string>();
	private messages = new Set<string>();
	private signature: string | undefined;

	constructor(brain: string) {
		this.brain = brain;
	}

	poll(conversationId: string | undefined, cliRuns: boolean, now = Date.now()): Subagent[] | undefined {
		if (conversationId !== this.conversationId) {
			this.conversationId = conversationId;
			this.agents.clear();
			this.canceled.clear();
			this.messages.clear();
		}
		if (conversationId) this.read(generated(this.brain, conversationId));
		const subagents = [...this.agents.values()].map((agent): Subagent => {
			const state = agent.record.state;
			const finished = agent.turnOver || (!!state && state !== "SUBAGENT_STATE_ALIVE");
			return {
				id: agent.id,
				description: agent.record.subagentDescriptor?.role || agent.id,
				type: agent.record.subagentDescriptor?.typeName,
				status: this.canceled.has(agent.id) && !finished ? "stopped" : subagentStatus(finished, Math.max(agent.tail.mtime, agent.lastAt ?? 0), cliRuns, now),
				startedAt: agent.startedAt,
				lastAt: agent.lastAt,
				lastTool: agent.lastTool,
				steps: agent.steps,
			};
		});
		const signature = JSON.stringify(subagents.map((a) => [a.id, a.status, a.description, a.steps.length]));
		if (signature === this.signature) return undefined;
		this.signature = signature;
		return subagents;
	}

	private read(dir: string): void {
		let records: string[] = [];
		try {
			records = readdirSync(join(dir, "subagents")).filter((name) => name.endsWith(".json"));
		} catch {
			// No subagents yet.
		}
		for (const name of records) {
			const id = name.slice(0, -".json".length);
			let agent = this.agents.get(id);
			if (!agent) {
				agent = { id, tail: new JsonlTail(transcriptPath(this.brain, id)), record: {}, steps: [], turnOver: false };
				this.agents.set(id, agent);
			}
			try {
				agent.record = JSON.parse(readFileSync(join(dir, "subagents", name), "utf8"));
			} catch {
				// Being written; read again next time.
			}
			try {
				const { entries, reset } = agent.tail.read();
				if (reset) Object.assign(agent, { steps: [], startedAt: undefined, lastAt: undefined, lastTool: undefined, turnOver: false });
				readAgyTranscript(entries, agent);
			} catch {
				// Its transcript is not written yet.
			}
		}
		if (this.agents.size > 0) this.readMessages(join(dir, "messages"));
	}

	/** Cancel notices among the messages to the conversation (delivered or not). */
	private readMessages(dir: string): void {
		for (const folder of [dir, join(dir, "undelivered")]) {
			let names: string[];
			try {
				names = readdirSync(folder).filter((name) => name.endsWith(".json"));
			} catch {
				continue;
			}
			for (const name of names) {
				const path = join(folder, name);
				if (this.messages.has(path)) continue;
				this.messages.add(path);
				try {
					const content = String(JSON.parse(readFileSync(path, "utf8"))?.content ?? "");
					const canceled = content.match(/^Subagent "([^"]+)" has been (?:explicitly )?cancel/);
					if (canceled) this.canceled.add(canceled[1]);
				} catch {}
			}
		}
	}
}
