/**
 * Session titles: the model that writes them and the title made of its answer.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { smallestModel as smallestCliModel } from "../extensions/claude-code/oneshot.ts";
import { cleanTitle, smallestModel, titlePrompt } from "../extensions/work-status/title.ts";

const model = (provider: string, id: string, input = 1, output = 1) => ({ provider, id, cost: { input, output } });

test("the smallest model of the selected provider writes the title", () => {
	const models = [
		model("openai", "gpt-5.5", 5, 20),
		model("openai", "gpt-5.5-mini", 0.5, 2),
		model("openai", "gpt-5.5-nano", 0.1, 0.4),
		model("google", "gemini-3-flash-lite", 0.05, 0.2),
		model("anthropic", "claude-opus-5-5", 5, 25),
		model("anthropic", "claude-haiku-5-5", 1, 5),
		model("anthropic", "claude-sonnet-5-5", 3, 15),
		model("mistral", "mistral-large", 2, 6),
		model("mistral", "mistral-medium", 1, 3),
	];
	assert.equal(smallestModel(models, "openai")?.id, "gpt-5.5-nano");
	assert.equal(smallestModel(models, "anthropic")?.id, "claude-haiku-5-5");
	assert.equal(smallestModel(models, "google")?.id, "gemini-3-flash-lite");
	// Without a telling name, the cheapest one.
	assert.equal(smallestModel(models, "mistral")?.id, "mistral-medium");
	assert.equal(smallestModel(models, "xai"), undefined);
});

test("a Claude CLI instance uses its haiku alias, else its smallest tier", () => {
	const cli = (value: string, resolvedModel = value) => ({ value, resolvedModel });
	assert.equal(
		smallestCliModel([cli("default", "claude-opus-5-5"), cli("opus", "claude-opus-5-5"), cli("haiku", "claude-haiku-5-5"), cli("claude-haiku-4-5")]),
		"haiku",
	);
	assert.equal(smallestCliModel([cli("default", "claude-opus-5-5"), cli("opus", "claude-opus-5-5"), cli("sonnet", "claude-sonnet-5-5")]), "sonnet");
});

test("the answer becomes a clean title", () => {
	assert.equal(cleanTitle('"Fix the context window."'), "Fix the context window");
	assert.equal(cleanTitle("Title: Sticky prompt for pi\n\nThis names…"), "Sticky prompt for pi");
	assert.equal(cleanTitle("**Kontextfenster korrigieren**"), "Kontextfenster korrigieren");
	assert.equal(cleanTitle("  \n "), undefined);
	assert.equal(cleanTitle(undefined), undefined);
	const long = cleanTitle("Restructure the pi extensions and add an export command for the whole conversation");
	assert.ok(long && long.length <= 60 && !long.endsWith(" "), long);
});

test("the model reads the first prompt and the start of the answer", () => {
	const prompt = titlePrompt("fix it", "x".repeat(2000));
	assert.match(prompt, /^User: fix it\n\nAssistant: x+…$/);
	assert.ok(prompt.length < 900);
});
