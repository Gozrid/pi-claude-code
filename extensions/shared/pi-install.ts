/**
 * Where the running pi is installed, for extensions that need files pi ships
 * (its docs, its package.json, dependencies like grok-mermaid).
 *
 * import.meta.resolve() does not see pi's packages from inside the extension
 * loader, so this looks from the running pi (process.argv[1]) and from the
 * managed install (~/.pi/agent/install/releases/<current-version>).
 */

import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PACKAGE = "@earendil-works/pi-coding-agent";

/** Files to resolve pi's dependencies from: the running pi, else the managed install. */
export function piPaths(): string[] {
	const paths: string[] = [];
	try {
		if (process.argv[1]) paths.push(realpathSync(process.argv[1]));
	} catch {}
	const install = process.env.PI_MANAGED_INSTALL_ROOT ?? join(homedir(), ".pi", "agent", "install");
	try {
		const version = readFileSync(join(install, "current-version"), "utf8").trim();
		paths.push(join(install, "releases", version, "node_modules", "resolve-from-here.js"));
	} catch {}
	return paths;
}

/**
 * The folder of pi's own package (@earendil-works/pi-coding-agent), with docs/
 * and package.json. Walks up from each of piPaths(): the running pi sits inside
 * the package, the managed install has it in node_modules. (The package only
 * exports for import, so require.resolve() can't find it.)
 */
export function piPackageDir(): string | undefined {
	for (const from of piPaths()) {
		for (let dir = dirname(from); ; dir = dirname(dir)) {
			if (readJson(join(dir, "package.json"))?.name === PACKAGE) return dir;
			const inModules = join(dir, "node_modules", PACKAGE);
			if (readJson(join(inModules, "package.json"))?.name === PACKAGE) return inModules;
			if (dirname(dir) === dir) break;
		}
	}
	return undefined;
}

function readJson(file: string): { name?: string } | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}
