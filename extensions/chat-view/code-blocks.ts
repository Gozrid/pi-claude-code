/**
 * Code blocks (part of chat-view)
 *
 * pi writes code fences out literally (```typescript … ```). Instead, code gets a
 * line on its left that bends into the language at the top (╭─ typescript) and
 * stays open at the bottom. It takes the code colour, so it stands apart from the
 * grey frame of grouped messages. pi always gives each fence a row of its own, so
 * the closing one stays as an empty row.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Theme = ExtensionContext["ui"]["theme"];

/** The parts of pi's Markdown theme for code blocks. */
interface CodeBlockTheme {
	codeBlockBorder: (text: string) => string;
	codeBlockIndent?: string;
}

const DONE = Symbol.for("pi-claude-code.chat-view.codeBlocks");

/** Gives `markdownTheme` the line; the colour follows a later theme switch. */
export function barCodeBlocks(markdownTheme: object, theme: Theme): void {
	const target = markdownTheme as CodeBlockTheme & { [DONE]?: true };
	if (target[DONE]) return;
	const line = (text: string) => theme.fg("mdCodeBlockBorder", text);
	// pi passes the opening fence with its language, the closing one bare.
	let open = false;
	target.codeBlockBorder = (fence) => {
		open = !open;
		if (!open) return "";
		// "typescript:12" is a file's content from line 12 (see tool-blocks.ts).
		const lang = fence.replace(/^[`~]+/, "").trim().replace(/:\d+$/, "");
		return lang ? `${line("╭─")} ${theme.style(lang, { fg: "dim", italic: true })}` : line("╭─");
	};
	Object.defineProperty(target, "codeBlockIndent", { get: () => `${line("│")} `, configurable: true });
	target[DONE] = true;
}
