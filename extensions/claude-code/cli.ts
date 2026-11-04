/**
 * Starting a Claude CLI instance and asking it about models and usage.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { DEFAULT_PROVIDER_ID, type Instance, MODELS_FILE, readJson, writeJson } from "./config.ts";
import type { InstanceState } from "./state.ts";
import { type PlanUsage, usageFromGetUsage } from "./usage.ts";

const QUERY_TIMEOUT_MS = 20_000;

/** A nested CLI started from inside Claude Code must not believe it is a subprocess of it. */
/**
 * How long Claude waits for an MCP tool call (MCP_TOOL_TIMEOUT, ms). Its own
 * default ends a call after 60 seconds, which cuts off pi's dialogs (`ask`,
 * permission prompts) while the user is still answering. 20 days is as good as
 * no limit and stays below the largest timer Node takes (about 24.8 days).
 */
export const MCP_TOOL_TIMEOUT_MS = 20 * 24 * 3600_000;

export function childEnv(extra?: Record<string, string>, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS), ...base, ...extra };
	delete env.CLAUDECODE;
	return env;
}

/**
 * Starts the instance's base command with extra arguments. The command may carry env
 * assignments, `~` or flags, so /bin/sh resolves it. `exec` cannot be used here (it
 * would treat a leading `VAR=value` as the program), so the shell gets its own process
 * group and stopClaude() signals the whole group.
 */
export function spawnClaude(
	instance: Instance,
	args: string[],
	options: { cwd: string; env?: Record<string, string> },
): ChildProcessWithoutNullStreams {
	return spawn("/bin/sh", ["-c", `${instance.command} "$@"`, "claude", ...args], {
		cwd: options.cwd,
		env: childEnv(options.env),
		stdio: ["pipe", "pipe", "pipe"],
		detached: true,
	});
}

/** Signals the shell and the claude process it started. */
export function stopClaude(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
	try {
		if (child.pid) process.kill(-child.pid, signal);
	} catch {
		// The group is already gone.
	}
}

// =============================================================================
// Models
// =============================================================================

/** One entry of the `models` list in Claude Code's `initialize` response. */
export interface CliModel {
	value: string;
	resolvedModel?: string;
	displayName?: string;
	description?: string;
	supportsEffort?: boolean;
	supportedEffortLevels?: string[];
}

export const FALLBACK_MODELS: CliModel[] = ["opus", "sonnet", "haiku", "fable"].map((value) => ({
	value,
	displayName: value[0].toUpperCase() + value.slice(1),
	supportsEffort: true,
	supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
}));

interface ModelsCacheEntry {
	updatedAt: string;
	claudeVersion?: string;
	models: CliModel[];
}

interface ModelsCacheFile {
	instances?: Record<string, ModelsCacheEntry>;
	/** Single-instance layout written by earlier versions. */
	models?: CliModel[];
}

export function loadCachedModels(providerId: string): CliModel[] | undefined {
	const cache = readJson<ModelsCacheFile>(MODELS_FILE, {});
	const models = cache.instances?.[providerId]?.models ?? (providerId === DEFAULT_PROVIDER_ID ? cache.models : undefined);
	return Array.isArray(models) && models.length > 0 ? models : undefined;
}

export function saveCachedModels(providerId: string, models: CliModel[], claudeVersion: string | undefined): void {
	const cache = readJson<ModelsCacheFile>(MODELS_FILE, {});
	const instances = { ...cache.instances };
	if (!cache.instances && Array.isArray(cache.models)) {
		instances[DEFAULT_PROVIDER_ID] = { updatedAt: new Date().toISOString(), models: cache.models };
	}
	instances[providerId] = { updatedAt: new Date().toISOString(), claudeVersion, models };
	// Without a cache the next start registers the fallback aliases until discovery finishes.
	writeJson(MODELS_FILE, { instances });
}

export function sameModels(a: CliModel[], b: CliModel[]): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The CLI lists its newest models only behind aliases (opus → claude-opus-5-5).
 * Adds each alias target as a pinned entry so the exact version is selectable too.
 */
export function withPinnedModels(models: CliModel[]): CliModel[] {
	const ids = new Set(models.map((m) => m.value));
	const pinned: CliModel[] = [];
	for (const m of models) {
		const target = m.resolvedModel;
		if (!target || ids.has(target) || m.value === "default") continue;
		ids.add(target);
		pinned.push({ ...m, value: target, resolvedModel: target });
	}
	return [...models, ...pinned];
}

const PI_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

