/**
 * Event channels between the CLI provider extensions (claude-code, antigravity)
 * and the extensions that show what those CLIs do (agent-status-line, usage-graph,
 * work-status, task-list, subagents, permission-retry, chat-crab).
 *
 * A CLI runs its own tools and keeps its own state, so pi's events do not see
 * them. The provider publishes snapshots here instead, each tagged with the pi
 * provider id it is about; the extensions that draw read only these channels.
 * pi loads every extension with its own copy of the modules it imports, so only
 * channel names and types are shared, never state.
 *
 * Not an extension itself; pi loads only the entries listed in package.json.
 */

// =============================================================================
// Status: mode, model, effort, context and plan usage (agent-status-line)
// =============================================================================

/** pi.events channel; the payload is a StatusEvent. */
export const STATUS_CHANNEL = "cli-agent:status";

export interface AgentStatus {
	/** pi provider id of the selected model. */
	provider: string;
	/** Mode id in the CLI's own words (auto, acceptEdits, plan, accept-edits, …). */
	mode: string;
	/** Display name of the selected model. */
	model: string;
	/** Instance name, only set when there is more than one to tell apart. */
	instance?: string;
	/** pi's thinking level, unset for models without effort levels. */
	effort?: string;
	context?: { tokens: number; window?: number };
	/** Plan usage in percent (0-100); `resetsAt` in ms since the epoch. */
	session?: { percent: number; resetsAt?: number };
	weekly?: { percent: number };
}

export interface StatusEvent {
	/** The provider extension that sends it, e.g. "claude-code". */
	source: string;
	/** Unset when none of the source's models is selected. */
	status?: AgentStatus;
}

/**
 * pi.events channel to switch a provider's mode; the payload is a ModeRequest.
 * The provider that owns `provider` answers by publishing a new status.
 */
export const MODE_CHANNEL = "cli-agent:mode";

export interface ModeRequest {
	provider: string;
	/** The mode to switch to; unset steps to the next one of the provider's Shift+Tab cycle. */
	mode?: string;
}

// =============================================================================
// Plan usage of every account (usage-graph)
// =============================================================================

/**
 * pi.events channel; the payload is a UsageEvent. A provider extension sends the
 * plan usage of all its accounts whenever it learns something new about one.
 */
export const USAGE_CHANNEL = "cli-agent:usage";

export interface UsageLimitWindow {
	/** Stable within the account, e.g. "session", "weekly" or a bucket id. */
	id: string;
	/** Display name, e.g. "5h session" or "Gemini Models · weekly". */
	label: string;
	/** Used share, 0-100. */
	percent: number;
	/** ms since the epoch. */
	resetsAt?: number;
}

export interface UsageAccount {
	/** Unique across providers: the pi provider id of the instance. */
	id: string;
	/** Display name, e.g. "Claude · Work". */
	name: string;
	windows: UsageLimitWindow[];
}

export interface UsageEvent {
	/** The provider extension that sends it, e.g. "claude-code". */
	source: string;
	/** Accounts with known usage; ones without limits (API key, unreachable) are left out. */
	accounts: UsageAccount[];
}

/**
 * pi.events channel to read the usage of every account again; the payload is a
 * UsageRefreshRequest. Each provider extension calls `pending` during emit with
 * a promise that settles once it has published fresh usage on USAGE_CHANNEL.
 */
export const USAGE_REFRESH_CHANNEL = "cli-agent:usage-refresh";

export interface UsageRefreshRequest {
	cwd: string;
	pending: (done: Promise<unknown>) => void;
}

// =============================================================================
// Activity: what the running CLI does right now (work-status's animation)
// =============================================================================

/** pi.events channel; the payload is an ActivityEvent. */
export const ACTIVITY_CHANNEL = "cli-agent:activity";

export interface Activity {
	phase: "starting" | "thinking" | "writing" | "tool";
	/** Display name of the running tool (Bash, Read, Edit, …). */
	tool?: string;
	/** What it works on: a command, a path, a URL, … */
	detail?: string;
	/** Output tokens so far in this run, including a live estimate. */
	tokens: number;
}

export interface ActivityEvent {
	provider: string;
	/** Unset when the run is over. */
	activity?: Activity;
}

// =============================================================================
// Tools the CLI runs (chat-crab)
// =============================================================================

/** pi.events channel; the payload is a ToolEvent. */
export const TOOL_CHANNEL = "cli-agent:tool";

export type ToolEvent =
	| { type: "start"; /** Display name (Bash, Read, Edit, …). */ name: string; /** A command, a path, a URL, … */ detail?: string }
	| { type: "end"; isError: boolean };

// =============================================================================
// Task list (task-list)
// =============================================================================

