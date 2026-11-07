/**
 * pi's connection to an IDE: an MCP client over WebSocket, as Claude Code
 * connects to the IDE plugins (sub-protocol "mcp", the lock file's token in the
 * X-Claude-Code-Ide-Authorization header).
 *
 * The IDE sends notifications on its own (selection_changed, at_mentioned);
 * pi calls its tools (openFile, openDiff, …) with callTool.
 */

import type { IdeLock } from "./lockfiles.ts";

const CONNECT_TIMEOUT = 5_000;
const CALL_TIMEOUT = 15_000;

export interface ToolResult {
	text: string;
	isError: boolean;
}

export interface ConnectionEvents {
	notification(method: string, params: unknown): void;
	closed(): void;
}

export class IdeConnection {
	readonly lock: IdeLock;
	tools: string[] = [];
	private socket: WebSocket | undefined;
	private nextId = 1;
	private pending = new Map<number, { resolve(result: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
	private ended = false;
	private events: ConnectionEvents;

	constructor(lock: IdeLock, events: ConnectionEvents) {
		this.lock = lock;
		this.events = events;
	}

	get ideName(): string {
		return this.lock.ideName;
	}

	get open(): boolean {
		return !this.ended && this.socket?.readyState === WebSocket.OPEN;
	}

	/** Connects and runs MCP's handshake; rejects when the IDE does not answer. */
	async connect(): Promise<void> {
		const headers: Record<string, string> = { "User-Agent": "pi-ide" };
		if (this.lock.authToken) headers["X-Claude-Code-Ide-Authorization"] = this.lock.authToken;
		// Node's WebSocket (undici) takes headers as a second-argument option.
		const socket = new WebSocket(`ws://127.0.0.1:${this.lock.port}`, { protocols: ["mcp"], headers } as any);
		this.socket = socket;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`${this.ideName} did not answer`));
				socket.close();
			}, CONNECT_TIMEOUT);
			socket.addEventListener("open", () => {
				clearTimeout(timer);
				resolve();
			});
			socket.addEventListener("error", () => {
				clearTimeout(timer);
				reject(new Error(`Could not connect to ${this.ideName} on port ${this.lock.port}`));
			});
		});
		socket.addEventListener("message", (event) => this.receive(String(event.data)));
		socket.addEventListener("close", () => this.end());
		await this.request("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "pi", version: "1.0.0" },
		});
		this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
		// Claude Code tells the IDE who connected; JetBrains uses it to find the terminal.
		this.send({ jsonrpc: "2.0", method: "ide_connected", params: { pid: process.pid } });
		try {
			const list = await this.request("tools/list", {});
			this.tools = Array.isArray(list?.tools) ? list.tools.map((t: { name: string }) => t.name) : [];
		} catch {
			this.tools = [];
		}
	}

	has(tool: string): boolean {
		return this.tools.includes(tool);
	}

	async callTool(name: string, args: Record<string, unknown>, timeout = CALL_TIMEOUT): Promise<ToolResult> {
		const result = await this.request("tools/call", { name, arguments: args }, timeout);
		const text = Array.isArray(result?.content)
			? result.content
					.filter((c: { type: string }) => c.type === "text")
					.map((c: { text: string }) => c.text)
					.join("\n")
			: "";
		return { text, isError: result?.isError === true };
	}

	close(): void {
		this.end();
		try {
			this.socket?.close();
		} catch {
			// Already gone.
		}
	}

	private request(method: string, params: unknown, timeout = CALL_TIMEOUT): Promise<any> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${this.ideName} did not answer ${method}`));
			}, timeout);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.send({ jsonrpc: "2.0", id, method, params });
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error as Error);
			}
		});
	}

	private send(message: unknown): void {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error(`Not connected to ${this.ideName}`);
		this.socket.send(JSON.stringify(message));
	}

	private receive(data: string): void {
		let message: any;
		try {
			message = JSON.parse(data);
		} catch {
			return;
		}
		if (typeof message?.id === "number" && this.pending.has(message.id) && !message.method) {
			const call = this.pending.get(message.id)!;
			this.pending.delete(message.id);
			clearTimeout(call.timer);
			if (message.error) call.reject(new Error(message.error.message ?? `${this.ideName} reported an error`));
			else call.resolve(message.result);
			return;
		}
		if (typeof message?.method !== "string") return;
		if (message.id !== undefined) {
			// Requests from the IDE (ping, roots/list): answer so it does not wait.
			const result = message.method === "roots/list" ? { roots: [] } : {};
			try {
				this.send({ jsonrpc: "2.0", id: message.id, result });
			} catch {
				// Closed meanwhile.
			}
			return;
		}
		this.events.notification(message.method, message.params);
	}

	private end(): void {
		if (this.ended) return;
		this.ended = true;
		for (const call of this.pending.values()) {
			clearTimeout(call.timer);
			call.reject(new Error(`Connection to ${this.ideName} closed`));
		}
		this.pending.clear();
		this.events.closed();
	}
}
