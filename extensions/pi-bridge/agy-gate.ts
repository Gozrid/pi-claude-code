/**
 * Permission prompts for agy. agy in print mode denies what its mode does not
 * allow, and a hook cannot turn that into an allow. So the order is reversed:
 * the run gets broad allow rules (GATE_RULES, on top of the user's own), and a
 * PreToolUse hook asks pi before each action that agy would have asked about:
 *
 *   - commands, unless one of the user's `command(…)` rules covers them
 *   - file writes, except inside the workspace in mode accept-edits, unless a
 *     `write_file(…)` rule covers them
 *   - file reads outside the workspace, unless a `read_file(…)` rule covers them
 *
 * URLs and other MCP servers keep agy's own rules (and the retry offer).
 * The hook runs curl against pi's server; when pi is gone, curl fails and agy
 * blocks the action.
 */

import { isAbsolute, relative, resolve } from "node:path";

/** Allow rules a gated run starts with, besides the user's. */
export const GATE_RULES = ["command(*)", "unsandboxed(*)", "write_file(*)", "read_file(*)"];

/** Modes in which pi asks; plan, auto and bypass keep agy's own behaviour. */
export const GATED_MODES = ["default", "accept-edits"];

/**
 * Seconds agy waits for the hook, i.e. for the user's answer (also curl's
 * --max-time). 20 days is as good as no limit: pi waits until the user answers.
 */
export const HOOK_TIMEOUT = 20 * 24 * 3600;

export interface HookPayload {
	toolCall?: { name?: string; args?: Record<string, any> };
	workspacePaths?: string[];
}

export type GateAction =
	| { kind: "command"; command: string; cwd?: string }
	| { kind: "write"; path: string }
	| { kind: "read"; path: string };

const WRITE_TOOL = /write|replace|edit|delete|move|create|rename/i;

/** The first absolute path among the arguments (Path, TargetFile, AbsolutePath, …). */
function pathArg(args: Record<string, any>): string | undefined {
	for (const [key, value] of Object.entries(args)) {
		if (typeof value === "string" && isAbsolute(value) && /path|file|dir|target|source|dest/i.test(key)) return value;
	}
	return undefined;
}

/** What a tool call does, as far as the gate cares; undefined for everything else. */
export function gateAction(payload: HookPayload): GateAction | undefined {
	const name = payload.toolCall?.name ?? "";
	const args = payload.toolCall?.args ?? {};
	if (typeof args.CommandLine === "string") return { kind: "command", command: args.CommandLine.trim(), cwd: args.Cwd };
	if (name.startsWith("mcp")) return undefined;
	const path = pathArg(args);
	if (!path) return undefined;
	return { kind: WRITE_TOOL.test(name) ? "write" : "read", path };
}

const inside = (path: string, dir: string) => {
	const rel = relative(resolve(dir), resolve(path));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** The agy rule that would allow the action for good. */
export function agyRuleFor(action: GateAction): string {
	if (action.kind === "command") return `command(${action.command})`;
	return `${action.kind === "write" ? "write_file" : "read_file"}(${action.path})`;
}

/** Whether one of agy's allow rules covers the action (commands by prefix, paths by folder). */
export function coveredBy(rules: string[], action: GateAction): boolean {
	const kind = action.kind === "command" ? "command" : action.kind === "write" ? "write_file" : "read_file";
	return rules.some((rule) => {
		const match = rule.match(/^(\w+)\((.*)\)$/s);
		if (!match || match[1] !== kind) return false;
		const value = match[2].trim();
		if (action.kind === "command") {
			return action.command === value || action.command.startsWith(`${value} `);
		}
		return inside(action.path, value);
	});
}

/** Whether pi needs to ask; false lets the action through right away. */
export function needsAsking(action: GateAction, mode: string, workspaces: string[], rules: string[]): boolean {
	if (coveredBy(rules, action)) return false;
	if (action.kind === "command") return true;
	const inWorkspace = workspaces.some((dir) => inside(action.path, dir));
	if (action.kind === "read") return !inWorkspace;
	return !(mode === "accept-edits" && inWorkspace);
}

/** Title and preview of the dialog. */
export function describeAction(action: GateAction, args: Record<string, any>): { title: string; preview?: string } {
	if (action.kind === "command") {
		return { title: "agy wants to run a command", preview: `$ ${action.command}${action.cwd ? `\n# in ${action.cwd}` : ""}` };
	}
	if (action.kind === "read") return { title: `agy wants to read ${action.path} (outside the workspace)` };
	const content = typeof args.Content === "string" ? args.Content : typeof args.CodeContent === "string" ? args.CodeContent : undefined;
	const preview = content
		?.split("\n")
		.slice(0, 16)
		.map((line) => `+ ${line}`)
		.join("\n");
	return { title: `agy wants to change ${action.path}`, preview };
}
