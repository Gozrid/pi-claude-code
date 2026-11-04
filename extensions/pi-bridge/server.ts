/**
 * A small MCP server over HTTP for the CLI agents pi starts (Claude Code, agy).
 *
 * It runs inside pi, listens on 127.0.0.1 only and answers JSON-RPC posts
 * (Streamable HTTP without SSE): initialize, ping, tools/list, tools/call. Every
 * client gets a token of its own, so a call knows which provider made it. A
 * tool call may wait as long as the user takes to answer a dialog.
 *
 * agy ends every MCP call after 3 minutes. So a call of pi's own tools that
 * still waits after AGY_CALL_LIMIT_MS is answered with "not answered yet, call
 * again" while it goes on running; the next call of that tool attaches to it.
 * From the moment such a call starts until it is answered, agy's hook (/hook,
 * in every run of agy, whatever its mode) holds every further action, so agy
 * cannot go on without the answer.
 *
 * `/mcp` serves pi's own tools; `/mcp/<server>` the servers the owner proxies
 * (`proxy`), each as an MCP server of its own.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const PROTOCOL_VERSION = "2025-06-18";

/** How long an agy call of pi's own tools may wait before pi answers "call again" (agy's own limit: 3 minutes). */
export const AGY_CALL_LIMIT_MS = 150_000;

/** What agy gets while the user has not answered yet. */
export function stillWaiting(tool: string): string {
	return [
		"The user has not answered yet; the dialog in pi is still open.",
		`Call \`${tool}\` again right away, with the same arguments, to keep waiting for the answer.`,
		"Do not go on without the answer and do not assume one: pi holds every other action until the user has answered.",
	].join(" ");
}

/** A tool call agy has stopped waiting for, still running in pi. */
interface PendingCall {
	args: string;
	result: Promise<{ ok: ToolResult } | { error: unknown }>;
	settled: boolean;
}

export interface ToolAnnotations {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

/** Who calls: the provider the token was handed out for. */
export interface BridgeClient {
	/** pi provider id, e.g. "claude-bag". */
	provider: string;
	kind: "claude" | "agy" | "pi";
	/** Extra data the provider gave along (e.g. how to save permission rules). */
	data?: unknown;
}

export interface ToolResult {
	text: string;
	isError?: boolean;
	/** A complete MCP CallToolResult, sent as it is instead of `text`. */
	raw?: Record<string, unknown>;
}

export interface BridgeTool {
	name: string;
	description: string;
	/** JSON Schema of the arguments. */
	inputSchema: Record<string, unknown>;
	annotations?: ToolAnnotations;
	/** Only listed for these kinds of clients; all when unset. */
	only?: BridgeClient["kind"][];
	call(args: Record<string, any>, client: BridgeClient): Promise<ToolResult>;
}

/** A server the owner proxies at `/mcp/<name>`. */
export interface ProxiedServer {
	info: { name: string; version: string };
	instructions?: string;
	/** May wait, e.g. until the server is connected. */
	tools(client: BridgeClient): Promise<BridgeTool[]>;
}

/** What one MCP endpoint offers. */
interface Endpoint {
	info: { name: string; version: string };
	instructions?: string;
	tools(client: BridgeClient): Promise<BridgeTool[]>;
}

interface RpcRequest {
	jsonrpc: "2.0";
	id?: string | number | null;
	method: string;
	params?: any;
}

export class BridgeServer {
	private server: Server | undefined;
	private port = 0;
	private readonly clients = new Map<string, BridgeClient>();

	private readonly tools: () => BridgeTool[];
	private readonly info: { name: string; version: string };
	private readonly instructions: string | undefined;

	/** Answers posts to /hook (CLI hooks); set by the owner. */
	hook: ((payload: any, client: BridgeClient) => Promise<unknown>) | undefined;
	/** The servers served at /mcp/<name>; set by the owner. */
	proxy: ((name: string) => ProxiedServer | undefined) | undefined;
	/** See AGY_CALL_LIMIT_MS; changeable for tests. */
	agyCallLimitMs = AGY_CALL_LIMIT_MS;
	/** agy calls of pi's own tools that run or wait to be picked up, keyed by provider and tool. */
	private readonly pending = new Map<string, PendingCall>();

	constructor(tools: () => BridgeTool[], info = { name: "pi", version: "1.0.0" }, instructions?: string) {
		this.tools = tools;
		this.info = info;
		this.instructions = instructions;
	}

	/** The URL CLI hooks post to. */
	get hookUrl(): string | undefined {
		return this.server ? `http://127.0.0.1:${this.port}/hook` : undefined;
	}

	get url(): string | undefined {
		return this.server ? `http://127.0.0.1:${this.port}/mcp` : undefined;
	}

