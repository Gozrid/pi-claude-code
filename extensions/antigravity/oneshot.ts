/**
 * One-off questions to agy, for other extensions (e.g. a session title from
 * work-status): its smallest model, the caller's system prompt in front of the
 * question, no slash commands. agy has no switch to leave the conversation
 * unsaved, so each question is a short conversation of its own; the chat's
 * conversation is not touched.
 */

import { smallestVariant, spawnAgy, stopAgy } from "./cli.ts";
import { piMcpArgs } from "./mcp.ts";
import { runtime } from "./state.ts";

const TIMEOUT_MS = 60_000;

/** Asks one instance's agy once; resolves to its answer, or undefined when it fails or takes too long. */
export function oneShot(provider: string, system: string, prompt: string): Promise<string | undefined> {
	const state = runtime.instances.get(provider);
	const model = state && smallestVariant(state.models);
	if (!state || !model) return Promise.resolve(undefined);
	const args = [
		`--print=${system}\n\n${prompt}`,
		"--output-format",
		"json",
		"--model",
		model,
		"--mode",
		"plan",
		"--disable-slash-commands",
		// A one-off question needs no MCP servers.
		...piMcpArgs(state.instance.command, true),
	];
	return new Promise((resolve) => {
		let out = "";
		let done = false;
		const finish = (text: string | undefined) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(text);
		};
		const child = spawnAgy(state.instance.command, args, { cwd: runtime.cwd });
		const timer = setTimeout(() => {
			stopAgy(child, "SIGTERM");
			finish(undefined);
		}, TIMEOUT_MS);
		timer.unref?.();
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.on("error", () => finish(undefined));
		child.on("close", () => {
			try {
				const result = JSON.parse(out);
				finish(result.status === "SUCCESS" && typeof result.response === "string" ? result.response.trim() : undefined);
			} catch {
				finish(undefined);
			}
		});
		child.stdin.end();
	});
}
