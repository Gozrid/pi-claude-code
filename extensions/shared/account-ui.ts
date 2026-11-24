import { spawn } from "node:child_process";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface WizardUi {
	/** False in print mode: no dialogs can be shown. */
	interactive: boolean;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	progress(message: string): void;
}

export function ctxUi(ctx: ExtensionContext): WizardUi {
	return {
		interactive: ctx.hasUI,
		input: (title, placeholder) => ctx.ui.input(title, placeholder),
		select: (title, options) => ctx.ui.select(title, options),
		confirm: (title, message) => ctx.ui.confirm(title, message),
		notify: (message, type = "info") => ctx.ui.notify(message, type),
		progress: (message) => ctx.ui.notify(message, "info"),
	};
}

export function oauthUi(callbacks: OAuthLoginCallbacks): WizardUi {
	return {
		interactive: true,
		input: async (title, placeholder) => {
			const value = await callbacks.onPrompt({ message: title, placeholder, allowEmpty: true });
			return value?.trim() ? value : undefined;
		},
		select: async (title, options) => {
			const id = await callbacks.onSelect({ message: title, options: options.map((label, i) => ({ id: String(i), label })) });
			return id === undefined ? undefined : options[Number(id)];
		},
		confirm: async (title, message) =>
			(await callbacks.onSelect({
				message: `${title}\n\n${message}`,
				options: [
					{ id: "yes", label: "Yes" },
					{ id: "no", label: "No" },
				],
			})) === "yes",
		notify: (message) => callbacks.onProgress?.(message),
		progress: (message) => callbacks.onProgress?.(message),
	};
}

export function openBrowser(url: string): void {
	const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
	try {
		spawn(opener, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
	} catch {
		// The link is shown as well, so a missing opener is not fatal.
	}
}
