/**
 * The "add a Claude CLI instance" wizard. One flow, two front ends: pi's dialogs
 * (/claude-add, /claude-setup) and the /login callbacks.
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type CliInfo, withPinnedModels } from "./cli.ts";
import { type Instance, providerIdFor, slugify, suggestedCommands } from "./config.ts";
import { type LoginUi, loginInstance } from "./login.ts";

export interface WizardUi extends LoginUi {
	/** False in print mode: no dialogs can be shown. */
	interactive: boolean;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export function ctxUi(ctx: ExtensionContext): WizardUi {
	return {
		interactive: ctx.hasUI,
		input: (title, placeholder) => ctx.ui.input(title, placeholder),
		select: (title, options) => ctx.ui.select(title, options),
		confirm: (title, message) => ctx.ui.confirm(title, message),
		notify: (message, type = "info") => ctx.ui.notify(message, type),
		showUrl: (url, instructions) => ctx.ui.notify(`${instructions}\n\n${url}`, "info"),
		askCode: (message, signal) => ctx.ui.input(message, "paste the code, or wait for the browser", { signal }),
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
		showUrl: (url, instructions) => callbacks.onAuth({ url, instructions }),
		askCode: (message) =>
			callbacks.onManualCodeInput ? callbacks.onManualCodeInput() : callbacks.onPrompt({ message, allowEmpty: true }),
		progress: (message) => callbacks.onProgress?.(message),
	};
}

export interface Probe {
	info?: CliInfo;
	error?: string;
	thinkingDisplay?: string;
}

export interface WizardDeps {
	cwd: string;
	/** Instances the user set up so far (not the implicit default). */
	configured: Instance[];
	probe(name: string, command: string): Promise<Probe>;
	save(ui: WizardUi, name: string, command: string, tested: Probe): Promise<Instance | undefined>;
	signal?: AbortSignal;
}

const NEW_ACCOUNT = "Sign in a new account…   (own config dir, browser login)";
const CUSTOM = "Enter another command…";
const COMMAND_HINT = 'e.g. claude  ·  CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude';

/** A config dir for a new account, ~/.claude-<name>, that is not in use yet. */
function freshConfigDir(name: string): string {
	const base = `.claude-${slugify(name)}`;
	let dir = base;
	for (let n = 2; existsSync(join(homedir(), dir)); n++) dir = `${base}-${n}`;
	return dir;
}

function accountLine(info: CliInfo | undefined): string | undefined {
	const parts = [info?.account?.email, info?.account?.subscriptionType].filter(Boolean);
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Name → account (existing login, new sign-in or own command) → test → confirm. */
export async function runAddWizard(ui: WizardUi, deps: WizardDeps): Promise<Instance | undefined> {
	const title = (step: number) => `New Claude instance · step ${step}/3`;

	const name = (await ui.input(`${title(1)}: name`, "e.g. Work, Personal"))?.trim();
	if (!name) return undefined;
	if (deps.configured.some((i) => i.name.toLowerCase() === name.toLowerCase())) {
		ui.notify(`An instance named "${name}" already exists. Change it with /claude-setup.`, "error");
		return undefined;
	}

	const taken = new Set(deps.configured.map((i) => i.command));
	const suggestions = suggestedCommands().filter((s) => !taken.has(s.command));
	const pick = await ui.select(`${title(2)}: which Claude account should "${name}" use?`, [
		...suggestions.map((s) => s.label),
		NEW_ACCOUNT,
		CUSTOM,
	]);
	if (!pick) return undefined;

	let command = suggestions.find((s) => s.label === pick)?.command;
	let signIn = false;
	if (pick === NEW_ACCOUNT) {
		const dir = freshConfigDir(name);
		mkdirSync(join(homedir(), dir), { recursive: true });
		command = `CLAUDE_CONFIG_DIR="$HOME/${dir}" claude`;
		signIn = true;
	} else if (pick === CUSTOM) {
		command = (await ui.input(`${title(2)}: base command for "${name}"`, COMMAND_HINT))?.trim();
	}
	if (!command) return undefined;

	ui.progress(`Checking ${command} …`);
	let tested = await deps.probe(name, command);
	if (!signIn && tested.info && !tested.info.account?.email) {
		signIn = await ui.confirm(`${title(2)}: "${name}" is not signed in`, `${command}\n\nSign in to a Claude account now?`);
	}
	if (signIn) {
		try {
			const account = await loginInstance({ id: "login", name, command }, deps.cwd, ui, { signal: deps.signal });
			ui.progress(`Signed in as ${account.email ?? "unknown account"}`);
		} catch (error) {
			ui.notify(`Sign-in failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			return undefined;
		}
		tested = await deps.probe(name, command);
	}

	const id = providerIdFor(name, new Set(deps.configured.map((i) => i.id)));
	const details = tested.info
		? [
				`Account: ${accountLine(tested.info) ?? "not signed in"}`,
				`Models: ${withPinnedModels(tested.info.models).length}`,
				`Provider: ${id}/…`,
			]
		: [`⚠ The command did not answer: ${tested.error}`];
	if (deps.configured.length === 0) {
		details.push("", "This is your first instance: it replaces the built-in default. Add your other accounts the same way.");
	}
	const ok = await ui.confirm(`${title(3)}: save "${name}"?`, [command, "", ...details].join("\n"));
	if (!ok) {
		ui.notify("Not saved.", "info");
		return undefined;
	}
	return deps.save(ui, name, command, tested);
}
