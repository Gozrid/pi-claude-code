/**
 * Files, constants and the configured Claude CLI instances.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** pi's agent directory; PI_CODING_AGENT_DIR moves it, as it does for pi itself. */
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
export const CONFIG_FILE = join(AGENT_DIR, "claude-code.json");
export const SESSIONS_FILE = join(AGENT_DIR, "claude-code-sessions.json");
export const MODELS_FILE = join(AGENT_DIR, "claude-code-models.json");

/**
 * The config folder an instance's command uses: CLAUDE_CONFIG_DIR in the
 * command (`CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude`), else the
 * environment's, else ~/.claude.
 */
export function configDirOf(command: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	const match = command.match(/(?:^|\s)CLAUDE_CONFIG_DIR=(?:"([^"]*)"|'([^']*)'|(\S+))/);
	const raw = match ? (match[1] ?? match[2] ?? match[3]) : env.CLAUDE_CONFIG_DIR;
	if (!raw) return join(home, ".claude");
	return raw.replace(/^~(?=\/|$)/, home).replace(/\$\{?HOME\}?/g, home);
}

/** Provider id of the implicit instance used when nothing is configured. */
export const DEFAULT_PROVIDER_ID = "claude-code";
export const API_PREFIX = "claude-code-cli";

/** One Claude CLI the extension can drive, registered in pi as its own provider. */
export interface Instance {
	/** pi provider id, e.g. "claude-work". Stable once saved. */
	id: string;
	/** Display name, e.g. "Work". */
	name: string;
	/**
	 * Base command that starts this CLI, run through /bin/sh, e.g. "claude" or
	 * "CLAUDE_CONFIG_DIR=~/.claude-work claude". The extension appends its own arguments.
	 */
	command: string;
	/**
	 * Context window to show for this instance, e.g. 200000 for a Pro plan. Claude Code
	 * reports 1M for every subscription; this overrides what it reports.
	 */
	contextWindow?: number;
}

export function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return fallback;
	}
}

export function writeJson(file: string, value: unknown): boolean {
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
		return true;
	} catch {
		return false;
	}
}

export function slugify(name: string): string {
	return (
		name
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "instance"
	);
}

/** Derives a provider id from a display name: "Work" → "claude-work", "Claude Code" → "claude-code". */
export function providerIdFor(name: string, taken: Set<string>): string {
	const slug = slugify(name);
	const base = slug.startsWith("claude") ? slug : `claude-${slug}`;
	let id = base;
	for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
	return id;
}

export function defaultInstance(): Instance {
	return { id: DEFAULT_PROVIDER_ID, name: "Claude Code", command: process.env.PI_CLAUDE_BIN || "claude" };
}

/** Configured instances, or the single default instance when the config is missing or empty. */
export function loadInstances(): Instance[] {
	const configured = loadConfiguredInstances();
	return configured.length > 0 ? configured : [defaultInstance()];
}

/** Only the instances the user set up; the implicit default is not one of them. */
export function loadConfiguredInstances(): Instance[] {
	const raw = readJson<{ instances?: unknown }>(CONFIG_FILE, {});
	const entries = Array.isArray(raw.instances) ? raw.instances : [];
	const taken = new Set<string>();
	const instances: Instance[] = [];
	for (const entry of entries as any[]) {
		const name = typeof entry?.name === "string" ? entry.name.trim() : "";
		const command = typeof entry?.command === "string" ? entry.command.trim() : "";
		if (!name || !command) continue;
		const id = typeof entry.id === "string" && entry.id && !taken.has(entry.id) ? entry.id : providerIdFor(name, taken);
		taken.add(id);
		const contextWindow =
			typeof entry.contextWindow === "number" && entry.contextWindow > 0 ? entry.contextWindow : undefined;
		instances.push({ id, name, command, ...(contextWindow && { contextWindow }) });
	}
	return instances;
}

/**
 * Base commands worth offering in the setup wizard: the default login plus one per
 * Claude config directory found in the home directory (~/.claude-*).
 */
export function suggestedCommands(): { label: string; command: string }[] {
	const suggestions = [{ label: "claude   (default login in ~/.claude)", command: "claude" }];
	let entries: string[] = [];
	try {
		entries = readdirSync(homedir());
	} catch {
		return suggestions;
	}
	for (const entry of entries.sort()) {
		if (!entry.startsWith(".claude-")) continue;
		try {
			if (!statSync(join(homedir(), entry)).isDirectory()) continue;
		} catch {
			continue;
		}
		const command = `CLAUDE_CONFIG_DIR="$HOME/${entry}" claude`;
		suggestions.push({ label: `${command}   (login in ~/${entry})`, command });
	}
	return suggestions;
}

export function saveInstances(instances: Instance[]): boolean {
	return writeJson(CONFIG_FILE, { instances: instances.map(({ id, name, command, contextWindow }) => ({ id, name, command, contextWindow })) });
}
