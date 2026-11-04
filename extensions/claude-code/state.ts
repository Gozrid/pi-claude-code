/**
 * Shared runtime state between the provider stream and the extension's commands
 * and event channels.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Activity, Task, ToolEvent, BridgeServerInfo } from "../shared/agent-bus.ts";
import type { CliModel } from "./cli.ts";
import type { Instance } from "./config.ts";
import type { PlanUsage } from "./usage.ts";
import type { PiToolInfo } from "../shared/pi-mcp.ts";

export const PERMISSION_MODES = ["auto", "acceptEdits", "plan", "dontAsk", "bypassPermissions", "manual"];
/** Shift+Tab order, as in Claude Code. `manual` is left out: in print mode nobody can answer its prompts. */
export const MODE_CYCLE = ["auto", "acceptEdits", "plan"];

export interface InstanceState {
	instance: Instance;
	models: CliModel[];
	usage?: PlanUsage;
	account?: { email?: string; subscriptionType?: string };
	claudeVersion?: string;
	/**
	 * Value for the CLI's hidden --thinking-display flag. Without "summarized" print mode
	 * streams thinking blocks with empty text. Cleared when this CLI does not know the flag.
	 */
	thinkingDisplay?: string;
	discovery?: Promise<boolean>;
}

/** How full Claude Code's context is, from the last API call of a run. */
export interface ContextUsage {
	tokens: number;
	/** The model's context window as the CLI reports it. */
	window?: number;
}

/** Actions Claude Code was not allowed to take in the last run. */
export interface Denials {
	mode: string;
	items: { tool: string; detail: string }[];
}

/**
 * The claude process of the current run, kept between pi turns while a steer
 * splits its answer (see stream.ts, "Steering").
 */
export interface LiveRun {
	provider: string;
	key: string | undefined;
	child: ChildProcessWithoutNullStreams;
	/** claude's stdout, line by line; read on by the turn that continues the run. */
	lines: AsyncIterator<string>;
	exited: Promise<number | null>;
	stderr: string;
	/** Steers written to claude that it has not taken up yet, in order. */
	waiting: string[];
	/** Every steer written to claude, to recognise them when pi delivers them. */
	steers: Set<string>;
	/** The answer was split at a steer; the next turn continues reading this run. */
	detached: boolean;
	/** The final result came; claude's input is closed, no more steers. */
	closing: boolean;
	claudeSessionId?: string;
	contextTokens?: number;
}

export const runtime = {
	permissionMode: PERMISSION_MODES.includes(process.env.PI_CLAUDE_PERMISSION_MODE ?? "")
		? process.env.PI_CLAUDE_PERMISSION_MODE!
		: "auto",
	sessionId: undefined as string | undefined,
	cwd: process.cwd(),
	/** Whether pi trusts the project, so its `.pi/mcp.json` counts. */
	projectTrusted: false,
	/** Keyed by pi provider id. */
	instances: new Map<string, InstanceState>(),
	/** Set by the extension to publish what the running CLI does (see ACTIVITY_CHANNEL); undefined ends the run. */
	onActivity: undefined as ((provider: string, activity: Activity | undefined) => void) | undefined,
	/** Set by the extension to publish the status again when a run reports new limits. */
	onUsage: undefined as (() => void) | undefined,
	/** Per session key (see sessionKey()); loaded from the sessions file on first use. */
	context: new Map<string, ContextUsage>(),
	tasks: new Map<string, Task[]>(),
	/** Set by the extension to publish the task list when Claude changes it. */
	onTasks: undefined as (() => void) | undefined,
	/** Set by the extension to publish the tools the CLI runs (see TOOL_CHANNEL). */
	onTool: undefined as ((event: ToolEvent) => void) | undefined,
	denials: undefined as Denials | undefined,
	/** Tool names the next run may use without asking (`--allowedTools`), then cleared. */
	allowOnce: undefined as string[] | undefined,
	/** Set by the extension: pi's own MCP server for a run (pi-bridge), undefined when it is off. */
	bridge: undefined as ((provider: string, command: string) => BridgeServerInfo | undefined) | undefined,
	/** Set by the extension: pi's tools (pi.getAllTools()), for the MCP tools pi hides. */
	piTools: undefined as (() => readonly PiToolInfo[]) | undefined,
	/** The claude process of the current run (see LiveRun). */
	live: undefined as LiveRun | undefined,
};

export function isClaudeProvider(provider: string | undefined): boolean {
	return provider !== undefined && runtime.instances.has(provider);
}
