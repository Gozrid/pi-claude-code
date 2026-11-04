/**
 * The "add an Antigravity CLI instance" wizard. One flow, two front ends: pi's
 * dialogs (/agy-add, /agy-setup) and the /login callbacks.
 *
 * agy signs in only in its own interactive UI, so the wizard does not sign in:
 * it registers a base command, tests it with `agy models` and, when that fails,
 * says how to sign the command in.
 */

import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgyModel } from "./cli.ts";
import { type Instance, providerIdFor, SIGN_IN_COMMANDS } from "./config.ts";

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

export interface Probe {
	models?: AgyModel[];
	error?: string;
}

export interface WizardDeps {
	/** Instances the user set up so far (not the implicit default). */
	configured: Instance[];
	probe(command: string): Promise<Probe>;
	save(ui: WizardUi, name: string, command: string, tested: Probe): Promise<Instance | undefined>;
}

const CUSTOM = "Enter another command…";
const COMMAND_HINT = 'e.g. agy  ·  AGY_ADC_AUTH=1 agy  ·  GEMINI_API_KEY="$(cat ~/.gemini-key)" agy';

/** What to do when a base command does not answer: most often agy is not signed in. */
export function signInHint(command: string): string {
	return `If it is not signed in yet: run ${command} in a terminal, follow its sign-in and quit it again (Ctrl+D twice).`;
}

/** Name → account (agy's sign-in, ADC or own command) → test → confirm. */
export async function runAddWizard(ui: WizardUi, deps: WizardDeps): Promise<Instance | undefined> {
	const title = (step: number) => `New Antigravity instance · step ${step}/3`;

	const name = (await ui.input(`${title(1)}: name`, "e.g. Work, Personal"))?.trim();
	if (!name) return undefined;
	if (deps.configured.some((i) => i.name.toLowerCase() === name.toLowerCase())) {
		ui.notify(`An instance named "${name}" already exists. Change it with /agy-setup.`, "error");
		return undefined;
	}

	const taken = new Set(deps.configured.map((i) => i.command));
	const suggestions = SIGN_IN_COMMANDS.filter((s) => !taken.has(s.command));
	const pick = await ui.select(`${title(2)}: which Antigravity account should "${name}" use?`, [
		...suggestions.map((s) => s.label),
		CUSTOM,
	]);
	if (!pick) return undefined;
	const command =
		pick === CUSTOM
			? (await ui.input(`${title(2)}: base command for "${name}"`, COMMAND_HINT))?.trim()
			: suggestions.find((s) => s.label === pick)?.command;
	if (!command) return undefined;

	ui.progress(`Checking ${command} …`);
	const tested = await deps.probe(command);

	const id = providerIdFor(name, new Set(deps.configured.map((i) => i.id)));
	const details = tested.models
		? [`Models: ${tested.models.length}`, `Provider: ${id}/…`]
		: [`⚠ The command did not answer: ${tested.error}`, "", signInHint(command)];
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
