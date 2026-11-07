/**
 * Chat view for pi
 *
 * Changes to how the chat itself looks and behaves, for any model:
 *   - sticky prompt: in fullscreen mode the user message stays pinned above its
 *     answer while scrolling (see sticky-prompt.ts; /sticky, PI_STICKY_PROMPT=0)
 *   - steer and queue: while the agent works, the keys to steer or queue a message
 *     and the messages waiting, instead of pi's own lines (see message-queue.ts;
 *     /queue, PI_QUEUE_VIEW=0)
 *   - grouped messages: thoughts and tool calls grouped in a framed work part,
 *     the answer set apart below it (see grouped-messages.ts; /group, PI_GROUP_MESSAGES=0)
 *   - tool blocks: the CLI agents' tool calls with a compact header, highlighted code,
 *     line numbers, error lines and images, details collapsed until Ctrl+O (see tool-blocks.ts)
 *   - MCP tools of pi's own models drawn the same way (see mcp-tools.ts; PI_MCP_VIEW=0)
 *   - code blocks: a line on the left, bending into the language, instead of the ``` fences (see code-blocks.ts)
 *   - mermaid diagrams: a flowchart too wide for the chat drawn turned; what is too wide
 *     either way goes back to the model to redraw (see mermaid.ts; PI_MERMAID_FEEDBACK=0)
 *   - extension list: while the chat is empty, the loaded extensions above the
 *     editor, in place of pi's startup listing (see extension-list.ts)
 *   - prompt history: ↑ in the empty editor opens the session's earlier prompts as a
 *     list right above it (see prompt-history.ts; PI_HISTORY_STATIC=1)
 *   - command list: pi's suggestions for /commands and files in a frame above the
 *     editor instead of below it (see command-list.ts)
 *   - answer box: after a long round the answer in a scrollable box above the editor
 *     (see answer-box.ts; PI_ANSWER_BOX_AFTER)
 *   - shell mode: ! and !! turn the editor's borders purple with a sweep, !! greys the
 *     text, and a grey hint says where the output goes (see shell-mode.ts; PI_SHELL_MODE_VIEW=0)
 *   - editor height: the editor grows and shrinks row by row instead of jumping
 *     (see editor-height.ts; PI_EDITOR_STATIC=1)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { answerBox } from "./answer-box.ts";
import { commandList } from "./command-list.ts";
import { editorHeight } from "./editor-height.ts";
import { extensionList } from "./extension-list.ts";
import { groupedMessages } from "./grouped-messages.ts";
import { mcpTools } from "./mcp-tools.ts";
import { mermaidDiagrams } from "./mermaid.ts";
import { messageQueue } from "./message-queue.ts";
import { promptHistory } from "./prompt-history.ts";
import { shellModeView } from "./shell-mode.ts";
import { stickyPrompt } from "./sticky-prompt.ts";

export default function (pi: ExtensionAPI) {
	stickyPrompt(pi);
	messageQueue(pi);
	groupedMessages(pi);
	mcpTools(pi);
	mermaidDiagrams(pi);
	extensionList(pi);
	// Before editorHeight, so its wrapper sees the editor's own rows.
	shellModeView(pi);
	editorHeight(pi);
	// Last, so their widgets sit right above the editor; the box gives way to the lists.
	const history = promptHistory(pi);
	const commands = commandList(pi);
	answerBox(pi, { showing: () => history.showing() || commands.showing() });
}