	async start(): Promise<string> {
		if (this.server) return this.url!;
		const server = createServer((req, res) => void this.handle(req, res));
		// Tool calls wait for the user; no timeout of Node's may cut them off.
		server.requestTimeout = 0;
		server.headersTimeout = 60_000;
		server.keepAliveTimeout = 60_000;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve());
		});
		server.unref();
		this.server = server;
		this.port = (server.address() as AddressInfo).port;
		return this.url!;
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		this.clients.clear();
		this.pending.clear();
		if (!server) return;
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	/** A token for one client; the same client data gets the same token again. */
	token(client: BridgeClient): string {
		for (const [token, known] of this.clients) {
			if (known.provider === client.provider && known.kind === client.kind) {
				this.clients.set(token, client);
				return token;
			}
		}
		const token = randomBytes(24).toString("hex");
		this.clients.set(token, client);
		return token;
	}

	private visibleTools(client: BridgeClient): BridgeTool[] {
		return this.tools().filter((tool) => !tool.only || tool.only.includes(client.kind));
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const auth = req.headers.authorization ?? "";
		const client = auth.startsWith("Bearer ") ? this.clients.get(auth.slice(7)) : undefined;
		if (!client) return send(res, 401, { error: "unauthorized" });
		if (req.method === "DELETE") return send(res, 200, {});
		if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });

		let body: unknown;
		try {
			body = JSON.parse(await readBody(req));
		} catch {
			return send(res, 400, rpcError(null, -32700, "Parse error"));
		}
		if (req.url?.split("?")[0] === "/hook") {
			// A CLI hook (agy's PreToolUse): plain JSON in, its decision out.
			if (!this.hook) return send(res, 404, { error: "no hook" });
			try {
				// No action while a dialog of this agy waits for the user.
				await this.answered(client.provider);
				return send(res, 200, await this.hook(body, client));
			} catch (error) {
				return send(res, 200, { decision: "deny", reason: error instanceof Error ? error.message : String(error) });
			}
		}
		const path = req.url?.split("?")[0] ?? "";
		const endpoint = this.endpoint(path);
		if (!endpoint) return send(res, 404, { error: "no such server" });
		const own = path === "/mcp" || path === "/";
		const batch = Array.isArray(body);
		const requests = (batch ? body : [body]) as RpcRequest[];
		const replies = (await Promise.all(requests.map((request) => this.dispatch(request, client, endpoint, own)))).filter(
			(reply) => reply !== undefined,
		);
		if (replies.length === 0) {
			res.writeHead(202).end();
			return;
		}
		send(res, 200, batch ? replies : replies[0]);
	}

	private endpoint(path: string): Endpoint | undefined {
		if (path === "/mcp" || path === "/") {
			return { info: this.info, instructions: this.instructions, tools: async (client) => this.visibleTools(client) };
		}
		const match = /^\/mcp\/([^/]+)$/.exec(path);
		if (!match) return undefined;
		try {
			return this.proxy?.(decodeURIComponent(match[1]));
		} catch {
			return undefined;
		}
	}

	/** Resolves once no call of `provider` waits for the user any more. */
	private async answered(provider: string): Promise<void> {
		for (;;) {
			const open = [...this.pending.entries()].filter(([key, call]) => key.startsWith(`${provider}\u0000`) && !call.settled);
			if (open.length === 0) return;
			await Promise.all(open.map(([, call]) => call.result));
		}
	}

	/**
	 * Runs a tool for agy: answers within agyCallLimitMs, with stillWaiting()
	 * when the call is not done by then. The next call of the same tool by the
	 * same provider attaches to the running one; a finished one is handed out
	 * once, to a call with the same arguments.
	 */
	private async callForAgy(tool: BridgeTool, args: Record<string, any>, client: BridgeClient): Promise<ToolResult> {
		const key = `${client.provider}\u0000${tool.name}`;
		const argsJson = JSON.stringify(args);
		let call = this.pending.get(key);
		if (call?.settled && call.args !== argsJson) call = undefined;
		if (!call) {
			const started: PendingCall = {
				args: argsJson,
				result: tool.call(args, client).then(
					(ok) => ({ ok }),
					(error) => ({ error }),
				),
				settled: false,
			};
			void started.result.then(() => {
				started.settled = true;
			});
			call = started;
			// Known from the start, so agy's hook holds parallel actions too.
			this.pending.set(key, call);
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const outcome = await Promise.race([
			call.result,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), this.agyCallLimitMs);
			}),
		]);
		clearTimeout(timer);
		if (!outcome) return { text: stillWaiting(tool.name) };
		if (this.pending.get(key) === call) this.pending.delete(key);
		if ("error" in outcome) throw outcome.error;
		return outcome.ok;
	}

	private async dispatch(request: RpcRequest, client: BridgeClient, endpoint: Endpoint, own: boolean): Promise<unknown> {
		if (!request || typeof request.method !== "string") return rpcError(null, -32600, "Invalid Request");
		const id = request.id;
		// Notifications get no reply.
		if (id === undefined || id === null) return undefined;
		switch (request.method) {
			case "initialize":
				return rpcResult(id, {
					protocolVersion: request.params?.protocolVersion ?? PROTOCOL_VERSION,
					capabilities: { tools: { listChanged: false } },
					serverInfo: endpoint.info,
					...(endpoint.instructions ? { instructions: endpoint.instructions } : {}),
				});
			case "ping":
				return rpcResult(id, {});
			case "tools/list":
				return rpcResult(id, {
					tools: (await endpoint.tools(client)).map((tool) => ({
						name: tool.name,
						description: tool.description,
						inputSchema: tool.inputSchema,
						...(tool.annotations ? { annotations: tool.annotations } : {}),
					})),
				});
			case "tools/call": {
				const name = request.params?.name;
				const tool = (await endpoint.tools(client)).find((t) => t.name === name);
				if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
				try {
					const args = request.params?.arguments ?? {};
					const result = own && client.kind === "agy" ? await this.callForAgy(tool, args, client) : await tool.call(args, client);
					if (result.raw) return rpcResult(id, result.raw);
					return rpcResult(id, { content: [{ type: "text", text: result.text }], isError: result.isError ?? false });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return rpcResult(id, { content: [{ type: "text", text: message }], isError: true });
				}
			}
			default:
				return rpcError(id, -32601, `Method not found: ${request.method}`);
		}
	}
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function send(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

const rpcResult = (id: string | number, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: string | number | null, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
