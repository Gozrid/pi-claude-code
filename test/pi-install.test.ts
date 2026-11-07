/**
 * shared/pi-install: finding the running pi's package, its docs and version.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { piDocsDir } from "../extensions/pi-bridge/tools.ts";
import { piPackageDir } from "../extensions/shared/pi-install.ts";

test("piPackageDir finds pi's package with a version", () => {
	const dir = piPackageDir();
	assert.ok(dir, "pi's package was not found");
	const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	assert.equal(pkg.name, "@earendil-works/pi-coding-agent");
	assert.match(pkg.version, /^\d+\.\d+\.\d+/);
});

test("piDocsDir finds pi's docs", () => {
	const dir = piDocsDir();
	assert.ok(dir, "pi's docs were not found");
	assert.ok(existsSync(join(dir, "extensions.md")));
});
