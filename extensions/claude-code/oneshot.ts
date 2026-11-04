/**
 * One-off questions to a Claude CLI instance, for other extensions (e.g. a
 * session title from work-status): the instance's smallest model, a system
 * prompt of the caller's, no tools, no MCP servers, no saved session. Nothing
 * of the chat's Claude Code session is touched.
 */

import { type CliModel, spawnClaude, stopClaude } from "./cli.ts";
import { runtime } from "./state.ts";

const TIMEOUT_MS = 60_000;

/** Model tiers from small to large; the first one an instance offers wins. */
const SMALL_FIRST = [/haiku/i, /sonnet/i, /opus/i];

/** The instance's smallest model: its "haiku" alias if it has one, else the smallest tier it lists. */
export function smallestModel(models: readonly CliModel[]): string | undefined {
	const names = models.filter((m) => m.value !== "default");
	for (const tier of SMALL_FIRST) {
		const alias = names.find((m) => tier.test(m.value) && m.resolvedModel !== m.value);
		if (alias) return alias.value;
		const pinned = names.find((m) => tier.test(m.value) || tier.test(m.resolvedModel ?? ""));
		if (pinned) return pinned.value;
	}
	return names[0]?.value;
}

/** Asks `provider`'s CLI once; resolves to its answer, or undefined when it fails or takes too long. */
export function oneShot(provider: string, system: string, prompt: string): Promise<string | undefined> {
	const state = runtime.instances.get(provider);
	const model = state && smallestModel(state.models);
	if (!state || !model) return Promise.resolve(undefined);
	const args = [
		"-p",
		"--output-format",
		"json",
		"--model",
		model,
		"--system-prompt",
		system,
		"--tools",
		"",
		"--strict-mcp-config",
		"--disable-slash-commands",
		"--no-session-persistence",
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
		const child = spawnClaude(state.instance, args, { cwd: runtime.cwd });
		const timer = setTimeout(() => {
			stopClaude(child, "SIGTERM");
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
				finish(!result.is_error && typeof result.result === "string" ? result.result : undefined);
			} catch {
				finish(undefined);
			}
		});
		child.stdin.end(prompt);
	});
}
