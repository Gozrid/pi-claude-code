/**
 * Tokens per model: one line per answer in ~/.pi/agent/usage-models.jsonl,
 * for every model pi runs (its own and the CLI providers'). Samples older than
 * KEEP_MS are dropped when the file is loaded.
 *
 * A model is keyed by its id, so the same model through several accounts
 * (e.g. Opus on two Claude instances) is one line in the chart.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { KEEP_MS } from "./history.ts";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
export const MODELS_FILE = join(AGENT_DIR, "usage-models.jsonl");

export interface TokenSample {
	/** ms since the epoch */
	t: number;
	/** pi provider id, e.g. "claude-work". */
	p: string;
	/** Model id. */
	m: string;
	/** Model display name. */
	n: string;
	/** Input, output, cache read and cache write tokens. */
	i: number;
	o: number;
	cr: number;
	cw: number;
	/** Cost in USD, when the provider reports one. */
	c?: number;
}

export const totalTokens = (s: TokenSample) => s.i + s.o + s.cr + s.cw;

/**
 * What the chart counts: tokens the model processed anew (input, cache writes,
 * output). Cache reads are left out: they repeat the context on every call and
 * would bury every other model under the one with the longest session.
 */
export const workTokens = (s: TokenSample) => s.i + s.cw + s.o;

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** A sample from a finished assistant message, or undefined when it used no tokens. */
export function sampleFromMessage(message: any, name: string | undefined, now: number): TokenSample | undefined {
	if (message?.role !== "assistant" || typeof message.model !== "string" || typeof message.provider !== "string") return undefined;
	const u = message.usage ?? {};
	const sample: TokenSample = {
		t: now,
		p: message.provider,
		m: message.model,
		n: name || message.model,
		i: count(u.input),
		o: count(u.output),
		cr: count(u.cacheRead),
		cw: count(u.cacheWrite),
	};
	const cost = count(u.cost?.total);
	if (cost > 0) sample.c = cost;
	return totalTokens(sample) > 0 ? sample : undefined;
}

export function parseModelLog(text: string): TokenSample[] {
	const samples: TokenSample[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const s = JSON.parse(line);
			if (typeof s?.t === "number" && typeof s.m === "string") {
				samples.push({
					t: s.t,
					p: typeof s.p === "string" ? s.p : "",
					m: s.m,
					n: typeof s.n === "string" ? s.n : s.m,
					i: count(s.i),
					o: count(s.o),
					cr: count(s.cr),
					cw: count(s.cw),
					...(count(s.c) > 0 && { c: s.c }),
				});
			}
		} catch {
			// A line cut off by a concurrent write: skip it.
		}
	}
	return samples.sort((x, y) => x.t - y.t);
}

/** Recorded token samples in memory, backed by the file. */
export class ModelLog {
	samples: TokenSample[] = [];
	readonly file: string;

	constructor(file = MODELS_FILE) {
		this.file = file;
	}

	load(now = Date.now()): void {
		let text = "";
		try {
			text = existsSync(this.file) ? readFileSync(this.file, "utf8") : "";
		} catch {
			return;
		}
		const all = parseModelLog(text);
		this.samples = all.filter((s) => now - s.t <= KEEP_MS);
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

	record(sample: TokenSample): void {
		this.samples.push(sample);
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			appendFileSync(this.file, `${JSON.stringify(sample)}\n`);
		} catch {
			// Kept in memory for this session.
		}
	}
}

export interface ModelView {
	id: string;
	name: string;
	/** workTokens() per bucket, from the bucket at `from` up to now. */
	buckets: { t: number; tokens: number }[];
	/** Input including cache writes. */
	input: number;
	output: number;
	cacheRead: number;
	cost: number;
}

/** Start of the bucket `t` falls in; buckets of an hour or more start at local full hours / midnight. */
export function bucketStart(t: number, size: number): number {
	const offset = -new Date(t).getTimezoneOffset() * 60_000;
	return Math.floor((t + offset) / size) * size - offset;
}

/**
 * Sums the samples in [from, now] per model and bucket; models sorted by total
 * tokens, the most first.
 */
export function modelViews(samples: readonly TokenSample[], from: number, now: number, bucket: number): ModelView[] {
	const first = bucketStart(from, bucket);
	const buckets = Math.max(1, Math.floor((bucketStart(now, bucket) - first) / bucket) + 1);
	const views = new Map<string, ModelView>();
	for (const s of samples) {
		if (s.t < from || s.t > now) continue;
		let view = views.get(s.m);
		if (!view) {
			view = {
				id: s.m,
				name: s.n,
				buckets: Array.from({ length: buckets }, (_, i) => ({ t: first + i * bucket, tokens: 0 })),
				input: 0,
				output: 0,
				cacheRead: 0,
				cost: 0,
			};
			views.set(s.m, view);
		}
		view.name = s.n;
		const index = Math.min(buckets - 1, Math.max(0, Math.floor((bucketStart(s.t, bucket) - first) / bucket)));
		view.buckets[index].tokens += workTokens(s);
		view.input += s.i + s.cw;
		view.output += s.o;
		view.cacheRead += s.cr;
		view.cost += s.c ?? 0;
	}
	const total = (v: ModelView) => v.input + v.output;
	return [...views.values()].sort((x, y) => total(y) - total(x));
}
