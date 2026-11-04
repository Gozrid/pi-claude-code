/**
 * pi's MCP servers for the CLIs, through pi's own connections
 *
 * pi connects the servers of its mcp.json itself. A CLI that started them as
 * well would run every server twice (two `dart mcp-server`, two device
 * connections). So the bridge serves each server at `/mcp/<server>` and runs
 * the calls through pi's tool of it: one process, and pi's `exposure` and
 * `toolExposure` decide which tools the CLI sees (hidden ones it does not).
 *
 * pi lends its tools to a tool's `prepareLoadout` hook (on `pi_ask`), which
 * runs whenever the registered tools change, e.g. when a server connected.
 */

import type { ToolLoadout } from "@earendil-works/pi-coding-agent";
import { PI_MCP_SOURCE, type PiToolInfo } from "../shared/pi-mcp.ts";
import type { BridgeTool, ProxiedServer, ToolAnnotations } from "./server.ts";

/** How long a CLI's first look at a server waits for pi to connect it. */
export const CONNECT_WAIT_MS = 10_000;

type AgentTool = ToolLoadout["registered"][number];

interface PiInfo extends PiToolInfo {
	annotations?: ToolAnnotations;
}

export class McpProxy {
	private loadout: ToolLoadout | undefined;
	private waiters = new Set<() => void>();
	private calls = 0;

	/**
	 * `infos`: pi.getAllTools(); `piConnects`: whether pi's own MCP support is
	 * on (otherwise nobody connects the servers in pi).
	 */
	private readonly infos: () => readonly PiInfo[];
	private readonly piConnects: () => boolean;
	private readonly waitMs: number;

	constructor(infos: () => readonly PiInfo[], piConnects: () => boolean, waitMs = CONNECT_WAIT_MS) {
		this.infos = infos;
		this.piConnects = piConnects;
		this.waitMs = waitMs;
	}

	/** From the `prepareLoadout` hook: pi's tools as they are now. */
	update(loadout: ToolLoadout): void {
		this.loadout = loadout;
		for (const wake of [...this.waiters]) wake();
	}

	/** The session ended; its tools are gone. */
	clear(): void {
		this.loadout = undefined;
		for (const wake of [...this.waiters]) wake();
	}

	/** Whether the CLIs should get pi's servers through the bridge. */
	get active(): boolean {
		return this.loadout !== undefined && this.piConnects();
	}

	/** pi's tools of `server`, hidden ones included (they show that pi connected it). */
	private toolsOf(server: string): AgentTool[] {
		const loadout = this.loadout;
		if (!loadout) return [];
		const prefix = `${server}/`;
		const fromMcp = new Set(this.infos().flatMap((t) => (t.sourceInfo?.path === PI_MCP_SOURCE ? [t.name] : [])));
		return loadout.registered.filter((tool) => tool.name.startsWith("mcp__") && tool.label?.startsWith(prefix) && fromMcp.has(tool.name));
	}

	/** Waits until pi has registered tools of `server`, or gives up. */
	private async connected(server: string): Promise<AgentTool[]> {
		const deadline = Date.now() + this.waitMs;
		for (;;) {
			const tools = this.toolsOf(server);
			if (tools.length > 0 || !this.loadout || Date.now() >= deadline) return tools;
			await new Promise<void>((resolve) => {
				const wake = () => {
					clearTimeout(timer);
					this.waiters.delete(wake);
					resolve();
				};
				const timer = setTimeout(wake, Math.min(500, Math.max(0, deadline - Date.now())));
				this.waiters.add(wake);
			});
		}
	}

	/** The MCP server the bridge serves at /mcp/<server>. */
	server(name: string): ProxiedServer | undefined {
		if (!this.active) return undefined;
		const proxy = this;
		return {
			info: { name, version: "pi" },
			get instructions() {
				const tool = proxy.toolsOf(name)[0];
				return tool ? proxy.loadout?.getNamespace(tool.name)?.instructions : undefined;
			},
			tools: async () => {
				const tools = await this.connected(name);
				const loadout = this.loadout;
				if (!loadout) return [];
				const infos = new Map(this.infos().map((t) => [t.name, t]));
				return tools
					.filter((tool) => loadout.getExposure(tool.name) !== "hidden")
					.map((tool) => this.bridgeTool(name, tool, infos.get(tool.name)?.annotations));
			},
		};
	}

	private bridgeTool(server: string, tool: AgentTool, annotations: ToolAnnotations | undefined): BridgeTool {
		return {
			name: tool.label.slice(server.length + 1),
			description: tool.description,
			inputSchema: tool.parameters as unknown as Record<string, unknown>,
			...(annotations ? { annotations } : {}),
			call: async (args) => {
				const result = (await tool.execute(`pi-bridge-${++this.calls}`, args)) as {
					content: unknown[];
					structuredContent?: unknown;
					isError?: boolean;
				};
				// pi keeps the server's result whole beside what it gives its own models.
				const raw = result.structuredContent as { content?: unknown } | undefined;
				if (raw && typeof raw === "object" && Array.isArray(raw.content)) return { text: "", raw: raw as Record<string, unknown> };
				return { text: "", raw: { content: result.content, isError: result.isError ?? false } };
			},
		};
	}
}
