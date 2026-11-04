/**
 * Starting the Antigravity CLI (`agy`) and asking it for its models and plan usage.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { DEFAULT_PROVIDER_ID, MODELS_FILE, readJson, writeJson } from "./config.ts";
import { type PlanUsage, parseUsage } from "./usage.ts";

const QUERY_TIMEOUT_MS = 30_000;

/**
 * Starts the base command with extra arguments through /bin/sh, so the command may
 * carry env assignments, `~` or flags. The shell gets its own process group and
 * stopAgy() signals the whole group.
 */
export function spawnAgy(
	command: string,
	args: string[],
	options: { cwd: string; env?: Record<string, string> },
): ChildProcessWithoutNullStreams {
	return spawn("/bin/sh", ["-c", `${command} "$@"`, "agy", ...args], {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		stdio: ["pipe", "pipe", "pipe"],
		detached: true,
	});
}

/** Signals the shell and the agy process it started. */
export function stopAgy(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
	try {
		if (child.pid) process.kill(-child.pid, signal);
	} catch {
		// The group is already gone.
	}
}

// =============================================================================
// Models
// =============================================================================

/**
 * One model of `agy models`. agy lists each effort as a model of its own
 * (gemini-4-argon-low, gemini-4-argon-high, …); pi gets one model per family
 * and pi's thinking level picks the variant.
 */
export interface AgyModel {
	/** Family id without the effort, e.g. "gemini-4-argon". */
	id: string;
	/** e.g. "Gemini 4 Argon". */
	name: string;
	/** Effort levels agy offers, smallest first; empty for a model without variants. */
	efforts: string[];
}

const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** Parses `agy models` ("<id>\t<name>" per line) into model families. */
export function parseModels(output: string): AgyModel[] {
	const families = new Map<string, AgyModel>();
	for (const line of output.split("\n")) {
		const [id, label] = line.split("\t").map((part) => part?.trim());
		if (!id || !label || /\s/.test(id)) continue;
		const effort = id.match(/-(minimal|low|medium|high|xhigh|max)$/)?.[1];
		const base = effort ? id.slice(0, -(effort.length + 1)) : id;
		const name = label.replace(/\s*\((minimal|low|medium|high|xhigh|max)\)\s*$/i, "");
		const family = families.get(base) ?? { id: base, name, efforts: [] };
		if (effort && !family.efforts.includes(effort)) family.efforts.push(effort);
		families.set(base, family);
	}
	for (const family of families.values()) {
		family.efforts.sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
	}
	return [...families.values()];
}

/** The agy model id for a family and pi's thinking level: the variant of that effort, else a middle one. */
export function variantId(model: AgyModel | undefined, familyId: string, level: string | undefined): string {
	if (!model || model.efforts.length === 0) return familyId;
	const wanted = level === "minimal" ? "low" : level;
	const effort =
		wanted && model.efforts.includes(wanted)
			? wanted
			: model.efforts.includes("medium")
				? "medium"
				: model.efforts[Math.floor((model.efforts.length - 1) / 2)];
	return `${familyId}-${effort}`;
}

/** The family's smallest variant, from the smallest family: flash before the rest. */
export function smallestVariant(models: readonly AgyModel[]): string | undefined {
	// Whole name parts only: "gemini" holds "mini".
	const small = models.find((m) => /(^|[-_.])(flash|lite|mini|nano|haiku)([-_.]|$)/i.test(m.id)) ?? models[0];
	if (!small) return undefined;
	return small.efforts.length > 0 ? `${small.id}-${small.efforts[0]}` : small.id;
}

/** Asks agy for its models; rejects when it fails or takes too long. */
export function queryModels(command: string, cwd: string): Promise<AgyModel[]> {
	return new Promise((resolve, reject) => {
		const child = spawnAgy(command, ["models"], { cwd });
		let out = "";
		let err = "";
		const timer = setTimeout(() => {
			stopAgy(child, "SIGTERM");
			reject(new Error("agy models took too long"));
		}, QUERY_TIMEOUT_MS);
		timer.unref?.();
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.stderr.on("data", (chunk) => {
			err += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const models = parseModels(out);
			if (models.length > 0) resolve(models);
			else reject(new Error(err.trim() || `agy models exited with code ${code}`));
		});
		child.stdin.end();
	});
}

/** Asks agy for its quota buckets (`agy -p /usage --output-format json`); undefined when unavailable. */
export function queryUsage(command: string, cwd: string): Promise<PlanUsage | undefined> {
	return new Promise((resolve) => {
		const child = spawnAgy(command, ["-p", "/usage", "--output-format", "json"], { cwd });
		let out = "";
		const timer = setTimeout(() => {
			stopAgy(child, "SIGTERM");
			resolve(undefined);
		}, QUERY_TIMEOUT_MS);
		timer.unref?.();
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolve(undefined);
		});
		child.on("close", () => {
			clearTimeout(timer);
			resolve(parseUsage(out));
		});
		child.stdin.end();
	});
}

interface ModelsCacheFile {
	instances?: Record<string, { updatedAt: string; models: AgyModel[] }>;
	/** Single-instance layout written by earlier versions. */
	models?: AgyModel[];
}

export function loadCachedModels(providerId: string): AgyModel[] | undefined {
	const cache = readJson<ModelsCacheFile>(MODELS_FILE, {});
	const models = cache.instances?.[providerId]?.models ?? (providerId === DEFAULT_PROVIDER_ID ? cache.models : undefined);
	return Array.isArray(models) && models.length > 0 ? models : undefined;
}

export function saveCachedModels(providerId: string, models: AgyModel[]): void {
	const cache = readJson<ModelsCacheFile>(MODELS_FILE, {});
	const instances = { ...cache.instances };
	if (!cache.instances && Array.isArray(cache.models)) {
		instances[DEFAULT_PROVIDER_ID] = { updatedAt: new Date().toISOString(), models: cache.models };
	}
	instances[providerId] = { updatedAt: new Date().toISOString(), models };
	writeJson(MODELS_FILE, { instances });
}

const PI_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** pi model for an agy model family; the instance name tells several accounts apart in /model. */
export function toProviderModel(m: AgyModel, instanceName?: string) {
	const reasoning = m.efforts.length > 1;
	const thinkingLevelMap: Record<string, string | null> = { off: null };
	for (const level of PI_LEVELS) thinkingLevelMap[level] = m.efforts.includes(level) ? level : null;
	return {
		id: m.id,
		name: instanceName ? `Antigravity · ${m.name} @ ${instanceName}` : `Antigravity · ${m.name}`,
		reasoning,
		thinkingLevelMap: reasoning ? thinkingLevelMap : undefined,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// agy keeps its own context; a large window keeps pi from compacting on top.
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	};
}
