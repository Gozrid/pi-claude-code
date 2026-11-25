import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { BRIDGE_CHANNEL, type BridgeRequest, type BridgeServerInfo } from "../shared/agent-bus.ts";
import { hiddenMcpTools, ownMcp, piMcpServers, viaProxy } from "../shared/pi-mcp.ts";
import { saveToolImage, toolCallBlock, toolResultBlock, fence } from "../shared/tool-lines.ts";
import { canAutoApprove } from "./approvals.ts";
import type { Fields } from "./client.ts";

export const DEFAULT_MODE = "pi-auto";
export const MODES = [DEFAULT_MODE, "auto", "workspace-write", "plan", "default", "read-only", "full-access"];
export function initialMode(configured: string | undefined) {
	return configured && MODES.includes(configured) ? configured : DEFAULT_MODE;
}
export function modeParams(mode: string) {
	switch (mode) {
		case "plan":
		case "read-only":
			return { sandbox: "read-only", approvalPolicy: "never" };
		case "auto":
			return { sandbox: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "auto_review" };
		case DEFAULT_MODE:
		case "workspace-write":
			return { sandbox: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "user" };
		case "full-access":
			return { sandbox: "danger-full-access", approvalPolicy: "never" };
		default:
			return {};
	}
}

export function mcpConfig(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	provider: string,
	native: Fields,
	mode: string,
	superAgent: boolean,
) {
	let bridge: BridgeServerInfo | undefined;
	pi.events.emit(BRIDGE_CHANNEL, {
		provider,
		kind: "codex",
		cwd: ctx.cwd,
		mode,
		superAgent,
		reply: (info) => {
			bridge = info;
		},
	} satisfies BridgeRequest);
	const servers: Fields = ownMcp() ? { ...native.mcp_servers } : {};
	if (!ownMcp()) {
		for (const name of Object.keys(native.mcp_servers ?? {})) servers[name] = { enabled: false };
		const configured = piMcpServers({ agentDir: getAgentDir(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() }).servers;
		const proxy = bridge?.mcpUrl
			? { url: (name: string) => bridge!.mcpUrl + "/" + encodeURIComponent(name), headers: bridge.headers }
			: undefined;
		for (const [name, server] of Object.entries(viaProxy(configured, proxy))) {
			servers[name] = "url" in server ? { url: server.url, http_headers: server.headers } : { ...server };
		}
		if (!proxy)
			for (const { server, tool } of hiddenMcpTools(pi.getAllTools(), Object.keys(configured))) {
				(servers[server].disabled_tools ??= []).push(tool);
			}
	}
	if (bridge) servers[bridge.name] = { url: bridge.url, http_headers: bridge.headers, tool_timeout_sec: 86400 };
	return servers;
}

export function toolInfo(item: Fields) {
	switch (item.type) {
		case "commandExecution": {
			const a = item.commandActions?.length === 1 && item.commandActions[0];
			if (a?.type === "read") return { name: "Read", detail: a.path, input: { file_path: a.path } };
			if (a?.type === "search") return { name: "Grep", detail: a.query, input: { pattern: a.query, path: a.path } };
			return { name: "Bash", detail: item.command, input: { command: item.command } };
		}
		case "fileChange": {
			const path = item.changes?.map((c: Fields) => c.path).join(", ");
			return { name: "Edit", detail: path, input: { file_path: path } };
		}
		case "mcpToolCall":
			return { name: "mcp__" + item.server + "__" + item.tool, detail: item.tool, input: item.arguments };
		case "dynamicToolCall":
			return { name: item.tool, detail: item.namespace, input: item.arguments };
		case "webSearch":
			return { name: "WebSearch", detail: item.query, input: { query: item.query } };
		case "imageView":
			return { name: "Read", detail: item.path, input: { file_path: item.path } };
		case "collabAgentToolCall":
			return { name: "Agent", detail: item.prompt || item.tool, input: { description: item.prompt || item.tool } };
	}
}
export function toolDisplay(item: Fields, cwd: string, scratch: string, completed: boolean) {
	const tool = toolInfo(item);
	if (!tool) return;
	const error =
		item.status === "failed" ||
		item.status === "declined" ||
		!!item.error ||
		item.success === false ||
		(typeof item.exitCode === "number" && item.exitCode !== 0);
	if (!completed) return { ...tool, error, block: toolCallBlock(tool.name, tool.input, cwd, tool.detail) };
	let result = item.aggregatedOutput ?? item.error?.message ?? "";
	const images: string[] = [];
	for (const part of item.result?.content ?? item.contentItems ?? []) {
		if (part.type === "image" && typeof part.data === "string") {
			const path = saveToolImage(scratch, part.data, part.mimeType);
			if (path) images.push(path);
		} else result += (result ? "\n" : "") + (part.text ?? JSON.stringify(part));
	}
	if (!result && item.result?.structuredContent) result = JSON.stringify(item.result.structuredContent);
	if (!result && item.exitCode != null) result = "Exit " + item.exitCode;
	if (!result) result = item.query || item.status || "Done";
	const diff =
		item.type === "fileChange" &&
		item.changes
			?.map((c: Fields) => c.diff)
			.filter(Boolean)
			.join("\n");
	const file = tool.name === "Read" && item.type === "commandExecution" ? { path: tool.detail } : undefined;
	const block =
		toolResultBlock(result, { name: tool.name, file, images, isError: error }) + (diff ? "\n\n" + fence(diff, "diff") : "");
	return { ...tool, error, block };
}

/** Native approval and question callbacks always get a reply, including in print mode and on Escape. */
export async function answerRequest(
	ctx: ExtensionContext | undefined,
	method: string,
	p: Fields,
	signal: AbortSignal,
	item?: Fields,
	mode?: string,
) {
	const ui = ctx?.hasUI && !signal.aborted ? ctx.ui : undefined;
	const confirm = async (title: string, details: string) =>
		!!(ui && (await ui.confirm(title, details, { signal })) && !signal.aborted);
	if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
		const details = [
			p.command || item?.command,
			p.cwd,
			p.reason,
			p.grantRoot,
			item?.changes?.map((c: Fields) => c.path + "\n" + c.diff).join("\n"),
			p.additionalPermissions && JSON.stringify(p.additionalPermissions),
			p.networkApprovalContext && JSON.stringify(p.networkApprovalContext),
		]
			.filter(Boolean)
			.join("\n");
		const allowed = !p.availableDecisions || p.availableDecisions.includes("accept");
		if (
			allowed &&
			ctx &&
			mode === DEFAULT_MODE &&
			method === "item/commandExecution/requestApproval" &&
			(await canAutoApprove(ctx, p, signal))
		) return { decision: "accept" };
		const yes =
			allowed &&
			(await confirm(
				method.includes("fileChange") ? "Allow this Codex file change?" : "Allow this Codex command?",
				details || p.itemId,
			));
		return {
			decision: yes ? "accept" : p.availableDecisions && !p.availableDecisions.includes("decline") ? "cancel" : "decline",
		};
	}
	if (method === "item/permissions/requestApproval") {
		const yes = await confirm(
			"Grant these permissions for this turn?",
			[p.reason, JSON.stringify(p.permissions, null, 2)].filter(Boolean).join("\n"),
		);
		return { permissions: yes ? p.permissions : {}, scope: "turn" };
	}
	if (method === "item/tool/requestUserInput") {
		const answers: Fields = {};
		if (ui)
			for (const q of p.questions) {
				if (q.isSecret) continue;
				const options = (q.options ?? []).map((o: Fields) => o.label + (o.description ? " — " + o.description : ""));
				const other = "Write an answer…";
				const choice = options.length
					? await ui.select(q.question, [...options, ...(q.isOther ? [other] : [])], { signal })
					: other;
				if (!choice) break;
				const answer = choice === other ? await ui.input(q.question, "", { signal }) : q.options[options.indexOf(choice)].label;
				if (answer === undefined) break;
				answers[q.id] = { answers: [answer] };
			}
		return { answers };
	}
	if (method === "mcpServer/elicitation/request") return { action: "decline", content: null, _meta: null };
	throw new Error("Unsupported Codex request: " + method);
}
