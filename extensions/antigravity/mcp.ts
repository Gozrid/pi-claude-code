/**
 * pi's MCP servers for agy (see shared/pi-mcp.ts)
 *
 * agy reads its MCP servers only from `<gemini dir>/config/mcp_config.json` and
 * has no flag for another list, but its hidden `--gemini_dir` names the folder.
 * So agy gets a mirror of ~/.gemini: every entry a link to the real one (sign-in,
 * conversations, settings and projects stay shared), except mcp_config.json,
 * which lists pi's servers. An instance whose command picks its own --gemini_dir
 * keeps its servers.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { BridgeServerInfo } from "../shared/agent-bus.ts";
import { type CliMcpServer, hiddenMcpTools, mcpConfigJson, ownMcp, piMcpServers, privateDir, privateFile, viaProxy } from "../shared/pi-mcp.ts";
import { AGY_SETTINGS_FILE, readJson } from "./config.ts";
import { runtime } from "./state.ts";

const MCP_CONFIG = "mcp_config.json";

const geminiDir = () => process.env.PI_AGY_GEMINI_DIR || join(homedir(), ".gemini");

const exists = (path: string) => {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
};

/** Links every entry of `source` into `target` that is not there yet, except those in `skip`. */
function linkEntries(source: string, target: string, skip: string[]): void {
	if (!existsSync(source)) return;
	for (const name of readdirSync(source)) {
		if (skip.includes(name) || exists(join(target, name))) continue;
		symlinkSync(join(source, name), join(target, name));
	}
}

/**
 * The mirror of the gemini folder whose MCP list is `config` and, when given,
 * whose `config/hooks.json` is `hooks`; returns its path.
 */
export function geminiMirror(config: string, source = geminiDir(), hooks?: string): string {
	const hash = createHash("sha256").update(`${source}\n${config}\n${hooks ?? ""}`).digest("hex").slice(0, 16);
	const mirror = privateDir(`gemini-${hash}`);
	const configDir = privateDir(`gemini-${hash}`, "config");
	const own: Record<string, string> = { [MCP_CONFIG]: config, ...(hooks !== undefined ? { [HOOKS]: hooks } : {}) };
	linkEntries(source, mirror, ["config"]);
	linkEntries(join(source, "config"), configDir, Object.keys(own));
	for (const [name, content] of Object.entries(own)) {
		const file = join(configDir, name);
		if (!existsSync(file) || readFileSync(file, "utf8") !== content) writeFileSync(file, content, { mode: 0o600 });
	}
	return mirror;
}

const HOOKS = "hooks.json";
const GATE_HOOK = "pi-gate";

/**
 * The user's hooks plus pi's PreToolUse hook that asks pi before actions
 * (pi-bridge's gate): curl posts the hook's input to pi and prints pi's
 * decision; when pi is gone, curl fails and agy blocks the action.
 */
export function gateHooks(gate: NonNullable<BridgeServerInfo["gate"]>, source = geminiDir()): string {
	const headerFile = privateFile("agy-gate-headers", `${Object.entries(gate.headers).map(([k, v]) => `${k}: ${v}`).join("\n")}\n`);
	const command = `curl -sS --fail --max-time ${gate.timeout} -H @'${headerFile}' -H 'Content-Type: application/json' --data-binary @- '${gate.url}'`;
	const own = readJson<Record<string, unknown>>(join(source, "config", HOOKS), {});
	const hooks = { ...own, [GATE_HOOK]: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command, timeout: gate.timeout }] }] } };
	return `${JSON.stringify(hooks, null, 2)}\n`;
}

/** `--settings` for a gated run: the user's permissions with the gate's allow rules added. */
export function gateSettings(gate: NonNullable<BridgeServerInfo["gate"]>, settingsFile = AGY_SETTINGS_FILE): string[] {
	const permissions = readJson<{ permissions?: Record<string, any> }>(settingsFile, {}).permissions ?? {};
	const allow: string[] = Array.isArray(permissions.allow) ? permissions.allow : [];
	return ["--settings", JSON.stringify({ permissions: { ...permissions, allow: [...allow, ...gate.allow.filter((r) => !allow.includes(r))] } })];
}

/**
 * The arguments that give agy pi's MCP servers and only those, plus pi's own
 * server (pi-bridge) when it is on; with `none`, no servers at all. With
 * pi-bridge, the servers come through pi's own connections and show only the
 * tools pi does not hide; without it, agy starts them itself and leaves out
 * the tools pi hides (`disabledTools`).
 */
export function piMcpArgs(command: string, none = false, provider = ""): string[] {
	if (ownMcp() || /--gemini_dir\b/.test(command)) return [];
	if (none) return [`--gemini_dir=${geminiMirror(mcpConfigJson({}))}`];
	const { servers } = piMcpServers({ agentDir: getAgentDir(), cwd: runtime.cwd, projectTrusted: runtime.projectTrusted });
	const bridge = runtime.bridge?.(provider);
	const own: Record<string, CliMcpServer> = bridge ? { [bridge.name]: { type: "http", url: bridge.url, headers: bridge.headers } } : {};
	const hooks = bridge?.gate ? gateHooks(bridge.gate) : undefined;
	const proxy = bridge?.mcpUrl ? { url: (name: string) => `${bridge.mcpUrl}/${encodeURIComponent(name)}`, headers: bridge.headers } : undefined;
	if (!proxy) {
		for (const { server, tool } of hiddenMcpTools(runtime.piTools?.() ?? [], Object.keys(servers))) {
			(servers[server].disabledTools ??= []).push(tool);
		}
	}
	return [
		`--gemini_dir=${geminiMirror(mcpConfigJson({ ...viaProxy(servers, proxy), ...own }), geminiDir(), hooks)}`,
		...(bridge?.gate?.allow.length ? gateSettings(bridge.gate) : []),
	];
}
