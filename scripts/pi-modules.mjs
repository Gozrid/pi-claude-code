/**
 * Where the locally installed pi keeps its node_modules: PI_NODE_MODULES, or the
 * managed install in ~/.pi/agent/install/releases/<current-version>/node_modules.
 * pi provides @earendil-works/* to extensions at runtime, so they are not
 * dependencies of this package; type checks and tests borrow them from there.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function piNodeModules() {
	let modules = process.env.PI_NODE_MODULES;
	if (!modules) {
		const install = join(homedir(), ".pi", "agent", "install");
		try {
			const version = readFileSync(join(install, "current-version"), "utf8").trim();
			modules = join(install, "releases", version, "node_modules");
		} catch {
			throw new Error("Could not find pi's node_modules. Set PI_NODE_MODULES to <pi install>/node_modules.");
		}
	}
	if (!existsSync(join(modules, "@earendil-works", "pi-coding-agent"))) {
		throw new Error(`No @earendil-works/pi-coding-agent in ${modules}. Set PI_NODE_MODULES.`);
	}
	return modules;
}
