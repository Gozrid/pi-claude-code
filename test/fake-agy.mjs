#!/usr/bin/env node
/**
 * Stands in for `agy -p`: prints the JSON lines of FAKE_AGY_FIXTURE and exits.
 * Writes its arguments to FAKE_AGY_RECORD (JSON) when that is set. A fixture line
 * {"write": path, "content": text} is not printed: after a pause (so the reader
 * has seen the lines before it) the file is written, as agy's edit tools would.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

if (process.env.FAKE_AGY_RECORD) {
	writeFileSync(process.env.FAKE_AGY_RECORD, JSON.stringify({ args: process.argv.slice(2) }));
}
for (const line of readFileSync(process.env.FAKE_AGY_FIXTURE, "utf8").split("\n")) {
	if (!line.trim()) continue;
	const parsed = JSON.parse(line);
	if (parsed.write) {
		await sleep(150);
		writeFileSync(parsed.write, parsed.content);
		continue;
	}
	process.stdout.write(`${line}\n`);
}
process.exitCode = Number(process.env.FAKE_AGY_EXIT ?? 0);
