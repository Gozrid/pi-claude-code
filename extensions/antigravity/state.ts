/**
 * Shared runtime state between the provider stream and the extension's commands
 * and event channels.
 */

import type { Activity, BridgeServerInfo, ToolEvent } from "../shared/agent-bus.ts";
import type { AgyModel } from "./cli.ts";
import { AGY_SETTINGS_FILE, type Instance, readJson } from "./config.ts";
import type { PlanUsage } from "./usage.ts";
import type { PiToolInfo } from "../shared/pi-mcp.ts";

/**
 * agy's modes: "default" asks before writes, commands, web and MCP (in print mode
 * that means: denied); "accept-edits" lets workspace edits through; "plan"
 * outlines before it writes; "auto" (Preview, not for every account) decides
 * itself; "bypass" runs with --dangerously-skip-permissions.
 */
export const MODES = ["default", "accept-edits", "plan", "auto", "bypass"];
/** Shift+Tab order, as in agy (auto left out: not every account has it). */
export const MODE_CYCLE = ["default", "accept-edits", "plan"];

/** The mode to start in: PI_AGY_MODE, else agy's own `agentMode` setting, else agy's default. */
function initialMode(): string {
	const wanted = process.env.PI_AGY_MODE || readJson<{ agentMode?: string }>(AGY_SETTINGS_FILE, {}).agentMode || "default";
	return MODES.includes(wanted) ? wanted : "default";
}

export interface InstanceState {
	instance: Instance;
	models: AgyModel[];
	usage?: PlanUsage;
	discovery?: Promise<boolean>;
}

/** How full agy's context is, after the last model call of a run. */
export interface ContextUsage {
	tokens: number;
}

/** An action agy was not allowed to take, with the rule that would allow it. */
export interface Denial {
	/** Display name, e.g. "Bash". */
	tool: string;
	detail: string;
	/** agy permission rule, e.g. "command(npm test)" or "write_file(/path)". */
	rule?: string;
	/** agy's action name, e.g. "write_file" or "command". */
	action: string;
}

export const runtime = {
	mode: initialMode(),
	/** Keyed by pi provider id. */
	instances: new Map<string, InstanceState>(),
	sessionId: undefined as string | undefined,
	cwd: process.cwd(),
	/** Whether pi trusts the project, so its `.pi/mcp.json` counts. */
	projectTrusted: false,
	/** Per session key (see sessionKey()); loaded from the sessions file on first use. */
	context: new Map<string, ContextUsage>(),
	/** Set by the extension to publish what the running CLI does (see ACTIVITY_CHANNEL); undefined ends the run. */
	onActivity: undefined as ((provider: string, activity: Activity | undefined) => void) | undefined,
	/** Set by the extension to publish the tools the CLI runs (see TOOL_CHANNEL). */
	onTool: undefined as ((event: ToolEvent) => void) | undefined,
	/** Set by the extension: Escape ended agy while these tool steps still ran (e.g. commands it waited for). */
	onToolsStopped: undefined as ((descriptions: string[]) => void) | undefined,
	/** Set by the extension to publish the status again when a run reports new token counts. */
	onUsage: undefined as (() => void) | undefined,
	/** Actions agy was not allowed to take in the last run. */
	denials: undefined as { mode: string; items: Denial[] } | undefined,
	/** The next run skips agy's permission checks once (`--dangerously-skip-permissions`), then this is cleared. */
	skipPermissionsOnce: false,
	/** Set by the extension: pi's own MCP server for a run (pi-bridge), undefined when it is off. */
	bridge: undefined as ((provider: string) => BridgeServerInfo | undefined) | undefined,
	/** Set by the extension: pi's tools (pi.getAllTools()), for the MCP tools pi hides. */
	piTools: undefined as (() => readonly PiToolInfo[]) | undefined,
	/** The conversation of the agy run in progress, once agy has named it; for its subagents. */
	live: undefined as { key: string | undefined; conversationId: string } | undefined,
};

export function isAntigravityProvider(provider: string | undefined): boolean {
	return provider !== undefined && runtime.instances.has(provider);
}
