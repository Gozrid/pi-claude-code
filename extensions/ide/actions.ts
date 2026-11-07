/**
 * What pi asks the IDE to do: open a file at a line (`/ide open`) and show what
 * changed in a file since the last commit in the IDE's diff viewer (`/ide diff`).
 */

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { IdeConnection } from "./connection.ts";
import { absolutePath, anchorFor, type FileRef } from "./links.ts";

/** Opens the file in the IDE, on the reference's line when it has one. */
export async function openInIde(conn: IdeConnection, ref: FileRef, cwd: string): Promise<string> {
	const filePath = absolutePath(ref.path, cwd, homedir());
	let content: string;
	try {
		content = readFileSync(filePath, "utf8");
	} catch {
		throw new Error(`No such file: ${ref.path}`);
	}
	const startText = ref.line ? anchorFor(content, ref.line) : undefined;
	const result = await conn.callTool("openFile", {
		filePath,
		preview: false,
		makeFrontmost: true,
		...(startText ? { startText, selectToEndOfLine: true } : {}),
	});
	if (result.isError) throw new Error(result.text || `${conn.ideName} could not open ${ref.path}`);
	return filePath;
}

function git(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", ["-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
	});
}

export interface ChangedFile {
	/** Absolute path. */
	path: string;
	/** Path from the repository's root, as git names it. */
	rel: string;
	/** Not in the last commit yet. */
	untracked: boolean;
}

/** `git status --porcelain -z` → the changed files still on disk. */
export function parseStatus(status: string, root: string): ChangedFile[] {
	const files: ChangedFile[] = [];
	const entries = status.split("\0");
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.length < 4) continue;
		const code = entry.slice(0, 2);
		const rel = entry.slice(3);
		// Renames name the old path next; skip it.
		if (code[0] === "R" || code[0] === "C") i++;
		if (code.includes("D")) continue;
		files.push({ path: join(root, rel), rel, untracked: code === "??" });
	}
	return files;
}

/** The files changed since the last commit in the repository pi's folder belongs to. */
export async function changedFiles(cwd: string): Promise<ChangedFile[]> {
	const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
	return parseStatus(await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]), root);
}

export type DiffOutcome = "accepted" | "rejected" | "saved" | "changed meanwhile";

/**
 * Shows the file's change since the last commit in the IDE's diff viewer: the
 * committed version on the left, the file as it is now on the right. The IDE
 * waits for Accept or Reject; edits made in the right pane and accepted are
 * written to the file, unless it changed meanwhile.
 */
export async function showDiff(conn: IdeConnection, file: ChangedFile, cwd: string): Promise<DiffOutcome> {
	const root = file.path.slice(0, file.path.length - file.rel.length);
	const before = file.untracked ? "" : await git(root, ["show", `HEAD:${file.rel}`]).catch(() => "");
	const now = readFileSync(file.path, "utf8");
	const left = join(tmpdir(), "pi-ide-diff", `${process.pid}`, "HEAD", file.rel);
	mkdirSync(dirname(left), { recursive: true });
	writeFileSync(left, before);
	const label = relative(cwd, file.path) || file.rel;
	// The IDE answers only once the user decides; give them time.
	const result = await conn.callTool(
		"openDiff",
		{ old_file_path: left, new_file_path: file.path, new_file_contents: now, tab_name: `${label} (HEAD ↔ now)` },
		24 * 60 * 60 * 1000,
	);
	if (result.isError) throw new Error(result.text || `${conn.ideName} could not show the diff`);
	if (!/FILE_SAVED/.test(result.texts[0] ?? result.text)) return "rejected";
	const edited = result.texts[1];
	if (edited === undefined || edited === now) return "accepted";
	if (readFileSync(file.path, "utf8") !== now) return "changed meanwhile";
	writeFileSync(file.path, edited);
	return "saved";
}