/** pi.events channel; the payload is a TasksEvent. */
export const TASKS_CHANNEL = "cli-agent:tasks";

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface Task {
	id: string;
	subject: string;
	status: TaskStatus;
	/** Present-tense form shown while the task runs, e.g. "Writing the intro". */
	activeForm?: string;
}

export interface TasksEvent {
	/** The provider extension that sends it, e.g. "claude-code". */
	source: string;
	/** The tasks of the current session; empty when there are none or another provider is selected. */
	tasks: Task[];
}

// =============================================================================
// Subagents the CLI starts (subagents)
// =============================================================================

/** pi.events channel; the payload is a SubagentsEvent. */
export const SUBAGENTS_CHANNEL = "cli-agent:subagents";

/** `stopped`: never finished and nothing happened for a while (its CLI was ended). */
export type SubagentStatus = "running" | "done" | "stopped";

/** One step of a subagent's output, in order. */
export type SubagentStep =
	| { kind: "prompt"; text: string }
	| { kind: "text"; text: string }
	/** What the model thought before its next step, as far as the CLI writes it. */
	| { kind: "thinking"; text: string }
	| { kind: "tool"; /** Display name (Bash, Read, …). */ name: string; /** A command, a path, a URL, … */ detail?: string }
	| { kind: "result"; text: string; isError: boolean };

export interface Subagent {
	/** Unique within the session. */
	id: string;
	description: string;
	/** Agent type, e.g. "general-purpose" or "Explore". */
	type?: string;
	status: SubagentStatus;
	/** ms since the epoch. */
	startedAt?: number;
	/** ms since the epoch of the latest step. */
	lastAt?: number;
	/** The tool it runs or ran last. */
	lastTool?: { name: string; detail?: string };
	/** Its output so far; the array grows in place while it runs. */
	steps: SubagentStep[];
}

export interface SubagentsEvent {
	/** The provider extension that sends it, e.g. "claude-code". */
	source: string;
	/** Every subagent of the current session, running or not; empty when another provider is selected. */
	agents: Subagent[];
}

// =============================================================================
// Denied actions (permission-retry)
// =============================================================================

/** pi.events channel; the payload is a DenialsEvent, sent at the end of a run. */
export const DENIALS_CHANNEL = "cli-agent:denials";

export interface DenialsEvent {
	provider: string;
	/** The mode the run was in. */
	mode: string;
	items: { tool: string; detail: string }[];
	/** Ways to allow them; the chosen one is applied before the retry is sent. */
	choices: { label: string; apply: () => void }[];
}

// =============================================================================
// One-off questions (work-status's session titles)
// =============================================================================

/**
 * pi.events channel for one-off questions to a CLI, answered by its smallest
 * model without tools or a saved session; the payload is a OneShotRequest.
 */
export const ONESHOT_CHANNEL = "cli-agent:one-shot";

export interface OneShotRequest {
	/** pi provider id of the selected model. */
	provider: string;
	system: string;
	prompt: string;
	/**
	 * Called right away (during emit) by the provider extension that takes the
	 * request; when nobody does, the sender asks pi's model registry instead.
	 */
	claim: () => void;
	/** Called once with the answer, or undefined when there is none. */
	reply: (text: string | undefined) => void;
}

// =============================================================================
// pi's own MCP server for the CLIs (pi-bridge)
// =============================================================================

/**
 * pi.events channel; the payload is a BridgeRequest. A provider extension sends
 * it before starting its CLI; pi-bridge, when on, answers during emit with the
 * server the CLI should get.
 */
export const BRIDGE_CHANNEL = "pi-bridge:server";

export interface BridgeRequest {
	/** pi provider id of the selected model. */
	provider: string;
	kind: "claude" | "agy";
	cwd: string;
	/** Claude: settings files for "always allow" rules. */
	claudeSettings?: { project: string; user: string };
	/** agy: its settings file (allow rules) and the mode of the run. */
	agySettings?: string;
	mode?: string;
	reply: (server: BridgeServerInfo) => void;
}

export interface BridgeServerInfo {
	/** MCP server name, "pi". */
	name: string;
	url: string;
	headers: Record<string, string>;
	/**
	 * pi's MCP servers through pi's own connections: `<mcpUrl>/<server>` with
	 * `headers`, only the tools pi's exposure leaves reachable. Unset when pi does
	 * not connect the servers itself; the CLI then starts them on its own.
	 */
	mcpUrl?: string;
	/** Claude: the tool for --permission-prompt-tool; unset when nobody can answer (no UI). */
	permissionTool?: string;
	/**
	 * agy: pi asks before actions (see pi-bridge/agy-gate.ts). The run starts
	 * with `allow` added to the user's allow rules and a PreToolUse hook that
	 * posts to `url`, waiting up to `timeout` seconds. Unset when pi does not ask.
	 */
	gate?: { url: string; headers: Record<string, string>; allow: string[]; timeout: number };
}
