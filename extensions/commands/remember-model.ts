/**
 * Remembers the model picked last: every switch (/model, cycling, an agent's set_model) is saved
 * as pi's default model, so the next start and new sessions begin with it. pi itself only saves
 * a model when it is set as default explicitly in /model.
 */

import { type ExtensionAPI, getAgentDir, type ModelSelectEvent, SettingsManager } from "@earendil-works/pi-coding-agent";

/** Writes provider/id as pi's default model into the global settings of `agentDir`. */
export async function saveDefaultModel(provider: string, id: string, cwd: string, agentDir = getAgentDir()): Promise<void> {
	const manager = SettingsManager.create(cwd, agentDir);
	if (manager.getDefaultProvider() === provider && manager.getDefaultModel() === id) return;
	manager.setDefaultModelAndProvider(provider, id);
	await manager.flush();
}

/** A restored session's model is not a choice of the user; only switches are remembered. */
export function isChoice(source: ModelSelectEvent["source"]): boolean {
	return source === "set" || source === "cycle";
}

export function rememberModel(pi: ExtensionAPI): void {
	pi.on("model_select", async (event, ctx) => {
		if (!isChoice(event.source)) return;
		try {
			await saveDefaultModel(event.model.provider, event.model.id, ctx.cwd);
		} catch (error) {
			ctx.ui.notify(`Could not remember the model: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	});
}
