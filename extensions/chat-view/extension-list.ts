/**
 * Extension list (part of chat-view)
 *
 * While the chat is empty, a list above the editor names the loaded extensions,
 * in place of pi's startup listing (hidden with "quietStartup"). It goes away
 * with the first message.
 *
 * provider-logo takes the list over and draws it beside its logo, so the two can
 * share rows; widgets always stack below the header. The offer goes out on pi's
 * event bus (EXTENSION_LIST_CHANNEL), whose listeners run synchronously.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Theme = ExtensionContext["ui"]["theme"];

const WIDGET = "chat-view-extensions";

/** pi.events channel: the list's rows (none when hidden); `take` stops chat-view from drawing them itself. */
export const EXTENSION_LIST_CHANNEL = "chat-view:extension-list";

export interface ExtensionListOffer {
	lines: string[];
	take(): void;
}

/**
 * Names of the loaded extensions, like pi's startup listing: the folder of an
 * index.ts, otherwise the file name. pi has no API for the list itself, so it
 * comes from the extensions' commands and tools; one that registers neither is missing.
 */
function extensionNames(pi: ExtensionAPI): string[] {
	const paths = [
		...pi.getCommands().filter((command) => command.source === "extension").map((command) => command.sourceInfo.path),
		...pi.getAllTools().map((tool) => tool.sourceInfo.path),
	].filter((path) => path && !path.startsWith("builtin:") && !path.startsWith("<"));
	const names = [...new Set(paths)].map((path) => {
		const parts = path.split(/[\\/]/).filter(Boolean);
		const file = parts.pop() ?? path;
		return /^index\.[cm]?[jt]s$/.test(file) && parts.length > 0 ? parts[parts.length - 1] : file.replace(/\.[cm]?[jt]s$/, "");
	});
	return [...new Set(names)];
}

function listLines(theme: Theme, names: string[]): string[] {
	return [theme.fg("muted", "Extensions"), ...names.map((name) => `${theme.fg("dim", "•")} ${theme.fg("muted", name)}`)];
}

function chatIsEmpty(ctx: ExtensionContext): boolean {
	return !ctx.sessionManager.getBranch().some((entry) => entry.type === "message");
}

export function extensionList(pi: ExtensionAPI) {
	let shown = false;

	const show = (ctx: ExtensionContext) => {
		if (shown || ctx.mode !== "tui") return;
		const names = extensionNames(pi);
		if (names.length === 0) return;
		const lines = listLines(ctx.ui.theme, names);
		let taken = false;
		pi.events.emit(EXTENSION_LIST_CHANNEL, { lines, take: () => (taken = true) } satisfies ExtensionListOffer);
		if (!taken) ctx.ui.setWidget(WIDGET, lines);
		shown = true;
	};

	const hide = (ctx: ExtensionContext) => {
		if (!shown) return;
		shown = false;
		pi.events.emit(EXTENSION_LIST_CHANNEL, { lines: [], take: () => {} } satisfies ExtensionListOffer);
		try {
			ctx.ui.setWidget(WIDGET, undefined);
		} catch {
			// Stale context after a reload or session switch.
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		if (chatIsEmpty(ctx)) show(ctx);
		else hide(ctx);
	});
	pi.on("agent_start", async (_event, ctx) => hide(ctx));
	pi.on("message_start", async (_event, ctx) => hide(ctx));
	pi.on("session_shutdown", async (_event, ctx) => hide(ctx));
}
