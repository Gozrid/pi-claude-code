/**
 * The panel above the editor while subagents run:
 *
 *   Subagents 2 running · click to watch
 *   ◐ Review PR 13  general-purpose · 1m 12s · Bash gh pr diff 13
 *   ◐ Find callers  Explore · 12s · Grep useSession
 *
 * Row 0 is the heading; row i (from 1) belongs to running[i - 1].
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Subagent, SubagentStatus } from "../shared/agent-bus.ts";
import { formatDuration, formatElapsed } from "../shared/format.ts";

export type Theme = {
	fg(color: any, text: string): string;
	bold(text: string): string;
};

export const SYMBOL: Record<SubagentStatus, string> = { running: "◐", done: "✓", stopped: "⊘" };
export const COLOR: Record<SubagentStatus, string> = { running: "accent", done: "success", stopped: "warning" };

/** Running first (oldest first), then the rest, latest first. */
export function sortAgents(agents: Subagent[]): Subagent[] {
	const started = (a: Subagent) => a.startedAt ?? 0;
	return [
		...agents.filter((a) => a.status === "running").sort((a, b) => started(a) - started(b)),
		...agents.filter((a) => a.status !== "running").sort((a, b) => started(b) - started(a)),
	];
}

/** How long it has run: until now while it runs, else until its last step. */
export function runTime(agent: Subagent, now: number): string {
	if (agent.startedAt === undefined) return "";
	const end = agent.status === "running" ? now : (agent.lastAt ?? agent.startedAt);
	const ms = Math.max(0, end - agent.startedAt);
	// From an hour on in hours ("3hr 16m"), not in minutes.
	return ms < 3_600_000 ? formatElapsed(ms) : formatDuration(ms);
}

/** "Bash gh pr diff 13": the tool it runs or ran last. */
export function toolLine(agent: Subagent): string {
	return agent.lastTool ? `${agent.lastTool.name}${agent.lastTool.detail ? ` ${agent.lastTool.detail.replace(/\s+/g, " ")}` : ""}` : "";
}

export function panelLines(theme: Theme, running: Subagent[], now: number, width: number): string[] {
	if (running.length === 0) return [];
	const heading = `${theme.fg("muted", "Subagents")} ${theme.fg("dim", `${running.length} running · click to watch`)}`;
	return [
		truncateToWidth(heading, width),
		...running.map((agent) => {
			const meta = [agent.type, runTime(agent, now), toolLine(agent)].filter(Boolean).join(" · ");
			const line = `${theme.fg(COLOR[agent.status], SYMBOL[agent.status])} ${theme.bold(agent.description)}  ${theme.fg("dim", meta)}`;
			return truncateToWidth(line, width);
		}),
	];
}