export function toProviderModel(instanceName: string, m: CliModel) {
	const efforts = m.supportsEffort ? (m.supportedEffortLevels ?? []) : [];
	const thinkingLevelMap: Record<string, string | null> = {
		// The CLI has no switch to turn thinking off or to go below its lowest effort.
		off: null,
		minimal: null,
	};
	for (const level of PI_EFFORT_LEVELS) thinkingLevelMap[level] = efforts.includes(level) ? level : null;

	const name = m.displayName ?? m.value;
	const isAlias = m.resolvedModel !== undefined && m.resolvedModel !== m.value;
	const label =
		m.value === "default"
			? `${name}${m.resolvedModel ? ` → ${m.resolvedModel}` : ""}`
			: isAlias
				? `${m.value} (latest, now ${name})`
				: name;

	return {
		id: m.value,
		name: `${instanceName} · ${label}`,
		reasoning: efforts.length > 0,
		thinkingLevelMap: efforts.length > 0 ? thinkingLevelMap : undefined,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// Claude Code compacts its own context; a large window keeps pi from compacting on top.
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	};
}

/** The model's display name, resolving aliases and "default" to the model they point at. */
export function modelLabel(models: CliModel[], id: string): string {
	const entry = models.find((m) => m.value === id);
	const target = entry?.resolvedModel ?? id;
	const named = models.find((m) => m.value !== "default" && (m.resolvedModel ?? m.value) === target);
	return named?.displayName ?? entry?.displayName ?? id;
}

// =============================================================================
// Querying the CLI (no model request, no tokens)
// =============================================================================

export interface CliInfo {
	models: CliModel[];
	version?: string;
	usage?: PlanUsage;
	account?: { email?: string; subscriptionType?: string };
}

export function thinkingDisplayArgs(state: InstanceState): string[] {
	return state.thinkingDisplay ? ["--thinking-display", state.thinkingDisplay] : [];
}

/**
 * Asks the CLI which models this account can use and how much of the plan limits is used.
 * Also probes --thinking-display: a CLI without it rejects the flag before answering.
 */
export async function queryCli(state: InstanceState, cwd: string): Promise<CliInfo> {
	try {
		return await queryCliWith(state.instance, cwd, thinkingDisplayArgs(state));
	} catch (error) {
		if (!state.thinkingDisplay || !/unknown option '--thinking-display'/.test(String(error))) throw error;
		state.thinkingDisplay = undefined;
		return queryCliWith(state.instance, cwd, []);
	}
}

function queryCliWith(instance: Instance, cwd: string, extraArgs: string[]): Promise<CliInfo> {
	return new Promise((resolve, reject) => {
		const child = spawnClaude(
			instance,
			[
				"-p",
				"--input-format",
				"stream-json",
				"--output-format",
				"stream-json",
				"--verbose",
				"--no-session-persistence",
				...extraArgs,
			],
			{ cwd },
		);
		let settled = false;
		let stderr = "";
		let info: CliInfo | undefined;
		const send = (id: string, subtype: string) =>
			child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: id, request: { subtype } })}\n`);
		const finish = (error?: Error, value?: CliInfo) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.stdin.end();
			stopClaude(child, "SIGTERM");
			if (error) reject(error);
			else resolve(value!);
		};
		const timer = setTimeout(
			() => (info ? finish(undefined, info) : finish(new Error("claude did not answer the model query in time"))),
			QUERY_TIMEOUT_MS,
		);
		child.on("error", (error) => finish(error));
		child.on("close", (code) =>
			info ? finish(undefined, info) : finish(new Error(stderr.trim() || `claude exited with code ${code}`)),
		);
		child.stdin.on("error", () => {});
		child.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		const rl = createInterface({ input: child.stdout });
		rl.on("line", (line) => {
			let msg: any;
			try {
				msg = JSON.parse(line);
			} catch {
				return;
			}
			if (msg.type !== "control_response") return;
			const id = msg.response?.request_id;
			const response = msg.response?.response ?? {};
			if (id === "pi-models") {
				const models = (response.models ?? []).filter((m: any) => typeof m?.value === "string");
				if (msg.response.subtype === "error" || models.length === 0) {
					finish(new Error(msg.response.error || "claude returned no models"));
					return;
				}
				const account = response.account;
				info = {
					models,
					version: response.claude_code_version,
					account: account ? { email: account.email, subscriptionType: account.subscriptionType } : undefined,
				};
				// get_usage is not part of the documented SDK protocol; without it only the model list is used.
				send("pi-usage", "get_usage");
			} else if (id === "pi-usage" && info) {
				if (msg.response.subtype !== "error") info.usage = usageFromGetUsage(response);
				finish(undefined, info);
			}
		});
		send("pi-models", "initialize");
	});
}
