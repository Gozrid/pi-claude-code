import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { openBrowser } from "../shared/account-ui.ts";
import { withClient, type CodexClient, type Fields } from "./client.ts";
import type { UsageLimitWindow } from "../shared/agent-bus.ts";

export interface Instance {
	id: string;
	name: string;
	command: string;
}
export interface CliModel {
	id: string;
	name: string;
	efforts: string[];
	image: boolean;
}
const agentDir = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
export const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
function read<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
		throw error;
	}
}
function write(file: string, data: unknown) {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const temp = file + "." + randomUUID();
	writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
	renameSync(temp, file);
}
export function configured(): Instance[] {
	return read<{ instances: Instance[] }>(join(agentDir(), "codex-cli.json"), { instances: [] }).instances;
}
export const saveInstances = (instances: Instance[]) => write(join(agentDir(), "codex-cli.json"), { instances });
export const defaultInstance = (): Instance => ({ id: "codex-cli", name: "Codex", command: process.env.PI_CODEX_BIN || "codex" });
export function instanceId(name: string, instances: Instance[]) {
	const slug =
		name
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[\u0300-\u036f]/g, "")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "") || "account";
	const base = "codex-cli-" + slug;
	let id = base;
	for (let n = 2; instances.some((i) => i.id === id); n++) id = base + "-" + n;
	return id;
}
export const scratchDir = (session: string) => {
	const dir = join(process.env.PI_CODEX_SCRATCH_DIR || join(tmpdir(), "pi-codex-cli"), digest(session));
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
};
const cachePath = (i: Instance) => join(agentDir(), "codex-cli-models", digest(i.id + "\n" + i.command) + ".json");
export const cachedModels = (i: Instance) => read<CliModel[]>(cachePath(i), []);
export const saveModels = (i: Instance, models: CliModel[]) => write(cachePath(i), models);

export async function listModels(client: CodexClient): Promise<CliModel[]> {
	const models: CliModel[] = [];
	let cursor: string | undefined;
	let recommended: string | undefined;
	do {
		const page = await client.request("model/list", { cursor, limit: 100 });
		for (const m of page.data) {
			if (m.isDefault) recommended = m.model;
			if (!m.hidden && m.model)
				models.push({
					id: m.model,
					name: m.displayName || m.model,
					image: m.inputModalities?.includes("image") ?? true,
					efforts: (m.supportedReasoningEfforts ?? []).map((e: Fields) => e.reasoningEffort),
				});
		}
		cursor = page.nextCursor;
	} while (cursor);
	if (!models.length) throw new Error("Codex returned no selectable models.");
	const { config } = await client.request("config/read");
	const actual = models.find((m) => m.id === (config.model || recommended));
	if (actual) models.push({ ...actual, id: "default", name: "CLI default → " + actual.name });
	return models;
}
export const selectable = (models: CliModel[]) => [
	models.find((m) => m.id === "default") ?? defaultModel,
	...models.filter((m) => m.id !== "default"),
];

/** The default alias works before discovery and follows the CLI's configured model. */
export const defaultModel: CliModel = { id: "default", name: "CLI default", efforts: [], image: true };
export function providerModel(i: Instance, m: CliModel) {
	const levels: Record<string, string | null> = {};
	for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
		const cli = level === "off" ? "none" : level;
		levels[level] = m.efforts.includes(cli) ? cli : null;
	}
	return {
		id: m.id,
		name: `${i.name} · ${m.name}`,
		reasoning: !!m.efforts.length,
		thinkingLevelMap: m.efforts.length ? levels : undefined,
		input: (m.image ? ["text", "image"] : ["text"]) as ("text" | "image")[],
		contextWindow: 1_000_000,
		maxTokens: 64_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

export function windows(snapshot: Fields | undefined): UsageLimitWindow[] {
	return ["primary", "secondary"].flatMap((id) => {
		const w = snapshot?.[id];
		if (!w || !Number.isFinite(w.usedPercent)) return [];
		const minutes = w.windowDurationMins;
		const label =
			minutes === 10080 ? "Weekly" : minutes > 0 && minutes % 60 === 0 ? minutes / 60 + "h" : minutes ? minutes + " min" : id;
		return [{ id, label, percent: w.usedPercent, resetsAt: w.resetsAt ? w.resetsAt * 1000 : undefined }];
	});
}

/** Keep the default meters first for the footer and expose any additional model buckets in /usage. */
export function accountWindows(reply: Fields): UsageLimitWindow[] {
	const primary = reply.rateLimits;
	const all = windows(primary);
	for (const [id, bucket] of Object.entries(reply.rateLimitsByLimitId ?? {}) as [string, Fields][]) {
		if (!bucket || id === (primary?.limitId ?? "codex")) continue;
		for (const w of windows(bucket)) all.push({ ...w, id: id + "/" + w.id, label: (bucket.limitName || id) + " · " + w.label });
	}
	return all;
}

export async function login(i: Instance, cwd: string, show: (url: string) => void, signal?: AbortSignal) {
	await withClient(i.command, cwd, async (client) => {
		const abort = () => client.close(new Error("Codex sign-in cancelled"));
		signal?.throwIfAborted();
		signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => client.close(new Error("Codex sign-in timed out")), 5 * 60_000);
		try {
			const finished = new Promise<Fields>((resolve) => {
				client.onEvent = (method, params) => {
					if (method === "account/login/completed") resolve(params);
				};
			});
			const { authUrl } = await client.request("account/login/start", { type: "chatgpt" });
			if (!/^https?:\/\//i.test(authUrl)) throw new Error("Codex did not return a browser sign-in URL.");
			show(authUrl);
			if (!process.env.PI_CODEX_NO_BROWSER) openBrowser(authUrl);
			const done = await Promise.race([finished, client.stopped]);
			if (done instanceof Error) throw done;
			if (!done.success) throw new Error(done.error || "Codex sign-in failed");
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		}
	});
}
export const credentials = () => ({ access: "codex-cli", refresh: "codex-cli", expires: Date.now() + 365 * 86400_000 });
export const oauthLogin = (i: Instance, cwd: string, cb: OAuthLoginCallbacks) =>
	login(i, cwd, (url) => cb.onAuth({ url }), cb.signal);
