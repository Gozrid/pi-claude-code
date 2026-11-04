/**
 * pi's MCP servers for the CLI providers
 *
 * The Claude Code CLI and agy each have MCP servers of their own. Started from
 * pi, they get pi's servers instead and only those: the ones in pi's `mcp.json`
 * (`~/.pi/agent/mcp.json`, and `<project>/.pi/mcp.json` in a trusted project),
 * read the way pi reads them. Started on their own, the CLIs keep theirs.
 *
 * pi connects these servers itself. With pi-bridge on, the CLIs reach them
 * through pi's connections (proxied), so no server runs twice and pi's
 * `exposure`/`toolExposure` decide which tools they see. Without it, the CLIs
 * start the servers themselves from the entries read here.
 *
 * PI_CLI_OWN_MCP=1 lets the CLIs use their own servers again.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** A server as both CLIs take it in their `mcpServers`. */
export type CliMcpServer = (
	| { command: string; args: string[]; env?: Record<string, string> }
	| { type: "http"; url: string; headers?: Record<string, string> }
) & {
	/** agy only: tools of the server it leaves out. */
	disabledTools?: string[];
};

export interface PiMcpServers {
	servers: Record<string, CliMcpServer>;
	/** Entries left out, with the reason. */
	errors: string[];
}

export interface PiMcpOptions {
	/** pi's agent directory (getAgentDir()). */
	agentDir: string;
	/** The session's working directory. */
	cwd: string;
	/** Whether the project is trusted; only then counts its `.pi/mcp.json`. */
	projectTrusted: boolean;
	home?: string;
	env?: NodeJS.ProcessEnv;
}

/** Whether the CLIs keep their own servers (PI_CLI_OWN_MCP=1). */
export const ownMcp = () => process.env.PI_CLI_OWN_MCP === "1";

type Raw = Record<string, unknown>;

function readServers(file: string, errors: string[]): Record<string, Raw> {
	if (!existsSync(file)) return {};
	try {
		const servers = (JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: unknown }).mcpServers;
		return servers && typeof servers === "object" ? (servers as Record<string, Raw>) : {};
	} catch (error) {
		errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
		return {};
	}
}

/** `${NAME}` from the environment; a value that is `!command` is the command's output (as pi does it). */
function resolveValue(value: string, env: NodeJS.ProcessEnv, cwd: string): string {
	if (value.startsWith("!")) return execSync(value.slice(1), { cwd, env, encoding: "utf8", timeout: 10_000 }).trim();
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => env[name] ?? "");
}

function resolveRecord(record: unknown, env: NodeJS.ProcessEnv, cwd: string): Record<string, string> | undefined {
	if (!record || typeof record !== "object") return undefined;
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(record as Raw)) if (typeof value === "string") out[key] = resolveValue(value, env, cwd);
	return Object.keys(out).length > 0 ? out : undefined;
}

const expandHome = (value: string, home: string) => (value.startsWith("~/") ? join(home, value.slice(2)) : value);

function toCli(entry: Raw, options: Required<Omit<PiMcpOptions, "projectTrusted" | "agentDir">>): CliMcpServer {
	const { cwd, home, env } = options;
	if (entry.type === "sse") throw new Error("SSE is not supported");
	if (typeof entry.url === "string") {
		const headers = resolveRecord(entry.headers, env, cwd);
		return { type: "http", url: entry.url, ...(headers ? { headers } : {}) };
	}
	if (typeof entry.command !== "string") throw new Error("neither command nor url");
	const command = expandHome(entry.command, home);
	const args = (Array.isArray(entry.args) ? entry.args : []).map((a) => expandHome(String(a), home));
	const serverEnv = resolveRecord(entry.env, env, cwd);
	const base = { ...(serverEnv ? { env: serverEnv } : {}) };
	if (typeof entry.cwd !== "string") return { command, args, ...base };
	// Neither CLI knows `cwd`, so the server starts through a shell that changes there first.
	const dir = expandHome(entry.cwd, home);
	const at = isAbsolute(dir) ? dir : resolve(cwd, dir);
	return { command: "/bin/sh", args: ["-c", 'cd "$0" && exec "$@"', at, command, ...args], ...base };
}

