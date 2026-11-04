/**
 * The send fold: the message goes out at once and folds into an envelope in the editor.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { getSelectListTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, type TUI } from "@earendil-works/pi-tui";
import { FOLD_MS } from "../extensions/chat-crab/crab.ts";
import { FoldEditor, foldLine } from "../extensions/chat-crab/send.ts";

initTheme("dark");

const ANSI = /\x1b\[[0-9;]*m|\x1b_[^\x07]*\x07/g;
const plain = (line: string) => line.replace(ANSI, "");

/** An editor whose crab is shown (folds at column 20) or away. */
function editor(crab = true) {
	let renders = 0;
	let catches = 0;
	const tui = { requestRender: () => renders++, terminal: { rows: 40, columns: 60 } } as unknown as TUI;
	const theme = { borderColor: (s: string) => s, selectList: getSelectListTheme() };
	// As pi does, the keybindings type is pi's subclass of the TUI one.
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS) as unknown as ConstructorParameters<typeof FoldEditor>[2];
	const ed = new FoldEditor(tui, theme, keybindings, () => {
		if (!crab) return undefined;
		catches++;
		return 20;
	});
	const sent: string[] = [];
	ed.onSubmit = (text) => sent.push(text);
	return { ed, sent, renders: () => renders, catches: () => catches };
}

function send(ed: FoldEditor, text: string) {
	for (const c of text) ed.handleInput(c);
	ed.handleInput("\r");
}

const row = (ed: FoldEditor) => plain(ed.render(60)[1]!);

test("the message goes out at once and the crab starts its catch", () => {
	const { ed, sent, catches } = editor();
	send(ed, "hello pi");
	assert.deepEqual(sent, ["hello pi"]);
	assert.equal(ed.getText(), "");
	assert.equal(catches(), 1);
	assert.equal(row(ed).trim(), "hello pi");
});

test("the fold ends in an envelope under the crab, then the editor is empty", async () => {
	const { ed } = editor();
	send(ed, "hello pi");
	await new Promise((resolve) => setTimeout(resolve, FOLD_MS - 60));
	assert.equal(row(ed).indexOf("✉"), 20);
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(row(ed).trim(), "");
});

test("commands, shell lines and a hidden crab send without a fold", () => {
	for (const [text, crab] of [["/model", true], ["!ls", true], ["hello", false]] as const) {
		const { ed, sent, catches } = editor(crab);
		send(ed, text);
		assert.deepEqual(sent, [text]);
		assert.equal(catches(), 0, text);
		assert.equal(row(ed).trim(), "", text);
	}
});

test("text typed meanwhile wins over the fold", () => {
	const { ed } = editor();
	send(ed, "first");
	for (const c of "second") ed.handleInput(c);
	assert.equal(row(ed).trim(), "second");
});

test("the characters close in on the target and stay within the width", () => {
	const spread = (time: number) => {
		const cols = [...plain(foldLine("a long message to fold", time, 40, 1, 30))].flatMap((c, i) => (c === " " ? [] : [i]));
		return Math.max(...cols) - Math.min(...cols);
	};
	assert.ok(spread(150) < spread(0));
	assert.equal(plain(foldLine("x".repeat(100), 0, 40, 1, 30)).length, 40);
	assert.equal(plain(foldLine("hi", FOLD_MS - 1, 40, 1, 99)).indexOf("✉"), 38);
	assert.equal(plain(foldLine("hi", FOLD_MS - 1, 40, 1, 20)).slice(19, 22), "[✉]");
});
