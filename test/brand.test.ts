/**
 * Which look a model gets.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { brandFor } from "../extensions/shared/brand.ts";

test("the provider decides first, then the model's name", () => {
	assert.equal(brandFor({ provider: "antigravity", id: "claude-opus-5-5" }).id, "antigravity");
	assert.equal(brandFor({ provider: "antigravity", id: "gemini-4-argon" }).mascot, "gravi");
	assert.equal(brandFor({ provider: "claude-bag", id: "opus" }).mascot, "clawd");
	assert.equal(brandFor({ provider: "openrouter", id: "anthropic/claude-sonnet" }).id, "claude");
	assert.equal(brandFor({ provider: "openai", id: "gpt-6" }).mascot, undefined);
	assert.equal(brandFor(undefined).id, "default");
});