/** pi's enabled MCP servers, global and project merged as pi merges them. */
export function piMcpServers(options: PiMcpOptions): PiMcpServers {
	const errors: string[] = [];
	const merged: Record<string, Raw> = { ...readServers(join(options.agentDir, "mcp.json"), errors) };
	if (options.projectTrusted) {
		for (const [name, entry] of Object.entries(readServers(join(options.cwd, ".pi", "mcp.json"), errors))) {
			const onlyOverride = !("command" in entry || "url" in entry || "type" in entry);
			merged[name] = onlyOverride && merged[name] ? { ...merged[name], ...pick(entry, ["enabled", "exposure", "toolExposure"]) } : entry;
		}
	}
	const servers: Record<string, CliMcpServer> = {};
	const context = { cwd: options.cwd, home: options.home ?? homedir(), env: options.env ?? process.env };
	for (const [name, entry] of Object.entries(merged)) {
		if (!entry || typeof entry !== "object" || entry.enabled === false || allHidden(entry)) continue;
		try {
			servers[name] = toCli(entry, context);
		} catch (error) {
			errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { servers, errors };
}

/** A hidden server whose `toolExposure` shows none of its tools. */
function allHidden(entry: Raw): boolean {
	if (entry.exposure !== "hidden") return false;
	const tools = entry.toolExposure;
	return !tools || typeof tools !== "object" || Object.values(tools as Raw).every((exposure) => exposure === "hidden");
}

/**
 * The servers as the CLI gets them: through pi's own connections when pi-bridge
 * proxies them (`proxy`: its URL for a server and the client's headers),
 * otherwise as they are.
 */
export function viaProxy(
	servers: Record<string, CliMcpServer>,
	proxy: { url: (server: string) => string; headers: Record<string, string> } | undefined,
): Record<string, CliMcpServer> {
	if (!proxy) return servers;
	return Object.fromEntries(Object.keys(servers).map((name) => [name, { type: "http", url: proxy.url(name), headers: proxy.headers }]));
}

/** What pi tells about a tool (pi.getAllTools()), as far as needed here. */
export interface PiToolInfo {
	name: string;
	exposure?: string;
	sourceInfo?: { path?: string };
}

/** Where the tools of pi's own MCP support come from. */
export const PI_MCP_SOURCE = "builtin:mcp";

/**
 * The tools pi's `exposure`/`toolExposure` hide, for a CLI that starts `servers`
 * itself. Known only once pi has connected the server. pi names a tool
 * `mcp__<server>__<tool>` with every character other than letters, digits and
 * `_` written as `_`; the server's own name is taken from `servers`.
 */
export function hiddenMcpTools(tools: readonly PiToolInfo[], servers: readonly string[]): { server: string; tool: string }[] {
	const piName = (name: string) => name.replace(/[^A-Za-z0-9_]/g, "_");
	return tools.flatMap((tool) => {
		if (tool.exposure !== "hidden" || tool.sourceInfo?.path !== PI_MCP_SOURCE) return [];
		const server = servers.find((name) => tool.name.startsWith(`mcp__${piName(name)}__`));
		return server ? [{ server, tool: tool.name.slice(`mcp__${piName(server)}__`.length) }] : [];
	});
}

function pick(entry: Raw, keys: string[]): Raw {
	return Object.fromEntries(keys.filter((k) => k in entry).map((k) => [k, entry[k]]));
}

/** A folder only the user can read, for files with the servers' credentials. */
export function privateDir(...parts: string[]): string {
	const dir = join(process.env.PI_MCP_DIR || join(tmpdir(), "pi-mcp"), ...parts);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	return dir;
}

/** Writes `content` once into the private folder, named by its content; returns the path. */
export function privateFile(name: string, content: string): string {
	const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
	const file = join(privateDir(), `${name}-${hash}.json`);
	if (!existsSync(file)) writeFileSync(file, content, { mode: 0o600 });
	return file;
}

export const mcpConfigJson = (servers: Record<string, CliMcpServer>) => `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
