/**
 * agy's permission rules: which rule would have allowed a denied action, and
 * adding rules to the allow list in agy's settings.json.
 *
 * In print mode agy cannot ask; an action its mode and rules do not allow is
 * denied, and the tool step fails with a message like
 *   … user denied permission for write_file(/path/to/file)
 *   … user denied permission to run command:\nnpm test
 */

import { AGY_SETTINGS_FILE, readJson, writeJson } from "./config.ts";

/** The allow rule for a denied tool step, from agy's error message; undefined when it names none. */
export function ruleFromError(message: string): string | undefined {
	const command = message.match(/user denied permission to run command:\n([\s\S]+?)(?:\nDo not |$)/);
	if (command) return `command(${command[1].trim()})`;
	const target = message.match(/user denied permission for (\w+)\((.+?)\)(?:\n|$)/);
	if (target) return `${target[1]}(${target[2]})`;
	return undefined;
}

/** Adds rules to `permissions.allow` in agy's settings, keeping everything else; false when it could not write. */
export function allowRules(rules: string[], file = AGY_SETTINGS_FILE): boolean {
	const settings = readJson<Record<string, any>>(file, {});
	const permissions = settings.permissions && typeof settings.permissions === "object" ? settings.permissions : {};
	const allow: string[] = Array.isArray(permissions.allow) ? permissions.allow : [];
	settings.permissions = { ...permissions, allow: [...allow, ...rules.filter((rule) => !allow.includes(rule))] };
	return writeJson(file, settings);
}
