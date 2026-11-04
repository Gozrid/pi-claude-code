/**
 * Plan usage limits reported by `agy -p "/usage" --output-format json`.
 *
 * agy groups its quota buckets by model family ("Gemini Models", "Claude and
 * GPT models", "Gemini 4 Argon", …) and reports `remaining_fraction` (0–1)
 * with an ISO `reset_time` for each 5-hour or weekly window.
 */

import type { UsageLimitWindow } from "../shared/agent-bus.ts";

export interface UsageWindow {
	/** Used share of the window, 0–100. */
	percent: number;
	resetsAt?: number;
}

export interface UsageBucket {
	id: string;
	name: string;
	/** Window kind from agy, e.g. "5h" or "weekly". */
	window: string;
	/** Used share of the bucket, 0–100. */
	percent: number;
	resetsAt?: number;
}

export interface UsageGroup {
	name: string;
	description?: string;
	buckets: UsageBucket[];
}

export interface PlanUsage {
	groups: UsageGroup[];
	updatedAt: number;
}

/** Parses the JSON output of `agy -p "/usage" --output-format json`. */
export function parseUsage(output: string): PlanUsage | undefined {
	const start = output.indexOf("{");
	if (start < 0) return undefined;
	let parsed: any;
	try {
		parsed = JSON.parse(output.slice(start));
	} catch {
		return undefined;
	}
	const rawGroups = parsed?.command?.data?.groups ?? parsed?.groups;
	if (!Array.isArray(rawGroups)) return undefined;

	const groups: UsageGroup[] = [];
	for (const g of rawGroups) {
		const name = typeof g?.name === "string" ? g.name.trim() : "";
		if (!name || !Array.isArray(g.buckets)) continue;
		const buckets: UsageBucket[] = [];
		for (const b of g.buckets) {
			if (!b || b.disabled === true || typeof b.remaining_fraction !== "number") continue;
			const percent = Math.max(0, Math.min(100, (1 - b.remaining_fraction) * 100));
			const parsedReset = typeof b.reset_time === "string" ? Date.parse(b.reset_time) : undefined;
			const resetsAt = parsedReset !== undefined && !Number.isNaN(parsedReset) ? parsedReset : undefined;
			buckets.push({
				id: typeof b.id === "string" ? b.id : "",
				name: typeof b.name === "string" && b.name.trim() ? b.name.trim() : String(b.id ?? ""),
				window: typeof b.window === "string" ? b.window : "",
				percent,
				...(resetsAt !== undefined && { resetsAt }),
			});
		}
		if (buckets.length > 0) {
			const description = typeof g.description === "string" && g.description.trim() ? g.description.trim() : undefined;
			groups.push({ name, ...(description && { description }), buckets });
		}
	}
	return groups.length > 0 ? { groups, updatedAt: Date.now() } : undefined;
}

function candidateGroups(groups: readonly UsageGroup[], modelId: string): UsageGroup[] {
	if (/argon/i.test(modelId)) {
		const argon = groups.filter((g) => /argon/i.test(g.name) || g.buckets.some((b) => /argon/i.test(b.id)));
		const gemini = groups.filter((g) => !argon.includes(g) && /gemini/i.test(g.name));
		return [...argon, ...gemini];
	}
	if (/^(claude|gpt)/i.test(modelId)) {
		const thirdParty = groups.filter((g) => /claude|gpt|3p/i.test(g.name) || g.buckets.some((b) => /^3p-/i.test(b.id)));
		return thirdParty.length > 0 ? thirdParty : [...groups];
	}
	const gemini = groups.filter((g) => /gemini/i.test(g.name) && !/argon/i.test(g.name));
	return gemini.length > 0 ? gemini : [...groups];
}

function findWindow(groups: readonly UsageGroup[], kind: "5h" | "weekly"): UsageWindow | undefined {
	for (const group of groups) {
		const bucket = group.buckets.find((b) => b.window === kind || b.id.endsWith(`-${kind}`));
		if (bucket) return { percent: bucket.percent, ...(bucket.resetsAt !== undefined && { resetsAt: bucket.resetsAt }) };
	}
	return undefined;
}

/** Picks the 5-hour session and weekly quota windows that apply to `modelId`. */
export function usageForModel(
	usage: PlanUsage | undefined,
	modelId: string,
): { session?: UsageWindow; weekly?: UsageWindow } {
	if (!usage || usage.groups.length === 0) return {};
	const candidates = candidateGroups(usage.groups, modelId);
	return {
		session: findWindow(candidates, "5h"),
		weekly: findWindow(candidates, "weekly"),
	};
}

export function bar(percent: number, width = 10): string {
	const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
	return "▓".repeat(filled) + "░".repeat(width - filled);
}

/** The windows to chart: every bucket of every model group. */
export function usageWindows(usage: PlanUsage | undefined): UsageLimitWindow[] {
	if (!usage) return [];
	return usage.groups.flatMap((group) =>
		group.buckets.map((b) => ({
			id: b.id || `${group.name}:${b.window || b.name}`,
			label: `${group.name} · ${b.window === "5h" ? "5h" : b.window || b.name}`,
			percent: b.percent,
			...(b.resetsAt !== undefined && { resetsAt: b.resetsAt }),
		})),
	);
}
