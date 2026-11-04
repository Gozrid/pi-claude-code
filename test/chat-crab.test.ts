/**
 * What the chat crab shows beside itself.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { crabFrame, type Mood, rowText, SIDE_ROOM } from "../extensions/chat-crab/crab.ts";

const long = "x".repeat(300);
const props: [Mood, string][] = [
	["typing", `/src/${long}.ts`],
	["terminal", `npm run ${long}`],
	["surfing", `https://${long}.com/page`],
];

const MOODS: Mood[] = [
	"idle",
	"sleep",
	"thinking",
	"writing",
	"walking",
	"reading",
	"typing",
	"terminal",
	"surfing",
	"searching",
	"delegating",
	"planning",
	"catch",
	"ouch",
	"cheer",
];

const rows = (mood: Mood, time: number, detail: string, room?: number) => {
	const frame = crabFrame(mood, time, { direction: 1, tool: "Grep", detail, room });
	return [...(frame.prop ?? []), ...(frame.buddy?.caption ? [frame.buddy.caption] : [])].map(rowText);
};

test("props use the whole room beside the crab and stay inside it", () => {
	for (const room of [SIDE_ROOM, 20]) {
		for (const [mood, detail] of props) {
			let widest = 0;
			for (let time = 0; time < 30_000; time += 70) {
				for (const row of rows(mood, time, detail, room)) {
					assert.ok(visibleWidth(row) <= room, `${mood} in ${room}: ${row}`);
					widest = Math.max(widest, visibleWidth(row));
				}
			}
			assert.ok(widest >= room - 2, `${mood} in ${room} only ${widest} wide`);
		}
	}
});

test("every scene fits beside the crab, at most three rows, in any room", () => {
	for (const room of [SIDE_ROOM, 24, 14]) {
		for (const mood of MOODS) {
			for (let time = 0; time < 12_000; time += 37) {
				const frame = crabFrame(mood, time, { direction: 1, tool: "Grep", detail: `src/${long}`, room, cheer: "committed" });
				assert.ok((frame.prop?.length ?? 0) <= 3, `${mood}: ${frame.prop?.length} rows`);
				for (const row of rows(mood, time, `src/${long}`, room)) {
					assert.ok(visibleWidth(row) <= room, `${mood} in ${room} at ${time}: "${row}"`);
				}
			}
		}
	}
});

test("scenes move: every acting mood changes what is beside the crab over time", () => {
	for (const mood of ["sleep", "thinking", "writing", "reading", "typing", "terminal", "surfing", "searching", "planning", "catch", "ouch", "cheer"] as Mood[]) {
		const seen = new Set<string>();
		for (let time = 0; time < 6000; time += 100) seen.add(rows(mood, time, "src/index.ts").join("\n"));
		assert.ok(seen.size >= 3, `${mood} shows only ${seen.size} different frames`);
	}
});

test("without a room given, the terminal fills SIDE_ROOM", () => {
	const top = rowText(crabFrame("terminal", 0, { direction: 1, detail: "ls" }).prop![0]!);
	assert.equal(visibleWidth(top), SIDE_ROOM - 1);
});

test("a typed command ends in a spinner while it runs", () => {
	const typing = rowText(crabFrame("terminal", 60, { direction: 1, detail: "ls" }).prop![1]!);
	const running = rowText(crabFrame("terminal", 2000, { direction: 1, detail: "ls" }).prop![1]!);
	assert.match(typing, /\$ l▌/);
	assert.match(running, /\$ ls [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
});

test("grep and glob search with the magnifier", () => {
	const frame = crabFrame("searching", 500, { direction: 1, tool: "Grep", detail: "TODO" });
	assert.match(rowText(frame.prop![0]!), /⌕ TODO/);
	assert.match(rowText(frame.prop![1]!), /◉/);
});

test("Gravi acts the same moods with a thruster instead of feet", () => {
	for (const mood of ["idle", "thinking", "walking", "cheer", "sleep", "delegating"] as Mood[]) {
		const clawd = crabFrame(mood, 300, { direction: 1 });
		const gravi = crabFrame(mood, 300, { direction: 1, mascot: "gravi" });
		assert.equal(gravi.art.length, clawd.art.length, mood);
		assert.ok(gravi.art.some((row) => row.includes("hh")), mood);
		assert.ok(!clawd.art.some((row) => /[fh]/.test(row)), mood);
	}
	assert.match(crabFrame("delegating", 0, { direction: 1, mascot: "gravi" }).buddy!.art.at(-1)!, /[fh]/);
});
