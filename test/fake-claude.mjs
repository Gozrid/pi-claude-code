#!/usr/bin/env node
/**
 * Stands in for `claude -p`: once the prompt has come on stdin, prints the JSON
 * lines of FAKE_CLAUDE_FIXTURE, then waits for stdin to close like the real CLI
 * (it ends right away when the fixture has no result, like a CLI that fails).
 * Writes its arguments and stdin to FAKE_CLAUDE_RECORD (JSON) when that is set.
 *
 * Fixture lines for steering:
 *   {"fake": "read"}    waits for the next line on stdin (a steer)
 *   {"fake": "replay"}  echoes the oldest line read that way, as claude does with --replay-user-messages
 *   {"fake": "prompt"}  echoes the prompt here (--replay-user-messages); without it, the prompt is echoed first
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const received = [];
const next = async () => {
	const line = await lines.next();
	if (line.done) return undefined;
	received.push(line.value);
	return line.value;
};

const prompt = await next();
const fixture = readFileSync(process.env.FAKE_CLAUDE_FIXTURE, "utf8").split("\n").filter(Boolean);
const echoPrompt = () => {
	if (prompt) process.stdout.write(`${JSON.stringify({ ...JSON.parse(prompt), isReplay: true })}\n`);
};
if (!fixture.some((line) => JSON.parse(line).fake === "prompt")) echoPrompt();
const steers = [];
for (const line of fixture) {
	const entry = JSON.parse(line);
	if (entry.fake === "prompt") echoPrompt();
	else if (entry.fake === "read") steers.push(await next());
	else if (entry.fake === "replay") process.stdout.write(`${JSON.stringify({ ...JSON.parse(steers.shift()), isReplay: true })}\n`);
	else process.stdout.write(`${line}\n`);
}
if (fixture.some((line) => JSON.parse(line).type === "result")) while ((await next()) !== undefined);
else process.stdin.destroy();

if (process.env.FAKE_CLAUDE_RECORD) {
	writeFileSync(
		process.env.FAKE_CLAUDE_RECORD,
		JSON.stringify({
			args: process.argv.slice(2),
			stdin: received.map((l) => `${l}\n`).join(""),
			env: { tasks: process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS },
		}),
	);
}
process.exitCode = Number(process.env.FAKE_CLAUDE_EXIT ?? 0);
