/**
 * MCP tools of pi's own models (part of chat-view)
 *
 * pi draws calls of MCP tools (`mcp__<server>__<tool>`) as the tool's name with
 * its arguments as JSON, and the result as plain text. Instead they look like the
 * CLI agents' tool calls (see tool-blocks.ts): "FreeCAD › execute_code" with the
 * document or object it works on, code as a highlighted block, the other
 * arguments as indented JSON, the result as a table, indented JSON or text,
 * cut after a few rows until Ctrl+O. pi still shows the result's images itself.
 * Only the display: the model gets the result unchanged.
 *
 * Tools whose server or another extension brings its own renderer keep it.
 */

import { type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { mcpTool, toolCallBlock, toolResultBlock } from "../shared/tool-lines.ts";
import { barCodeBlocks } from "./code-blocks.ts";
import { toolBlock } from "./tool-blocks.ts";

type Theme = Parameters<typeof barCodeBlocks>[1];

/** Components in one container, as a renderer returns them. */
function container(text: string, theme: Theme, expanded: boolean): Container {
	const markdownTheme = getMarkdownTheme();
	barCodeBlocks(markdownTheme, theme);
	const box = new Container();
	for (const part of toolBlock(text, { theme, markdownTheme, transform: (m) => m, expanded })) box.addChild(part);
	return box;
}

export function mcpTools(pi: ExtensionAPI) {
	if (process.env.PI_MCP_VIEW === "0") return;
	pi.registerToolRenderer((toolName, next) => {
		const own = next();
		if (!mcpTool(toolName) || own?.renderCall || own?.renderResult) return own;
		return {
			...own,
			renderCall: (args, theme, context) => container(toolCallBlock(toolName, args, context.cwd), theme, context.expanded),
			renderResult: (result, options, theme, context) => {
				const text = result.content
					.filter((c) => c.type === "text")
					.map((c) => (c as { text: string }).text)
					.join("\n");
				if (options.isPartial && !text.trim()) return new Container();
				// pi draws the images below; without text the header only counts them.
				const images = result.content.filter((c) => c.type === "image").length;
				if (images > 0 && !text.trim()) return container(`⎿ ${images === 1 ? "1 image" : `${images} images`}`, theme, false);
				return container(toolResultBlock(text, { isError: context.isError }), theme, options.expanded);
			},
		};
	});
}
