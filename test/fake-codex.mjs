import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let cwd;
let thread = "thread-a",
	turn = "turn-1",
	pending = false,
	checkout;
const event = (method, params) => send({ method, params: { threadId: thread, turnId: turn, ...params } });
const finish = () => {
	event("item/started", { item: { type: "agentMessage", id: "answer" } });
	event("item/agentMessage/delta", { itemId: "answer", delta: "Pip " });
	event("item/agentMessage/delta", { itemId: "answer", delta: "ready" });
	event("item/completed", { item: { type: "agentMessage", id: "answer", text: "Pip ready" } });
	event("turn/completed", { turn: { id: turn, status: "completed" } });
};
for await (const line of createInterface({ input: process.stdin })) {
	const { id, method, params: p, result } = JSON.parse(line);
	if (process.env.PI_FAKE_CODEX_LOG)
		appendFileSync(process.env.PI_FAKE_CODEX_LOG, JSON.stringify({ method, params: p, result }) + "\n");
	const reply = (result = {}) => send({ id, result });
	if (!method) {
		if (pending) {
			pending = false;
			if (checkout && result?.decision === "accept") {
				const retry = { ...checkout, id: "checkout-retry" };
				event("item/started", { item: retry });
				event("item/completed", { item: { ...retry, exitCode: 0, aggregatedOutput: "Switched branch" } });
			}
			checkout = undefined;
			finish();
		}
		continue;
	}
	switch (method) {
		case "initialize":
			reply({ userAgent: "fake-codex" });
			break;
		case "initialized":
			break;
		case "model/list":
			reply({
				data: [
					{
						model: "gpt-fake",
						displayName: "Fake",
						inputModalities: ["image", "text"],
						supportedReasoningEfforts: [{ reasoningEffort: "high" }],
					},
				],
				nextCursor: null,
			});
			break;
		case "account/login/start":
			reply({ type: "chatgpt", loginId: "login-1", authUrl: "https://example.test/codex" });
			event("account/login/completed", { loginId: "login-1", success: true });
			break;
		case "account/rateLimits/read":
			reply({ rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1000 } } });
			break;
		case "config/read":
			reply({ config: { model: "gpt-fake", mcp_servers: { native: { command: "unused" } } } });
			break;
		case "thread/turns/list":
			reply({ data: [{ id: "turn-1" }] });
			break;
		case "thread/resume":
			thread = p.threadId;
			turn = "turn-2";
			reply({ thread: { id: thread }, model: p.model || "gpt-fake" });
			break;
		case "thread/start":
			cwd = p.cwd;
			reply({ thread: { id: thread }, model: p.model || "gpt-fake" });
			break;
		case "turn/start": {
			reply({ turn: { id: turn } });
			event("turn/started", { turn: { id: turn } });
			if (p.input.some((b) => b.text === "crash")) process.exit(9);
			if (p.input.some((b) => b.text === "wait")) break;
			if (p.input.some((b) => b.text === "retry checkout")) {
				const command = "/bin/zsh -lc 'git switch feature/sample'";
				checkout = { type: "commandExecution", id: "checkout", command };
				event("item/started", { item: checkout });
				event("item/completed", {
					item: { ...checkout, exitCode: 128, aggregatedOutput: "fatal: .git/index.lock: Operation not permitted" },
				});
				pending = true;
				send({
					id: 1,
					method: "item/commandExecution/requestApproval",
					params: { threadId: thread, turnId: turn, itemId: "checkout-retry", command, cwd },
				});
				break;
			}
			event("turn/plan/updated", { plan: [{ step: "Read the file", status: "inProgress" }] });
			event("item/completed", { item: { type: "reasoning", id: "think", summary: ["Inspecting the file"] } });
			const command = {
				type: "commandExecution",
				id: "cmd",
				command: "cat README.md",
				commandActions: [{ type: "read", path: "README.md" }],
			};
			event("item/started", { item: command });
			event("item/completed", { item: { ...command, aggregatedOutput: "hello", exitCode: 0 } });
			event("thread/tokenUsage/updated", {
				tokenUsage: {
					last: { inputTokens: 80, cachedInputTokens: 20, totalTokens: 88, outputTokens: 8 },
					total: { inputTokens: 160, cachedInputTokens: 40, totalTokens: 176, outputTokens: 16 },
					modelContextWindow: 1000,
				},
			});
			pending = true;
			send({
				id: 1,
				method: "item/commandExecution/requestApproval",
				params: { threadId: thread, turnId: turn, itemId: "write", command: "touch file" },
			});
			break;
		}
		case "turn/steer":
			reply();
			break;
		case "turn/interrupt":
			reply();
			event("turn/completed", { turn: { id: turn, status: "interrupted" } });
			break;
		default:
			send({ id, error: { code: -32601, message: method } });
	}
}
