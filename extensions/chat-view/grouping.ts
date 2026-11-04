/**
 * Splits an assistant message into the work that led to the answer — thoughts,
 * tool use, remarks in between — and the answer itself.
 */

/** Content blocks of an assistant message, as far as the grouping cares. */
export type Block =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall" }
	| { type: string };

export type Section =
	/** Consecutive thoughts; `run` counts the thinking groups of the message. */
	| { kind: "thinking"; texts: string[]; run: number }
	/** Consecutive tool lines of the claude-code provider ("⏺ **Bash** …", "⎿ …", "✗ …"). */
	| { kind: "tools"; texts: string[]; calls: number }
	/** Text the model wrote between its steps. */
	| { kind: "remark"; text: string };

export interface Grouped {
	work: Section[];
	/** Text after the last step, when the message ends there; joined by blank lines. */
	answer?: string;
}

const TOOL_LINE = /^(⏺|⎿|✗) /;

export const isToolLine = (text: string) => TOOL_LINE.test(text.trimStart());

/**
 * The message's sections in order. Text after the last thought or tool line is
 * the answer — unless the message hands over to pi's own tool calls, then the
 * model is not done and that text is a remark too. While the message still
 * streams, any text may yet be followed by a step, so it stays a remark until the end.
 */
export function groupMessage(content: readonly Block[], streaming = false): Grouped {
	const work: Section[] = [];
	let runs = 0;
	for (const block of content) {
		const last = work[work.length - 1];
		if (block.type === "thinking") {
			const text = (block as { thinking: string }).thinking.trim();
			if (!text) continue;
			if (last?.kind === "thinking") last.texts.push(text);
			else work.push({ kind: "thinking", texts: [text], run: runs++ });
		} else if (block.type === "text") {
			const text = (block as { text: string }).text.trim();
			if (!text) continue;
			if (isToolLine(text)) {
				const calls = text.startsWith("⏺") ? 1 : 0;
				if (last?.kind === "tools") {
					last.texts.push(text);
					last.calls += calls;
				} else work.push({ kind: "tools", texts: [text], calls });
			} else work.push({ kind: "remark", text });
		}
	}

	if (streaming || content.some((block) => block.type === "toolCall")) return { work };
	const answer: string[] = [];
	while (work[work.length - 1]?.kind === "remark") answer.unshift((work.pop() as { text: string }).text);
	return answer.length > 0 ? { work, answer: answer.join("\n\n") } : { work };
}
