/**
 * /export: the whole conversation as Markdown, copied or saved as a file.
 *
 *   /export              pick: copy to the clipboard or save as a file
 *   /export copy         copy it right away
 *   /export file [path]  save it (default: pi-<session>-<time>.md in the working directory)
 *   /export x.html       pi's own export (HTML or JSONL), as before
 *
 * pi handles its built-in /export before any extension command, so this one
 * takes over the Enter key while the editor holds "/export …". A path ending in
 * .html or .jsonl is left to pi.
 */

import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { conversationMarkdown, type ExportEntry, exportFileName } from "./conversation.ts";

const COMMAND = /^\/export(?:\s+(.*))?$/s;
const PI_EXPORT = /\.(html?|jsonl)$/i;

const COPY = "Copy to clipboard";
const FILE = "Save as Markdown file";

function markdown(ctx: ExtensionContext): string {
	const sessions = ctx.sessionManager;
	return conversationMarkdown(sessions.getBranch() as ExportEntry[], {
		title: sessions.getSessionName(),
		cwd: sessions.getCwd(),
	});
}

function expandHome(path: string): string {
	return path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path;
}

async function copy(ctx: ExtensionContext) {
	const text = markdown(ctx);
	await copyToClipboard(text);
	ctx.ui.notify(`Conversation copied (${text.length.toLocaleString("en")} characters)`, "info");
}

async function save(ctx: ExtensionContext, path?: string) {
	const sessions = ctx.sessionManager;
	let target = path?.trim();
	if (!target && ctx.hasUI) {
		const fallback = exportFileName(sessions.getSessionName());
		const answer = await ctx.ui.input("Save the conversation as", fallback);
		if (answer === undefined) return;
		target = answer.trim() || fallback;
	}
	const file = resolve(sessions.getCwd(), expandHome(target || exportFileName(sessions.getSessionName())));
	writeFileSync(file, markdown(ctx));
	ctx.ui.notify(`Conversation saved to ${file}`, "info");
}

async function runExport(ctx: ExtensionContext, args: string) {
	const [first = "", ...rest] = args.trim().split(/\s+/);
	try {
		if (first === "copy") return await copy(ctx);
		if (first === "file") return await save(ctx, rest.join(" "));
		if (first) return await save(ctx, args);
		const choice = await ctx.ui.select("Export the conversation", [COPY, FILE]);
		if (choice === COPY) await copy(ctx);
		else if (choice === FILE) await save(ctx);
	} catch (error) {
		ctx.ui.notify(`Export failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

export function exportCommand(pi: ExtensionAPI) {
	let stop: (() => void) | undefined;

	pi.on("session_start", async (_event, ctx) => {
		stop?.();
		stop = undefined;
		if (ctx.mode !== "tui") return;
		stop = ctx.ui.onTerminalInput((data) => {
			if (!matchesKey(data, Key.enter)) return undefined;
			const match = COMMAND.exec(ctx.ui.getEditorText().trim());
			const args = match?.[1]?.trim() ?? "";
			if (!match || PI_EXPORT.test(args)) return undefined;
			ctx.ui.setEditorText("");
			void runExport(ctx, args);
			return { consume: true };
		});
	});

	pi.on("session_shutdown", async () => {
		stop?.();
		stop = undefined;
	});
}
