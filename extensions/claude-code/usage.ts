/**
 * Plan usage limits reported by the CLI, and small formatting helpers.
 */

import type { UsageLimitWindow } from "../shared/agent-bus.ts";

export interface UsageWindow {
	/** 0-100 */
	percent: number;
	resetsAt?: number;
}

/** One entry of `rate_limits.limits` in the CLI's get_usage response. */
export interface UsageLimit {
	kind: string;
	group?: string;
	percent?: number;
	resets_at?: string;
	scope?: { model?: { display_name?: string | null } | null; surface?: string | null } | null;
}

export interface PlanUsage {
	session?: UsageWindow;
	weekly?: UsageWindow;
	limits?: UsageLimit[];
	subscriptionType?: string;
	updatedAt: number;
}

function toWindow(raw: any, scale: number): UsageWindow | undefined {
	if (!raw || typeof raw.utilization !== "number") return undefined;
	const reset = raw.resets_at ?? raw.resetsAt;
	const resetsAt = typeof reset === "number" ? reset * 1000 : typeof reset === "string" ? Date.parse(reset) : undefined;
	return { percent: raw.utilization * scale, resetsAt: Number.isNaN(resetsAt) ? undefined : resetsAt };
}

/** Parses the get_usage control response (utilization in percent). */
export function usageFromGetUsage(response: any): PlanUsage | undefined {
	const limits = response?.rate_limits;
	if (!response?.rate_limits_available || !limits) return undefined;
	return {
		session: toWindow(limits.five_hour, 1),
		weekly: toWindow(limits.seven_day, 1),
		limits: Array.isArray(limits.limits) ? limits.limits : undefined,
		subscriptionType: response.subscription_type,
		updatedAt: Date.now(),
	};
}

/** Parses a rate_limit_event from a model run (utilization as a 0-1 fraction). */
export function usageFromRateLimitEvent(info: any, previous: PlanUsage | undefined): PlanUsage | undefined {
	const windows = info?.unifiedWindows;
	if (!windows) return previous;
	return {
		...previous,
		session: toWindow(windows.five_hour, 100) ?? previous?.session,
		weekly: toWindow(windows.seven_day, 100) ?? previous?.weekly,
		updatedAt: Date.now(),
	};
}

export function bar(percent: number, width = 10): string {
	const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
	return "▓".repeat(filled) + "░".repeat(width - filled);
}

/**
 * The windows to chart: the 5-hour session, the week, and the per-model
 * limits (e.g. weekly for Opus). Limits without a scope repeat session and
 * week, so they only count when those two are missing.
 */
export function usageWindows(usage: PlanUsage | undefined): UsageLimitWindow[] {
	if (!usage) return [];
	const windows: UsageLimitWindow[] = [];
	if (usage.session) windows.push({ id: "session", label: "5h session", ...usage.session });
	if (usage.weekly) windows.push({ id: "weekly", label: "weekly", ...usage.weekly });
	for (const l of usage.limits ?? []) {
		if (typeof l.percent !== "number") continue;
		const scope = l.scope?.model?.display_name ?? l.scope?.surface ?? undefined;
		if (!scope && windows.length > 0) continue;
		const name = l.group ?? l.kind;
		const resetsAt = l.resets_at ? Date.parse(l.resets_at) : Number.NaN;
		windows.push({
			id: scope ? `${name}:${scope}` : name,
			label: scope ? `${name} (${scope})` : name,
			percent: l.percent,
			...(!Number.isNaN(resetsAt) && { resetsAt }),
		});
	}
	return windows;
}
