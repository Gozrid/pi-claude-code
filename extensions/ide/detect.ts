/**
 * Supported IDEs that run without their Claude Code integration: JetBrains IDEs
 * without the "Claude Code [Beta]" plugin, VS Code (and Cursor, Windsurf)
 * without the Claude Code extension, or with it installed but no server running
 * (no lock file of that IDE). pi points them out above the editor.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface IdeKind {
	/** Name the hint shows. */
	name: string;
	family: "jetbrains" | "vscode";
	/** Name of the app's executable in Contents/MacOS (macOS) or on Linux. */
	executables: string[];
	/** JetBrains: prefixes of the config folders (IntelliJIdea2026.2); VS Code: extension folders. */
	configs: string[];
}

const JETBRAINS = "Library/Application Support/JetBrains";

export const IDE_KINDS: IdeKind[] = [
	{ name: "IntelliJ IDEA", family: "jetbrains", executables: ["idea"], configs: [`${JETBRAINS}/IntelliJIdea`, `${JETBRAINS}/IdeaIC`, ".config/JetBrains/IntelliJIdea", ".config/JetBrains/IdeaIC"] },
	{ name: "WebStorm", family: "jetbrains", executables: ["webstorm"], configs: [`${JETBRAINS}/WebStorm`, ".config/JetBrains/WebStorm"] },
	{ name: "PyCharm", family: "jetbrains", executables: ["pycharm"], configs: [`${JETBRAINS}/PyCharm`, ".config/JetBrains/PyCharm"] },
	{ name: "Rider", family: "jetbrains", executables: ["rider"], configs: [`${JETBRAINS}/Rider`, ".config/JetBrains/Rider"] },
	{ name: "CLion", family: "jetbrains", executables: ["clion"], configs: [`${JETBRAINS}/CLion`, ".config/JetBrains/CLion"] },
	{ name: "GoLand", family: "jetbrains", executables: ["goland"], configs: [`${JETBRAINS}/GoLand`, ".config/JetBrains/GoLand"] },
	{ name: "PhpStorm", family: "jetbrains", executables: ["phpstorm"], configs: [`${JETBRAINS}/PhpStorm`, ".config/JetBrains/PhpStorm"] },
	{ name: "RubyMine", family: "jetbrains", executables: ["rubymine"], configs: [`${JETBRAINS}/RubyMine`, ".config/JetBrains/RubyMine"] },
	{ name: "RustRover", family: "jetbrains", executables: ["rustrover"], configs: [`${JETBRAINS}/RustRover`, ".config/JetBrains/RustRover"] },
	{ name: "DataGrip", family: "jetbrains", executables: ["datagrip"], configs: [`${JETBRAINS}/DataGrip`, ".config/JetBrains/DataGrip"] },
	{ name: "Android Studio", family: "jetbrains", executables: ["studio"], configs: ["Library/Application Support/Google/AndroidStudio", ".config/Google/AndroidStudio"] },
	{ name: "Visual Studio Code", family: "vscode", executables: ["Code", "code"], configs: [".vscode/extensions"] },
	{ name: "Cursor", family: "vscode", executables: ["Cursor", "cursor"], configs: [".cursor/extensions"] },
	{ name: "Windsurf", family: "vscode", executables: ["Windsurf", "windsurf"], configs: [".windsurf/extensions"] },
];

const JETBRAINS_PLUGIN = "claude-code-jetbrains-plugin";
const VSCODE_EXTENSION = "anthropic.claude-code-";

export interface RunningIde {
	kind: IdeKind;
	pid: number;
}

/** The executable's name of a `ps -o pid=,comm=` line, for apps the path's last part. */
export function parseProcesses(ps: string): Array<{ pid: number; command: string }> {
	const out: Array<{ pid: number; command: string }> = [];
	for (const line of ps.split("\n")) {
		const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
		if (match) out.push({ pid: Number(match[1]), command: match[2] });
	}
	return out;
}

/** The IDEs among the processes: the app's main executable, not its helpers. */
export function runningIdes(processes: Array<{ pid: number; command: string }>): RunningIde[] {
	const found: RunningIde[] = [];
	for (const { pid, command } of processes) {
		const name = command.split("/").pop() ?? "";
		// On macOS only the app's own Contents/MacOS executable counts (not "Code Helper" or a CLI shim).
		if (command.includes(".app/") && !/\.app\/Contents\/MacOS\/[^/]+$/.test(command)) continue;
		const kind = IDE_KINDS.find((k) => k.executables.includes(name));
		if (kind && !found.some((f) => f.kind === kind)) found.push({ kind, pid });
	}
	return found;
}

function newestEntry(dir: string, prefix: string): string | undefined {
	let best: string | undefined;
	let bestTime = -1;
	try {
		for (const name of readdirSync(dir)) {
			if (!name.startsWith(prefix)) continue;
			const time = statSync(join(dir, name)).mtimeMs;
			if (time > bestTime) {
				best = join(dir, name);
				bestTime = time;
			}
		}
	} catch {
		// No such folder.
	}
	return best;
}

/** Whether the IDE has the Claude Code integration installed (in its newest config folder for JetBrains). */
export function integrationInstalled(kind: IdeKind, home = homedir()): boolean {
	for (const config of kind.configs) {
		const path = join(home, config);
		if (kind.family === "vscode") {
			if (newestEntry(path, VSCODE_EXTENSION)) return true;
			continue;
		}
		const slash = path.lastIndexOf("/");
		const newest = newestEntry(path.slice(0, slash), path.slice(slash + 1));
		if (newest && existsSync(join(newest, "plugins", JETBRAINS_PLUGIN))) return true;
	}
	return false;
}

export interface IdeHint {
	/** Identifies the hint, for hiding it for good. */
	id: string;
	ideName: string;
	text: string;
}

/** What to say about the running IDEs that have no server for pi to connect to. */
export function hintsFor(running: RunningIde[], lockPids: Set<number>, installed: (kind: IdeKind) => boolean): IdeHint[] {
	const hints: IdeHint[] = [];
	for (const { kind, pid } of running) {
		if (lockPids.has(pid)) continue;
		const what = kind.family === "jetbrains" ? "plugin" : "extension";
		if (!installed(kind)) {
			const where = kind.family === "jetbrains" ? 'Settings → Plugins → "Claude Code [Beta]"' : 'Extensions → "Claude Code"';
			hints.push({ id: `${kind.name}:missing`, ideName: kind.name, text: `${kind.name} runs without the Claude Code ${what} · install it for pi to see the selection (${where})` });
		} else {
			hints.push({ id: `${kind.name}:inactive`, ideName: kind.name, text: `${kind.name} has the Claude Code ${what}, but it is not active · enable it or restart ${kind.name}` });
		}
	}
	return hints;
}

export function listProcesses(): Promise<string> {
	return new Promise((resolve) => {
		execFile("ps", ["-axo", "pid=,comm="], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => resolve(error ? "" : stdout));
	});
}
