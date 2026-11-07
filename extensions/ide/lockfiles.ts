/**
 * Finding the IDE to connect to.
 *
 * The Claude Code plugins for JetBrains IDEs and VS Code run a small MCP server
 * over WebSocket in the IDE and announce it with a lock file
 * `~/.claude/ide/<port>.lock` (or in $CLAUDE_CONFIG_DIR/ide):
 *   {"pid":…,"workspaceFolders":["/…"],"ideName":"IntelliJ IDEA","transport":"ws","authToken":"…"}
 * pi takes the one whose project holds pi's folder (or lies in it), like Claude
 * Code does; started in the IDE's own terminal, CLAUDE_CODE_SSE_PORT names it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, isAbsolute } from "node:path";

export interface IdeLock {
	port: number;
	pid?: number;
	ideName: string;
	workspaceFolders: string[];
	authToken?: string;
	transport: string;
}

export function parseLock(fileName: string, content: string): IdeLock | undefined {
	const port = Number(/^(\d+)\.lock$/.exec(fileName)?.[1]);
	if (!port) return undefined;
	try {
		const data = JSON.parse(content);
		if (!data || typeof data !== "object") return undefined;
		const transport = typeof data.transport === "string" ? data.transport : data.useWebSocket ? "ws" : "sse";
		return {
			port,
			pid: typeof data.pid === "number" ? data.pid : undefined,
			ideName: typeof data.ideName === "string" && data.ideName ? data.ideName : "IDE",
			workspaceFolders: Array.isArray(data.workspaceFolders) ? data.workspaceFolders.filter((f: unknown) => typeof f === "string") : [],
			authToken: typeof data.authToken === "string" ? data.authToken : undefined,
			transport,
		};
	} catch {
		return undefined;
	}
}

/** The folders that may hold lock files: ~/.claude, $CLAUDE_CONFIG_DIR and the other ~/.claude-* logins. */
export function lockDirs(home = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
	const dirs = new Set<string>([join(home, ".claude", "ide")]);
	if (env.CLAUDE_CONFIG_DIR) dirs.add(join(env.CLAUDE_CONFIG_DIR, "ide"));
	try {
		for (const entry of readdirSync(home, { withFileTypes: true })) {
			if (entry.isDirectory() && entry.name.startsWith(".claude-")) dirs.add(join(home, entry.name, "ide"));
		}
	} catch {
		// No home to look in.
	}
	return [...dirs];
}

function alive(pid: number | undefined): boolean {
	if (pid === undefined) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Every lock file of a running IDE that speaks WebSocket (the only transport both plugins use today). */
export function readLocks(dirs = lockDirs()): IdeLock[] {
	const locks = new Map<number, IdeLock>();
	for (const dir of dirs) {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".lock")) continue;
			let content: string;
			try {
				content = readFileSync(join(dir, name), "utf8");
			} catch {
				continue;
			}
			const lock = parseLock(name, content);
			if (lock && lock.transport === "ws" && alive(lock.pid)) locks.set(lock.port, lock);
		}
	}
	return [...locks.values()];
}

function inside(path: string, folder: string): boolean {
	const rel = relative(folder, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** How well a lock fits pi's folder: 2 its project holds the folder, 1 it lies inside it, 0 not at all; deeper projects first. */
function fit(lock: IdeLock, cwd: string): number {
	let best = 0;
	for (const folder of lock.workspaceFolders) {
		if (inside(cwd, folder)) best = Math.max(best, 2_000 + folder.length);
		else if (inside(folder, cwd)) best = Math.max(best, 1_000 - folder.length / 1_000);
	}
	return best;
}

/** The IDE for pi's folder; the one named by CLAUDE_CODE_SSE_PORT first. */
export function pickLock(locks: IdeLock[], cwd: string, ssePort?: string): IdeLock | undefined {
	const port = Number(ssePort);
	const named = port ? locks.find((l) => l.port === port) : undefined;
	if (named && fit(named, cwd) > 0) return named;
	let best: IdeLock | undefined;
	let bestFit = 0;
	for (const lock of locks) {
		const f = fit(lock, cwd);
		if (f > bestFit) {
			best = lock;
			bestFit = f;
		}
	}
	return best;
}
