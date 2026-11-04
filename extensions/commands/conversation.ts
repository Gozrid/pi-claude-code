/**
 * The conversation of a session branch as Markdown, to read or pick up again
 * later: prompts and answers, thinking, tool calls with their results, shell
 * commands and the summaries of compactions and branches.
 */

/** Just the fields of pi's session entries the export reads. */
export interface ExportEntry {
	type: string;
	timestamp?: string;
	message?: any;
	summary?: string;
	content?: unknown;
	display?: boolean;
	customType?: string;
}

export interface ExportMeta {
	title?: string;
	cwd?: string;
	exportedAt?: Date;
}

/** A fence one backtick longer than any run of backticks in `text`, so code blocks inside stay intact. */
function fenced(text: string, lang = ""): string {
	const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}${lang}\n${text.replace(/\n+$/, "")}\n${fence}`;
}

function details(summary: string, body: string): string {
	return `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: any) => (part?.type === "text" ? part.text : part?.type === "image" ? "[image]" : ""))
		.filter(Boolean)
		.join("\n\n");
}

function assistantParts(message: any): string[] {
	const parts: string[] = [];
	for (const block of Array.isArray(message.content) ? message.content : []) {
		if (block.type === "text" && block.text.trim()) parts.push(block.text.trim());
		else if (block.type === "thinking" && block.thinking?.trim()) parts.push(details("Thinking", block.thinking.trim()));
		else if (block.type === "toolCall") {
			const args = JSON.stringify(block.arguments ?? {}, null, 2);
			parts.push(`**Tool call:** \`${block.name}\`\n\n${fenced(args, "json")}`);
		}
	}
	if (message.stopReason === "error" && message.errorMessage) parts.push(`> **Error:** ${message.errorMessage}`);
	if (message.stopReason === "aborted") parts.push("> *Interrupted*");
	return parts;
}

function messageSection(message: any): string | undefined {
	switch (message?.role) {
		case "user": {
			const text = textOf(message.content).trim();
			return text ? `## User\n\n${text}` : undefined;
		}
		case "assistant": {
			const parts = assistantParts(message);
			const model = message.responseModel ?? message.model;
			return parts.length > 0 ? `## Assistant${model ? ` (${model})` : ""}\n\n${parts.join("\n\n")}` : undefined;
		}
		case "toolResult": {
			const text = textOf(message.content).trim() || "(no output)";
			const label = `Result: <code>${message.toolName}</code>${message.isError ? " (error)" : ""}`;
			return details(label, fenced(text));
		}
		case "bashExecution": {
			const exit = message.cancelled ? "cancelled" : `exit ${message.exitCode ?? "?"}`;
			return `## Shell\n\n${fenced(`$ ${message.command}\n${message.output ?? ""}`, "console")}\n\n*${exit}*`;
		}
		case "custom":
			return message.display === false ? undefined : textOf(message.content).trim() || undefined;
		case "branchSummary":
		case "compactionSummary":
			return `> **Summary of earlier messages:**\n>\n${message.summary
				.trim()
				.split("\n")
				.map((line: string) => `> ${line}`)
				.join("\n")}`;
		default:
			return undefined;
	}
}

function entrySection(entry: ExportEntry): string | undefined {
	switch (entry.type) {
		case "message":
			return messageSection(entry.message);
		case "compaction":
		case "branch_summary":
			return entry.summary ? messageSection({ role: "compactionSummary", summary: entry.summary }) : undefined;
		case "custom_message":
			return entry.display ? textOf(entry.content).trim() || undefined : undefined;
		default:
			return undefined;
	}
}

export function conversationMarkdown(entries: readonly ExportEntry[], meta: ExportMeta = {}): string {
	const when = (meta.exportedAt ?? new Date()).toISOString().replace("T", " ").slice(0, 16);
	const header = [
		`# ${meta.title?.trim() || "pi conversation"}`,
		"",
		`*Exported ${when} UTC${meta.cwd ? ` from \`${meta.cwd}\`` : ""}*`,
	];
	const sections = entries.map(entrySection).filter((s): s is string => !!s);
	return `${[header.join("\n"), ...sections].join("\n\n---\n\n")}\n`;
}

/** A file name for the export: the session name or "conversation", and the time. */
export function exportFileName(title: string | undefined, now = new Date()): string {
	const slug =
		(title ?? "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "conversation";
	const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
	return `pi-${slug}-${stamp}.md`;
}
