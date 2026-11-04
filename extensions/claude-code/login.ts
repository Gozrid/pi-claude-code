/**
 * Signing a Claude CLI instance in to an Anthropic account, driven through the
 * CLI's control protocol (the same requests the Agent SDK uses for login):
 *
 *   claude_authenticate               → { manualUrl, automaticUrl }
 *   claude_oauth_wait_for_completion  → resolves once the browser returned the sign-in
 *   claude_oauth_callback             → completes the sign-in with a pasted code
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { spawnClaude, stopClaude } from "./cli.ts";
import type { Instance } from "./config.ts";

const LOGIN_TIMEOUT_MS = 10 * 60_000;

export interface LoginAccount {
	email?: string;
	organization?: string;
	subscriptionType?: string;
}

/** What a login needs from whichever UI drives it (pi dialogs or /login callbacks). */
export interface LoginUi {
	/** Shows the sign-in link; the browser is opened separately. */
	showUrl(url: string, instructions: string): void;
	/**
	 * Asks for the code the browser shows when it cannot return the sign-in itself.
	 * Settles with undefined when cancelled or when `signal` aborts.
	 */
	askCode(message: string, signal: AbortSignal): Promise<string | undefined>;
	progress(message: string): void;
}

export function openBrowser(url: string): void {
	const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
	try {
		spawn(opener, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
	} catch {
		// The link is shown as well, so a missing opener is not fatal.
	}
}

/** Runs the sign-in for one instance and resolves with the account it signed in to. */
export function loginInstance(
	instance: Instance,
	cwd: string,
	ui: LoginUi,
	options: { signal?: AbortSignal; browser?: boolean } = {},
): Promise<LoginAccount> {
	return new Promise((resolve, reject) => {
		const child = spawnClaude(
			instance,
			["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence"],
			{ cwd },
		);
		const codeDialog = new AbortController();
		let settled = false;
		let stderr = "";

		const finish = (error?: Error, account?: LoginAccount) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			codeDialog.abort();
			options.signal?.removeEventListener("abort", onAbort);
			child.stdin.end();
			stopClaude(child, "SIGTERM");
			if (error) reject(error);
			else resolve(account ?? {});
		};
		const onAbort = () => finish(new Error("Sign-in cancelled"));
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => finish(new Error("Sign-in timed out")), LOGIN_TIMEOUT_MS);

		const send = (id: string, request: Record<string, unknown>) =>
			child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: id, request })}\n`);

		child.on("error", (error) => finish(error));
		child.on("close", (code) => finish(new Error(stderr.trim() || `claude exited with code ${code} during sign-in`)));
		child.stdin.on("error", () => {});
		child.stderr.on("data", (d) => {
			stderr += d.toString();
		});

		const askForCode = (message: string) => {
			ui.askCode(message, codeDialog.signal).then(
				(input) => {
					if (settled) return;
					// Closing the dialog without a code is how the user cancels the sign-in.
					if (!input?.trim()) {
						finish(new Error("Sign-in cancelled"));
						return;
					}
					const [authorizationCode, state] = input.trim().split("#");
					ui.progress("Completing sign-in…");
					send("pi-code", { subtype: "claude_oauth_callback", authorizationCode, state });
				},
				() => finish(new Error("Sign-in cancelled")),
			);
		};

		const accountFrom = (response: any): LoginAccount => ({
			email: response?.account?.email,
			organization: response?.account?.organization,
			subscriptionType: response?.account?.subscriptionType,
		});

		const rl = createInterface({ input: child.stdout });
		rl.on("line", (line) => {
			let msg: any;
			try {
				msg = JSON.parse(line);
			} catch {
				return;
			}
			if (msg.type !== "control_response") return;
			const id = msg.response?.request_id;
			const failed = msg.response?.subtype === "error";
			const response = msg.response?.response ?? {};

			if (id === "pi-init") {
				if (failed) finish(new Error(msg.response.error || "claude did not start"));
				else send("pi-auth", { subtype: "claude_authenticate", loginWithClaudeAi: true });
			} else if (id === "pi-auth") {
				if (failed || !response.automaticUrl) {
					finish(new Error(msg.response.error || "claude did not return a sign-in link"));
					return;
				}
				if (options.browser !== false && !process.env.PI_CLAUDE_NO_BROWSER) openBrowser(response.automaticUrl);
				ui.showUrl(
					response.automaticUrl,
					"Sign in in the browser. If it does not open, open the link yourself. If the browser shows a code instead of returning here, paste it below.",
				);
				// Resolves when the browser hands the sign-in back to the CLI on its own.
				send("pi-wait", { subtype: "claude_oauth_wait_for_completion" });
				askForCode("Code from the browser (only if one is shown)");
			} else if (id === "pi-wait" || id === "pi-code") {
				if (failed) {
					// A failed pasted code leaves the browser path open; a failed wait ends the attempt.
					if (id === "pi-wait") finish(new Error(msg.response.error || "Sign-in failed"));
					else askForCode(`That code did not work (${msg.response.error ?? "unknown error"}). Paste it again`);
					return;
				}
				finish(undefined, accountFrom(response));
			}
		});

		send("pi-init", { subtype: "initialize" });
	});
}
