import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

/** App-server v2 sends one JSON-RPC object per line. IDs are independent in each direction. */
export type Fields = Record<string, any>;
type Pending = { resolve(value: Fields): void; reject(error: Error): void };

export class CodexClient {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<number, Pending>();
	private next = 0;
	private initialized = false;
	private readonly lifetime = new AbortController();
	get signal() {
		return this.lifetime.signal;
	}
	private closed?: Error;
	private stderr = "";
	onEvent?: (method: string, params: Fields) => void;
	onRequest?: (method: string, params: Fields) => Promise<unknown>;
	readonly stopped: Promise<Error>;
	private resolveStopped!: (error: Error) => void;

	constructor(command: string, cwd: string) {
		this.stopped = new Promise((resolve) => {
			this.resolveStopped = resolve;
		});
		// Only the user's configured base command is shell syntax. Protocol values travel on stdin.
		this.child = spawn("/bin/sh", ["-c", command + ' "$@"', "pi-codex", "app-server", "--stdio"], {
			cwd,
			stdio: "pipe",
			detached: true,
		});
		this.child.stderr.setEncoding("utf8").on("data", (chunk) => {
			this.stderr = (this.stderr + chunk).slice(-2400);
		});
		this.child.on("error", (error) => this.close(error));
		this.child.stdin.on("error", (error) => this.close(error));
		this.child.on("close", (code) => this.close(new Error(`Codex exited (${code ?? "signal"}). ${this.stderr.trim()}`)));
		const lines = createInterface({ input: this.child.stdout });
		lines.on("line", (line) => {
			try {
				this.receive(JSON.parse(line));
			} catch (error) {
				this.close(new Error(`Invalid Codex event: ${error}`));
			}
		});
	}

	private send(message: Fields) {
		if (!this.closed) this.child.stdin.write(JSON.stringify(message) + "\n");
	}

	private receive(message: Fields) {
		if (this.closed) return;
		const { id, method, params } = message;
		if (typeof method === "string") {
			if (id === undefined) this.onEvent?.(method, params ?? {});
			else {
				const answer = this.onRequest?.(method, params ?? {});
				if (!answer) this.send({ id, error: { code: -32601, message: "Unsupported Codex client request: " + method } });
				else
					void answer.then(
						(result) => this.send({ id, result }),
						(e) => this.send({ id, error: { code: -32000, message: String(e) } }),
					);
			}
		} else {
			const pending = this.pending.get(id);
			if (!pending) return;
			this.pending.delete(id);
			if (message.error) pending.reject(new Error(message.error.message || "Codex request failed"));
			else pending.resolve(message.result ?? {});
		}
	}

	request(method: string, params: Fields = {}, timeout = 30_000): Promise<Fields> {
		if (this.closed) return Promise.reject(this.closed);
		const id = ++this.next;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("Codex timed out answering " + method));
			}, timeout);
			this.pending.set(id, {
				resolve: (result) => {
					clearTimeout(timer);
					resolve(result);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this.send({ id, method, params });
		});
	}

	async initialize() {
		if (this.initialized) return;
		await this.request("initialize", {
			clientInfo: { name: "pi_codex", title: "Codex for pi", version: "0.1.0" },
			capabilities: { experimentalApi: true },
		});
		this.send({ method: "initialized" });
		this.initialized = true;
	}

	close(error = new Error("Codex connection closed")) {
		if (this.closed) return;
		this.closed = error;
		this.lifetime.abort(error);
		this.onEvent = undefined;
		this.onRequest = undefined;
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
		this.resolveStopped(error);
		this.child.stdin.end();
		if (this.child.pid && this.child.exitCode === null && this.child.signalCode === null) {
			try {
				process.kill(-this.child.pid, "SIGTERM");
			} catch {
				/* already gone */
			}
		}
	}
}

export async function withClient<T>(command: string, cwd: string, use: (client: CodexClient) => Promise<T>) {
	const client = new CodexClient(command, cwd);
	try {
		await client.initialize();
		return await use(client);
	} finally {
		client.close();
	}
}
