/**
 * commands: the model picked last is saved as pi's default.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isChoice, saveDefaultModel } from "../extensions/commands/remember-model.ts";

test("the chosen model becomes the default, other settings stay", async () => {
	const dir = mkdtempSync(join(tmpdir(), "remember-model-"));
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProvider: "anthropic", defaultModel: "old", quietStartup: "header" }));
	await saveDefaultModel("claude-code", "opus", dir, dir);
	const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
	assert.equal(settings.defaultProvider, "claude-code");
	assert.equal(settings.defaultModel, "opus");
	assert.equal(settings.quietStartup, "header");
});

test("switches are remembered, a restored session's model is not", () => {
	assert.equal(isChoice("set"), true);
	assert.equal(isChoice("cycle"), true);
	assert.equal(isChoice("restore"), false);
});
