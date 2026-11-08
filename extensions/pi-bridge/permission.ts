/**
 * Permission requests from Claude Code (`--permission-prompt-tool`): instead of
 * denying what its mode does not allow, Claude asks here and waits. The user
 * answers in a dialog:
 *
 *   Claude wants to run: npm test
 *   › Allow once
 *     Allow for this session
 *     Always allow in this project
 *     Always allow, all projects
 *     Deny          → optional reason for Claude
 *     ✎ Own answer  → denied, the text goes to Claude
 *
 * "Always" adds the rule to Claude's settings (`.claude/settings.local.json` of
 * the project, or `settings.json` of the instance's config folder).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { AskAnswer, AskQuestion } from "./ask.ts";

export interface PermissionRequest {
	tool: string;
	input: Record<string, any>;
}

/** Claude's answer format for a permission prompt tool. */
export type PermissionDecision =
	| { behavior: "allow"; updatedInput: Record<string, any> }
	| { behavior: "deny"; message: string };

export const ALLOW_ONCE = "Allow once";
export const ALLOW_SESSION = "Allow for this session";
export const ALLOW_PROJECT = "Always allow in this project";
export const ALLOW_USER = "Always allow, all projects";
export const ALLOW_ALWAYS = "Always allow";
export const DENY = "Deny";
const DENY_REASON = "Reason for the agent (optional)";

const FILE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

const str = (value: unknown) => (typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value));

/** The settings rule that allows this request, in Claude's rule syntax. */
export function ruleFor({ tool, input }: PermissionRequest, cwd: string): string {
	if (tool === "Bash" && typeof input.command === "string") return `Bash(${input.command.trim()})`;
	const path = input.file_path ?? input.notebook_path;
	if (FILE_TOOLS.has(tool) && typeof path === "string") {
		const abs = isAbsolute(path) ? path : resolve(cwd, path);
		// Claude reads `//path` as an absolute path.
		return `Edit(/${abs})`;
	}
	if (tool === "WebFetch" && typeof input.url === "string") {
		try {
			return `WebFetch(domain:${new URL(input.url).hostname})`;
		} catch {
			return tool;
		}
	}
	return tool;
}

/** A short title and the lines worth seeing before deciding. */
export function describe({ tool, input }: PermissionRequest, agent: string): { title: string; preview?: string } {
	if (tool === "Bash") return { title: `${agent} wants to run a command`, preview: `$ ${str(input.command)}${input.description ? `\n# ${input.description}` : ""}` };
	if (tool === "Write") return { title: `${agent} wants to write ${str(input.file_path)}`, preview: added(str(input.content)) };
	if (tool === "Edit") return { title: `${agent} wants to edit ${str(input.file_path)}`, preview: change(str(input.old_string), str(input.new_string)) };
	if (tool === "MultiEdit" && Array.isArray(input.edits)) {
		return {
			title: `${agent} wants to edit ${str(input.file_path)}`,
			preview: input.edits.map((e: any) => change(str(e.old_string), str(e.new_string))).join("\n…\n"),
		};
	}
	if (tool === "WebFetch") return { title: `${agent} wants to fetch ${str(input.url)}`, preview: input.prompt ? str(input.prompt) : undefined };
	if (tool === "WebSearch") return { title: `${agent} wants to search the web`, preview: str(input.query) };
	const args = JSON.stringify(input, null, 2);
	return { title: `${agent} wants to use ${tool}`, preview: args === "{}" ? undefined : args };
}

/** The dialog scrolls the preview, so only huge files are cut. */
const MAX_PREVIEW_LINES = 500;

function clip(lines: string[]): string {
	if (lines.length <= MAX_PREVIEW_LINES) return lines.join("\n");
	return [...lines.slice(0, MAX_PREVIEW_LINES), `… ${lines.length - MAX_PREVIEW_LINES} more lines`].join("\n");
}

function added(text: string): string {
	return clip(text.split("\n").map((line) => `+ ${line}`));
}

function change(before: string, after: string): string {
	return clip([...before.split("\n").map((l) => `- ${l}`), ...after.split("\n").map((l) => `+ ${l}`)]);
}

/** The dialog for one request; `canPersist` offers the "always" options. */
export function permissionQuestion(request: PermissionRequest, agent: string, rule: string, canPersist: boolean): AskQuestion {
	const { title, preview } = describe(request, agent);
	return {
		header: "Permission",
		question: title,
		preview,
		options: [
			{ label: ALLOW_ONCE, recommended: true },
			{ label: ALLOW_SESSION, description: `Rule ${rule}, until pi closes` },
			...(canPersist
				? [
						{ label: ALLOW_PROJECT, description: `Adds ${rule} to .claude/settings.local.json` },
						{ label: ALLOW_USER, description: `Adds ${rule} to Claude's user settings` },
					]
				: []),
			{ label: DENY, input: DENY_REASON },
		],
	};
}

/** The dialog for an agy action; "always" adds the rule to agy's settings. */
export function agyPermissionQuestion(title: string, preview: string | undefined, rule: string): AskQuestion {
	return {
		header: "Permission",
		question: title,
		preview,
		options: [
			{ label: ALLOW_ONCE, recommended: true },
			{ label: ALLOW_SESSION, description: `Rule ${rule}, until pi closes` },
			{ label: ALLOW_ALWAYS, description: `Adds ${rule} to agy's settings` },
			{ label: DENY, input: DENY_REASON },
		],
	};
}

export type PermissionChoice =
	| { allow: true; scope: "once" | "session" | "project" | "user" | "always" }
	| { allow: false; message: string };

/** What the dialog's answer means; undefined answers (dialog closed) deny. */
export function choiceFrom(answer: AskAnswer | undefined): PermissionChoice {
	if (!answer) return { allow: false, message: "The user closed the permission dialog without allowing the action." };
	const picked = answer.selected[0];
	if (picked === ALLOW_ONCE) return { allow: true, scope: "once" };
	if (picked === ALLOW_SESSION) return { allow: true, scope: "session" };
	if (picked === ALLOW_PROJECT) return { allow: true, scope: "project" };
	if (picked === ALLOW_USER) return { allow: true, scope: "user" };
	if (picked === ALLOW_ALWAYS) return { allow: true, scope: "always" };
	const text = [answer.extra?.text, answer.own].filter(Boolean).join("\n");
	return { allow: false, message: text ? `The user denied this action: ${text}` : "The user denied this action." };
}

/** Adds an allow rule to a Claude settings file; false when it could not. */
export function addAllowRule(file: string, rule: string): boolean {
	try {
		const settings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
		const permissions = settings.permissions && typeof settings.permissions === "object" ? settings.permissions : {};
		const allow: string[] = Array.isArray(permissions.allow) ? permissions.allow : [];
		if (!allow.includes(rule)) allow.push(rule);
		settings.permissions = { ...permissions, allow };
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
		return true;
	} catch {
		return false;
	}
}
