#!/usr/bin/env node
/**
 * Type-checks extensions/ and test/ against the types of the locally installed pi
 * (see pi-modules.mjs).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { piNodeModules } from "./pi-modules.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let modules;
try {
	modules = piNodeModules();
} catch (error) {
	console.error(error.message);
	process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "pi-claude-code-tsc-"));
const config = join(dir, "tsconfig.json");
writeFileSync(
	config,
	JSON.stringify({
		compilerOptions: {
			target: "ES2022",
			module: "ESNext",
			moduleResolution: "Bundler",
			strict: true,
			noEmit: true,
			skipLibCheck: true,
			allowImportingTsExtensions: true,
			types: ["node"],
			typeRoots: [join(modules, "@types")],
			baseUrl: root,
			paths: { "@earendil-works/*": [join(modules, "@earendil-works/*")], "*": [join(modules, "*")] },
		},
		include: [join(root, "extensions", "**", "*.ts"), join(root, "test", "**", "*.ts")],
	}),
);

const result = spawnSync("npx", ["-y", "-p", "typescript@5.6.3", "tsc", "-p", config], { stdio: "inherit" });
rmSync(dir, { recursive: true, force: true });
if (result.status === 0) console.log("Type check passed.");
process.exit(result.status ?? 1);
