/**
 * Watches: commands pi runs for an agent that waits on something outside, e.g.
 * `gh run watch <id> --exit-status` for a CI run. pi runs them itself, so they
 * outlive the agent's turn and its CLI process; when one ends (or hits its time
 * limit) pi tells the agent in a message that starts a new turn.
 */

import { type ChildProcess, spawn } from "node:child_process";

/** Default and largest time limit of a watch. */
export const DEFAULT_TIMEOUT_MIN = 30;
export const MAX_TIMEOUT_MIN = 180;
/** How much output is kept, and how much of its end goes into the message. */
const KEEP_CHARS = 16_000;
const TAIL_LINES = 40;
const TAIL_CHARS = 4_000;
/** Time between SIGTERM and SIGKILL when a watch is stopped. */
const KILL_GRACE_MS = 5_000;

export interface Watch {
	id: number;
	description: string;
	command: string;
	cwd: string;
	startedAt: number;
	timeoutMs: number;
}

export type WatchEndReason = "exited" | "timeout" | "stopped";

export interface WatchEnd {
	watch: Watch;
	reason: WatchEndReason;
	/** Exit code; null when a signal ended the command. */
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	/** The end of the command's output (stdout and stderr together). */
	tail: string;
	durationMs: number;
}

interface Running {
	watch: Watch;
	child: ChildProcess;
	output: string;
	reason?: WatchEndReason;
	timer: ReturnType<typeof setTimeout>;
	kill?: ReturnType<typeof setTimeout>;
	silent?: boolean;
}

export interface WatchesOptions {
	/** Called once per watch when it ended, unless it was dropped with `stopAll`. */
	onEnd(end: WatchEnd): void;
	/** Called whenever the list of running watches changed. */
	onChange?(): void;
	now?(): number;
}

export class Watches {
	private running = new Map<number, Running>();
	private nextId = 1;
	private options: WatchesOptions;

	constructor(options: WatchesOptions) {
		this.options = options;
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	start(args: { command: string; description: string; cwd: string; timeoutMs: number }): Watch {
		const watch: Watch = { id: this.nextId++, ...args, startedAt: this.now() };
		// Its own process group, so stopping it ends the commands it started too.
		const child = spawn("/bin/sh", ["-c", args.command], { cwd: args.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		const entry: Running = {
			watch,
			child,
			output: "",
			timer: setTimeout(() => this.end(watch.id, "timeout"), args.timeoutMs),
		};
		entry.timer.unref?.();
		const collect = (chunk: Buffer) => {
			entry.output = (entry.output + chunk.toString("utf8")).slice(-KEEP_CHARS);
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		child.on("error", (error) => {
			collect(Buffer.from(`\n${error.message}\n`));
		});
		child.on("close", (code, signal) => this.finish(entry, code, signal));
		this.running.set(watch.id, entry);
		this.options.onChange?.();
		return watch;
	}

	list(): Watch[] {
		return [...this.running.values()].map((r) => r.watch);
	}

	/** Stops a watch on the user's or agent's request; false when there is none with this id. */
	stop(id: number): boolean {
		return this.end(id, "stopped");
	}

	/** Ends every watch without reporting it, e.g. when the session ends. */
	stopAll(): void {
		for (const entry of this.running.values()) {
			entry.silent = true;
			this.end(entry.watch.id, "stopped");
		}
	}

	private end(id: number, reason: WatchEndReason): boolean {
		const entry = this.running.get(id);
		if (!entry || entry.reason) return false;
		entry.reason = reason;
		signalGroup(entry.child, "SIGTERM");
		entry.kill = setTimeout(() => signalGroup(entry.child, "SIGKILL"), KILL_GRACE_MS);
		entry.kill.unref?.();
		return true;
	}

	private finish(entry: Running, code: number | null, signal: NodeJS.Signals | null): void {
		clearTimeout(entry.timer);
		if (entry.kill) clearTimeout(entry.kill);
		if (!this.running.delete(entry.watch.id)) return;
		this.options.onChange?.();
		if (entry.silent) return;
		this.options.onEnd({
			watch: entry.watch,
			reason: entry.reason ?? "exited",
			exitCode: code,
			signal,
			tail: tailOf(entry.output),
			durationMs: this.now() - entry.watch.startedAt,
		});
	}
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// Already gone.
		}
	}
}

/** The last lines of the output, at most TAIL_LINES lines and TAIL_CHARS characters. */
export function tailOf(output: string): string {
	const lines = output.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
	let tail = lines.slice(-TAIL_LINES).join("\n");
	if (tail.length > TAIL_CHARS) tail = tail.slice(-TAIL_CHARS);
	return tail;
}

/** "45s", "3m 12s", "1h 5m". */
export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The message the agent gets when a watch ended. */
export function endMessage(end: WatchEnd): string {
	const { watch } = end;
	const after = formatElapsed(end.durationMs);
	const outcome =
		end.reason === "timeout"
			? `was stopped at its time limit of ${formatElapsed(watch.timeoutMs)}; the command had not ended`
			: end.reason === "stopped"
				? `was stopped after ${after}`
				: end.exitCode === 0
					? `ended successfully (exit code 0) after ${after}`
					: end.exitCode !== null
						? `failed with exit code ${end.exitCode} after ${after}`
						: `was ended by ${end.signal ?? "a signal"} after ${after}`;
	const lines = [`Watch #${watch.id} "${watch.description}" ${outcome}.`, `Command: ${watch.command}`];
	lines.push(end.tail ? `Last output:\n\`\`\`\n${end.tail}\n\`\`\`` : "It printed nothing.");
	return lines.join("\n");
}

/** The time limit in ms from the agent's minutes, clamped to 1..MAX_TIMEOUT_MIN. */
export function timeoutMsOf(minutes: unknown): number {
	const value = typeof minutes === "number" && Number.isFinite(minutes) ? minutes : DEFAULT_TIMEOUT_MIN;
	return Math.round(Math.min(MAX_TIMEOUT_MIN, Math.max(1, value)) * 60_000);
}

/** What the chat and the widget need of pi's theme. */
interface Colors {
	fg(color: "accent" | "dim" | "success" | "error" | "warning" | "text", text: string): string;
}

/** The lines above the editor while watches run. */
export function watchLines(theme: Colors, watches: Watch[], now: number): string[] {
	return watches.map(
		(w) =>
			`${theme.fg("accent", "⏳ ")}${theme.fg("text", `Waiting for ${w.description}`)}${theme.fg("dim", ` · ${formatElapsed(now - w.startedAt)} · #${w.id} · /watches to stop`)}`,
	);
}

/** The headline of an ended watch in the chat. */
export function endHeadline(theme: Colors, end: Pick<WatchEnd, "reason" | "exitCode" | "durationMs"> & { description: string; id: number }): string {
	const [mark, color, word] =
		end.reason === "timeout"
			? (["⏱", "warning", "reached its time limit"] as const)
			: end.reason === "stopped"
				? (["■", "warning", "stopped"] as const)
				: end.exitCode === 0
					? (["✓", "success", "done"] as const)
					: (["✗", "error", end.exitCode === null ? "ended" : `failed (exit code ${end.exitCode})`] as const);
	return `${theme.fg(color, `${mark} `)}${theme.fg("text", `Watch #${end.id} ${end.description}: ${word}`)}${theme.fg("dim", ` · ${formatElapsed(end.durationMs)}`)}`;
}
