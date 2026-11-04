/**
 * The recorded plan usage: one sample per line in ~/.pi/agent/usage-history.jsonl.
 *
 * A sample is written when a window's value changes, and otherwise at most every
 * RECORD_EVERY_MS, so the file stays small. Several pi sessions may append at
 * the same time; repeated samples do no harm. Samples older than KEEP_MS are
 * dropped when the file is loaded.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { UsageAccount } from "../shared/agent-bus.ts";

/** pi's agent directory; PI_CODING_AGENT_DIR moves it, as it does for pi itself. */
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
export const HISTORY_FILE = join(AGENT_DIR, "usage-history.jsonl");

export const KEEP_MS = 35 * 24 * 3600_000;
export const RECORD_EVERY_MS = 30 * 60_000;
/** Changes smaller than this (in percent points) are not worth a sample. */
const MIN_CHANGE = 0.1;

export interface Sample {
	/** ms since the epoch */
	t: number;
	/** Account id (pi provider id of the instance). */
	a: string;
	/** Account display name. */
	n: string;
	/** Window id within the account. */
	w: string;
	/** Window display name. */
	l: string;
	/** Used share, 0-100. */
	p: number;
	/** When the window resets, ms since the epoch. */
	r?: number;
}

export const seriesKey = (s: Pick<Sample, "a" | "w">) => `${s.a}\u0000${s.w}`;

export function parseHistory(text: string): Sample[] {
	const samples: Sample[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const s = JSON.parse(line);
			if (typeof s?.t === "number" && typeof s.a === "string" && typeof s.w === "string" && typeof s.p === "number") {
				samples.push({ ...s, n: typeof s.n === "string" ? s.n : s.a, l: typeof s.l === "string" ? s.l : s.w });
			}
		} catch {
			// A line cut off by a concurrent write: skip it.
		}
	}
	return samples.sort((x, y) => x.t - y.t);
}

/** The samples to record for `accounts` at `now`, given the last sample of each series. */
export function newSamples(accounts: readonly UsageAccount[], last: ReadonlyMap<string, Sample>, now: number): Sample[] {
	const out: Sample[] = [];
	for (const account of accounts) {
		for (const w of account.windows) {
			if (!Number.isFinite(w.percent)) continue;
			const sample: Sample = { t: now, a: account.id, n: account.name, w: w.id, l: w.label, p: Math.round(w.percent * 10) / 10 };
			if (w.resetsAt !== undefined) sample.r = w.resetsAt;
			const prev = last.get(seriesKey(sample));
			const changed =
				!prev ||
				Math.abs(prev.p - sample.p) >= MIN_CHANGE ||
				prev.r !== sample.r ||
				prev.l !== sample.l ||
				prev.n !== sample.n ||
				now - prev.t >= RECORD_EVERY_MS;
			if (changed) out.push(sample);
		}
	}
	return out;
}

/** Recorded samples in memory, backed by the history file. */
export class History {
	samples: Sample[] = [];
	readonly last = new Map<string, Sample>();

	readonly file: string;

	constructor(file = HISTORY_FILE) {
		this.file = file;
	}

	load(now = Date.now()): void {
		let text = "";
		try {
			text = existsSync(this.file) ? readFileSync(this.file, "utf8") : "";
		} catch {
			return;
		}
		const all = parseHistory(text);
		this.samples = all.filter((s) => now - s.t <= KEEP_MS);
		this.last.clear();
		for (const s of this.samples) this.last.set(seriesKey(s), s);
		if (this.samples.length < all.length) {
			try {
				const tmp = `${this.file}.${process.pid}.tmp`;
				writeFileSync(tmp, this.samples.map((s) => JSON.stringify(s)).join("\n") + (this.samples.length ? "\n" : ""));
				renameSync(tmp, this.file);
			} catch {
				// Pruning is only housekeeping.
			}
		}
	}

	/** Records what changed; returns the samples written. */
	record(accounts: readonly UsageAccount[], now = Date.now()): Sample[] {
		const fresh = newSamples(accounts, this.last, now);
		if (fresh.length === 0) return fresh;
		for (const s of fresh) {
			this.samples.push(s);
			this.last.set(seriesKey(s), s);
		}
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			appendFileSync(this.file, fresh.map((s) => JSON.stringify(s)).join("\n") + "\n");
		} catch {
			// Kept in memory for this session.
		}
		return fresh;
	}
}
