/**
 * Files, constants and the configured Antigravity CLI instances.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** pi's agent directory; PI_CODING_AGENT_DIR moves it, as it does for pi itself. */
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
export const CONFIG_FILE = join(AGENT_DIR, "antigravity.json");
export const SESSIONS_FILE = join(AGENT_DIR, "antigravity-sessions.json");
export const MODELS_FILE = join(AGENT_DIR, "antigravity-models.json");

/** The CLI's own directory and settings: its conversation transcripts, default mode and permission rules. */
export const AGY_DIR = join(homedir(), ".gemini", "antigravity-cli");
export const AGY_SETTINGS_FILE = join(AGY_DIR, "settings.json");

/** Provider id of the implicit instance used when nothing is configured. */
export const DEFAULT_PROVIDER_ID = "antigravity";
export const API_PREFIX = "antigravity-cli";

/** One Antigravity CLI the extension can drive, registered in pi as its own provider. */
export interface Instance {
	/** pi provider id, e.g. "antigravity-work". Stable once saved. */
	id: string;
	/** Display name, e.g. "Work". */
	name: string;
	/**
	 * Base command that starts this CLI, run through /bin/sh, e.g. "agy" or
	 * "AGY_ADC_AUTH=1 agy". The extension appends its own arguments.
	 */
	command: string;
	/** Context window to show in the status line; agy does not report one. */
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
			.replace(/[\u0300-\u036f]/g, "")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "instance"
	);
}

/**
 * Derives a provider id from a display name: "Work" → "antigravity-work". The prefix
 * keeps every instance an Antigravity provider for provider-logo, chat-crab and co.
 */
export function providerIdFor(name: string, taken: Set<string>): string {
	const slug = slugify(name);
	const base = slug.startsWith("antigravity") ? slug : `antigravity-${slug}`;
	let id = base;
	for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
	return id;
}

function positive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The instance used when none is configured: PI_AGY_BIN, else the `command` of the
 * single-instance config earlier versions wrote, else "agy".
 */
export function defaultInstance(): Instance {
	const saved = readJson<{ command?: unknown; contextWindow?: unknown }>(CONFIG_FILE, {});
	const command = process.env.PI_AGY_BIN || (typeof saved.command === "string" && saved.command.trim()) || "agy";
	const contextWindow = positive(saved.contextWindow);
	return { id: DEFAULT_PROVIDER_ID, name: "Antigravity", command, ...(contextWindow && { contextWindow }) };
}

/** Configured instances, or the single default instance when there are none. */
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
		const contextWindow = positive(entry.contextWindow);
		instances.push({ id, name, command, ...(contextWindow && { contextWindow }) });
	}
	return instances;
}

export function saveInstances(instances: Instance[]): boolean {
	return writeJson(CONFIG_FILE, { instances: instances.map(({ id, name, command, contextWindow }) => ({ id, name, command, contextWindow })) });
}

/**
 * The ways agy can sign in, as base commands for the setup wizard. agy keeps one
 * Google sign-in per user; other accounts go through its environment variables.
 */
export const SIGN_IN_COMMANDS = [
	{ label: "agy   (the Google account agy is signed in to)", command: "agy" },
	{ label: "AGY_ADC_AUTH=1 agy   (Application Default Credentials of gcloud)", command: "AGY_ADC_AUTH=1 agy" },
];
