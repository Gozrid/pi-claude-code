/**
 * `node --import ./scripts/register-pi.mjs`: resolves @earendil-works/* and typebox
 * from the installed pi, as pi's extension loader does, so tests can import the
 * extensions' modules.
 */

import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { piNodeModules } from "./pi-modules.mjs";

const parentURL = pathToFileURL(join(piNodeModules(), "resolve-from-here.js")).href;

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith("@earendil-works/") || specifier === "typebox" || specifier.startsWith("typebox/")) return nextResolve(specifier, { ...context, parentURL });
		return nextResolve(specifier, context);
	},
});
