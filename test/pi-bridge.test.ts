/**
 * pi-bridge: the MCP server, the question dialog and permission requests.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AskDialog, type AskAnswer, formatAnswers } from "../extensions/pi-bridge/ask.ts";
import {
	ALLOW_ONCE,
	ALLOW_PROJECT,
	addAllowRule,
	choiceFrom,
	DENY,
	permissionQuestion,
	ruleFor,
} from "../extensions/pi-bridge/permission.ts";
import { BridgeServer, type BridgeTool, stillWaiting } from "../extensions/pi-bridge/server.ts";
import { McpProxy } from "../extensions/pi-bridge/mcp-proxy.ts";
import { configDirOf } from "../extensions/claude-code/config.ts";

const work = realpathSync(mkdtempSync(join(tmpdir(), "pi-bridge-test-")));

// =============================================================================
// MCP server
// =============================================================================

const echo: BridgeTool = {
	name: "echo",
	description: "Echoes",
	inputSchema: { type: "object", properties: { text: { type: "string" } } },
	async call(args, client) {
		return { text: `${client.provider}:${args.text}` };
	},
};
const claudeOnly: BridgeTool = { ...echo, name: "permission", only: ["claude"] };

async function rpc(url: string, token: string | undefined, body: unknown) {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: res.status === 202 ? undefined : await res.json() };
}

test("serves MCP over HTTP to clients with a token, with the tools meant for them", async () => {
	const server = new BridgeServer(() => [echo, claudeOnly], { name: "pi", version: "1" }, "Hello");
	const url = await server.start();
	try {
		assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
		assert.equal((await rpc(url, undefined, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 401);

		const claude = server.token({ provider: "claude-bag", kind: "claude" });
		const agy = server.token({ provider: "agy", kind: "agy" });
		assert.equal(server.token({ provider: "claude-bag", kind: "claude" }), claude);

		const init = await rpc(url, claude, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
		assert.equal(init.body.result.protocolVersion, "2025-03-26");
		assert.equal(init.body.result.instructions, "Hello");
		assert.equal((await rpc(url, claude, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);

		const claudeTools = await rpc(url, claude, { jsonrpc: "2.0", id: 2, method: "tools/list" });
		assert.deepEqual(claudeTools.body.result.tools.map((t: any) => t.name), ["echo", "permission"]);
		const agyTools = await rpc(url, agy, { jsonrpc: "2.0", id: 2, method: "tools/list" });
		assert.deepEqual(agyTools.body.result.tools.map((t: any) => t.name), ["echo"]);

		const call = await rpc(url, agy, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } });
		assert.deepEqual(call.body.result, { content: [{ type: "text", text: "agy:hi" }], isError: false });
		const hidden = await rpc(url, agy, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "permission", arguments: {} } });
		assert.equal(hidden.body.error.code, -32602);
	} finally {
		await server.stop();
	}
	assert.equal(server.url, undefined);
});

test("a tool that throws answers with isError", async () => {
	const failing: BridgeTool = { ...echo, name: "fail", call: async () => { throw new Error("nobody there"); } };
	const server = new BridgeServer(() => [failing]);
	const url = await server.start();
	try {
		const token = server.token({ provider: "p", kind: "claude" });
		const call = await rpc(url, token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fail", arguments: {} } });
		assert.deepEqual(call.body.result, { content: [{ type: "text", text: "nobody there" }], isError: true });
	} finally {
		await server.stop();
	}
});

// =============================================================================
// pi's MCP servers through pi's connections
// =============================================================================

/** A tool as pi registers one of a server's (createMcpToolDefinition). */
function mcpTool(server: string, tool: string, result: unknown = { content: [{ type: "text", text: `${tool} done` }] }) {
	const calls: unknown[] = [];
	return {
		calls,
		name: `mcp__${server.replace(/[^A-Za-z0-9_]/g, "_")}__${tool}`,
		label: `${server}/${tool}`,
		description: `${tool} of ${server}`,
		parameters: { type: "object", properties: { x: { type: "number" } } },
		async execute(_id: string, params: unknown) {
			calls.push(params);
			return { content: [{ type: "text", text: "for pi's models" }], details: {}, structuredContent: result };
		},
	};
}

test("pi's MCP servers are served from pi's connections, without the tools pi hides", async () => {
	const tap = mcpTool("maestro", "tap_on");
	const cloud = mcpTool("maestro", "run_on_cloud");
	const shot = mcpTool("maestro", "take_screenshot", { content: [{ type: "image", data: "AAA=", mimeType: "image/png" }], isError: false });
	const exposure: Record<string, string> = { [tap.name]: "deferred", [cloud.name]: "hidden", [shot.name]: "direct" };
	const registered: any[] = [];
	const infos = () => registered.map((t) => ({ name: t.name, sourceInfo: { path: "builtin:mcp" }, annotations: t === tap ? { readOnlyHint: false } : undefined }));
	let piConnects = true;
	const proxy = new McpProxy(infos, () => piConnects, 300);
	const loadout = () =>
		({ registered: [...registered], declared: [], callable: [], getExposure: (n: string) => exposure[n] ?? "direct", getNamespace: () => ({ name: "mcp__maestro", instructions: "Use maestro." }), getPromptGuidelines: () => [] }) as any;

	assert.equal(proxy.active, false, "nothing before pi lends its tools");
	proxy.update(loadout());
	assert.equal(proxy.active, true);

	const server = new BridgeServer(() => []);
	server.proxy = (name) => proxy.server(name);
	const url = await server.start();
	try {
		const token = server.token({ provider: "claude-bag", kind: "claude" });
		// The server connects in pi while the CLI already asks for its tools.
		const listing = rpc(`${url}/maestro`, token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
		setTimeout(() => {
			registered.push(tap, cloud, shot);
			proxy.update(loadout());
		}, 50);
		const list = await listing;
		assert.deepEqual(list.body.result.tools.map((t: any) => t.name), ["tap_on", "take_screenshot"]);
		assert.deepEqual(list.body.result.tools[0], {
			name: "tap_on",
			description: "tap_on of maestro",
			inputSchema: tap.parameters,
			annotations: { readOnlyHint: false },
		});
		const init = await rpc(`${url}/maestro`, token, { jsonrpc: "2.0", id: 2, method: "initialize", params: {} });
		assert.equal(init.body.result.serverInfo.name, "maestro");
		assert.equal(init.body.result.instructions, "Use maestro.");

		// The server's own result goes back whole, images included.
		const call = await rpc(`${url}/maestro`, token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "take_screenshot", arguments: { x: 1 } } });
		assert.deepEqual(call.body.result, { content: [{ type: "image", data: "AAA=", mimeType: "image/png" }], isError: false });
		assert.deepEqual(shot.calls, [{ x: 1 }]);
		const hidden = await rpc(`${url}/maestro`, token, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "run_on_cloud", arguments: {} } });
		assert.match(hidden.body.error.message, /Unknown tool/);
		assert.deepEqual(cloud.calls, []);

		// A server pi never connects: an empty list once the wait is over.
		const none = await rpc(`${url}/unknown`, token, { jsonrpc: "2.0", id: 5, method: "tools/list" });
		assert.deepEqual(none.body.result.tools, []);

		// Without pi's own MCP support nothing is proxied.
		piConnects = false;
		assert.equal(proxy.active, false);
		assert.equal((await rpc(`${url}/maestro`, token, { jsonrpc: "2.0", id: 6, method: "tools/list" })).status, 404);
	} finally {
		await server.stop();
	}
});

// =============================================================================
// Question dialog
// =============================================================================

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const ENTER = "\r";
const DOWN = "\x1b[B";
const ESC = "\x1b";
const TAB = "\t";

function dialog(questions: ConstructorParameters<typeof AskDialog>[1]) {
	let result: AskAnswer[] | undefined | null = null;
	const d = new AskDialog(undefined, questions, theme, () => {}, (answers) => {
		result = answers;
	});
	const type = (...keys: string[]) => keys.forEach((k) => d.handleInput(k));
	return { d, type, result: () => result };
}

test("the dialog starts on the recommended option and enter chooses it", () => {
	const { d, type, result } = dialog([
		{ question: "Which DB?", options: [{ label: "SQLite" }, { label: "Postgres", recommended: true, description: "Runs in Docker" }] },
	]);
	const screen = d.render(80).join("\n");
	assert.match(screen, /› ○ 2\. Postgres  recommended/);
	assert.match(screen, /Runs in Docker/);
	assert.match(screen, /✎ Own answer:/);
	type(ENTER);
	assert.deepEqual(result(), [{ question: "Which DB?", selected: ["Postgres"] }]);
});

test("an own answer is typed in the list and confirmed with enter", () => {
	const { type, result } = dialog([{ question: "Name?", options: [{ label: "a" }, { label: "b" }] }]);
	type(DOWN, DOWN, ..."Ralf", ENTER);
	assert.deepEqual(result(), [{ question: "Name?", selected: [], own: "Ralf" }]);
});

test("an option with input asks for more text, as does a question with details", () => {
	const { d, type, result } = dialog([
		{ question: "Deploy?", options: [{ label: "Yes" }, { label: "No", input: "Why not?" }] },
		{ question: "Colour?", options: [{ label: "red" }], details: "Which shade?" },
	]);
	type("2");
	assert.match(d.render(80).join("\n"), /Why not\?/);
	type(..."later", ENTER);
	type(ENTER, ..."dark", ENTER);
	assert.deepEqual(result(), [
		{ question: "Deploy?", selected: ["No"], extra: { prompt: "Why not?", text: "later" } },
		{ question: "Colour?", selected: ["red"], extra: { prompt: "Which shade?", text: "dark" } },
	]);
});

test("multiple choice toggles with space; tab moves between questions; esc cancels", () => {
	const multi = dialog([{ question: "Which?", multiSelect: true, options: [{ label: "a" }, { label: "b" }, { label: "c" }] }]);
	multi.type(" ", DOWN, DOWN, " ", ENTER);
	assert.deepEqual(multi.result(), [{ question: "Which?", selected: ["a", "c"] }]);

	const two = dialog([
		{ question: "One?", header: "One", options: [{ label: "x" }] },
		{ question: "Two?", header: "Two", options: [{ label: "y" }] },
	]);
	two.type(TAB);
	assert.match(two.d.render(80).join("\n"), /\[Two\]/);
	two.type(ENTER);
	// The first question is still open, so the dialog goes back to it.
	assert.equal(two.result(), null);
	two.type(ENTER);
	assert.deepEqual(two.result(), [
		{ question: "One?", selected: ["x"] },
		{ question: "Two?", selected: ["y"] },
	]);

	const cancelled = dialog([{ question: "?", options: [{ label: "a" }] }]);
	cancelled.type(ESC);
	assert.equal(cancelled.result(), undefined);
	assert.equal(formatAnswers(undefined), "The user closed the dialog without answering.");
});

test("answers read as text for the agent", () => {
	assert.equal(
		formatAnswers([
			{ question: "DB?", selected: ["Postgres"], extra: { prompt: "Version", text: "17" } },
			{ question: "Name?", selected: [], own: "Ralf" },
		]),
		"1. DB?\n   Chosen: Postgres\n   Version: 17\n2. Name?\n   Own answer: Ralf",
	);
});

// =============================================================================
// Permission requests
// =============================================================================

test("rules in Claude's syntax for commands, files, fetches and other tools", () => {
	assert.equal(ruleFor({ tool: "Bash", input: { command: " npm test " } }, "/p"), "Bash(npm test)");
	assert.equal(ruleFor({ tool: "Edit", input: { file_path: "src/a.ts" } }, "/p"), "Edit(//p/src/a.ts)");
	assert.equal(ruleFor({ tool: "WebFetch", input: { url: "https://pi.dev/docs" } }, "/p"), "WebFetch(domain:pi.dev)");
	assert.equal(ruleFor({ tool: "mcp__freecad__get_view", input: {} }, "/p"), "mcp__freecad__get_view");
});

test("the permission dialog shows the command and offers the ways to allow", () => {
	const q = permissionQuestion({ tool: "Bash", input: { command: "npm test" } }, "Claude", "Bash(npm test)", true);
	assert.equal(q.question, "Claude wants to run a command");
	assert.equal(q.preview, "$ npm test");
	assert.deepEqual(q.options!.map((o) => o.label), [ALLOW_ONCE, "Allow for this session", ALLOW_PROJECT, "Always allow, all projects", DENY]);
	const noPersist = permissionQuestion({ tool: "Bash", input: { command: "ls" } }, "Claude", "Bash(ls)", false);
	assert.equal(noPersist.options!.length, 3);
});

test("the answer decides: allow with a scope, or deny with the user's words", () => {
	assert.deepEqual(choiceFrom({ question: "", selected: [ALLOW_PROJECT] }), { allow: true, scope: "project" });
	assert.deepEqual(choiceFrom({ question: "", selected: [DENY], extra: { prompt: "", text: "use pnpm" } }), {
		allow: false,
		message: "The user denied this action: use pnpm",
	});
	assert.deepEqual(choiceFrom({ question: "", selected: [], own: "run the tests first" }), {
		allow: false,
		message: "The user denied this action: run the tests first",
	});
	assert.equal(choiceFrom(undefined).allow, false);
});

test("an always-allow rule is added to the settings file, keeping the rest", () => {
	const file = join(work, "proj", ".claude", "settings.local.json");
	assert.ok(addAllowRule(file, "Bash(npm test)"));
	writeFileSync(file, JSON.stringify({ model: "x", permissions: { allow: ["Read"], deny: ["Bash(rm:*)"] } }));
	assert.ok(addAllowRule(file, "Bash(npm test)"));
	assert.ok(addAllowRule(file, "Bash(npm test)"));
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
		model: "x",
		permissions: { allow: ["Read", "Bash(npm test)"], deny: ["Bash(rm:*)"] },
	});
});

test("an instance's config folder comes from CLAUDE_CONFIG_DIR in its command", () => {
	assert.equal(configDirOf('CLAUDE_CONFIG_DIR="$HOME/.claude-priv" claude', {}, "/home/me"), "/home/me/.claude-priv");
	assert.equal(configDirOf("CLAUDE_CONFIG_DIR=~/.claude-work claude", {}, "/home/me"), "/home/me/.claude-work");
	assert.equal(configDirOf("claude", { CLAUDE_CONFIG_DIR: "/etc/c" }, "/home/me"), "/etc/c");
	assert.equal(configDirOf("claude", {}, "/home/me"), "/home/me/.claude");
});

// =============================================================================
// The extension
// =============================================================================

test("the extension answers a provider's request with its server and gives pi's own models the tools", async () => {
	const { default: bridge } = await import("../extensions/pi-bridge/index.ts");
	const { BRIDGE_CHANNEL } = await import("../extensions/shared/agent-bus.ts");
	const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void>>();
	const listeners = new Map<string, (data: unknown) => void>();
	const registered: any[] = [];
	const pi: any = {
		events: { on: (channel: string, fn: any) => listeners.set(channel, fn), emit: (channel: string, data: unknown) => listeners.get(channel)?.(data) },
		on: (event: string, fn: any) => handlers.set(event, fn),
		registerTool: (tool: any) => registered.push(tool),
		registerCommand: (name: string) => commands.push(name),
		registerMessageRenderer: (type: string) => renderers.push(type),
		sendMessage: (message: any, options: any) => sent.push({ message, options }),
		getAllTools: () => [],
		getCommands: () => [{ name: "mcp", sourceInfo: { path: "builtin:mcp" } }],
	};
	const commands: string[] = [];
	const renderers: string[] = [];
	const sent: { message: any; options: any }[] = [];
	bridge(pi);
	assert.deepEqual(commands, ["watches", "wishes"]);
	assert.deepEqual(renderers, ["pi-watch"]);
	assert.deepEqual(
		registered.filter((t) => t.exposure === "direct").map((t) => t.name),
		["pi_ask", "pi_change_request"],
	);
	assert.ok(!registered.some((t) => t.name === "pi_permission"));

	// A watch's end goes to the agent in a message that starts a turn.
	const watch = registered.find((t) => t.name === "pi_watch");
	assert.equal(watch.exposure, "deferred");
	const started = await watch.execute("1", { command: "echo red; exit 2", description: "CI" }, undefined, undefined, { model: { provider: "p" }, cwd: work });
	assert.match(started.content[0].text, /^Watch #1 started/);
	for (let i = 0; i < 100 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
	assert.equal(sent.length, 1);
	assert.equal(sent[0].message.customType, "pi-watch");
	assert.match(sent[0].message.content, /^Watch #1 "CI" failed with exit code 2/);
	assert.match(sent[0].message.content, /red/);
	assert.deepEqual(sent[0].options, { triggerTurn: true, deliverAs: "followUp" });

	const request = (hasUI: boolean) => {
		let info: any;
		pi.events.emit(BRIDGE_CHANNEL, { provider: "claude-bag", kind: "claude", cwd: work, reply: (i: any) => (info = i) });
		return info;
	};
	assert.equal(request(true), undefined, "no server before the session starts");
	const ctx = { hasUI: true, cwd: work, ui: { notify() {} } };
	await handlers.get("session_start")!({}, ctx);
	try {
		const info = request(true);
		assert.equal(info.name, "pi");
		assert.equal(info.permissionTool, "mcp__pi__permission");
		assert.equal(info.mcpUrl, undefined, "pi's servers are proxied only once pi lent its tools");
		registered.find((t) => t.name === "pi_ask").prepareLoadout({ registered: [], getExposure: () => "direct", getNamespace: () => undefined });
		assert.equal(request(true).mcpUrl, info.url);
		const list = await rpc(info.url, info.headers.Authorization.slice(7), { jsonrpc: "2.0", id: 1, method: "tools/list" });
		assert.ok(list.body.result.tools.some((t: any) => t.name === "permission"));
		// Every agy run gets the hook that holds it while a dialog is open; only the gated modes get the gate's rules.
		const agy = (mode: string) => {
			let reply: any;
			pi.events.emit(BRIDGE_CHANNEL, { provider: "agy", kind: "agy", cwd: work, mode, reply: (i: any) => (reply = i) });
			return reply;
		};
		for (const mode of ["default", "accept-edits", "plan", "auto", "bypass"]) {
			assert.equal(agy(mode).gate?.url, `${info.url.replace(/\/mcp$/, "")}/hook`, mode);
		}
		assert.ok(agy("default").gate.allow.includes("command(*)"));
		assert.deepEqual(agy("plan").gate.allow, []);
		assert.deepEqual(agy("bypass").gate.allow, []);
		ctx.hasUI = false;
		await handlers.get("agent_start")!({}, ctx);
		assert.equal(request(false).permissionTool, undefined);
		assert.equal(agy("default").gate, undefined, "nobody to answer without a user interface");
	} finally {
		await handlers.get("session_shutdown")!({}, ctx);
	}
});

// =============================================================================
// agy's gate
// =============================================================================

test("the gate tells commands, writes and reads apart and leaves the rest to agy", async () => {
	const { gateAction } = await import("../extensions/pi-bridge/agy-gate.ts");
	assert.deepEqual(gateAction({ toolCall: { name: "run_command", args: { CommandLine: " npm test ", Cwd: "/w" } } }), {
		kind: "command",
		command: "npm test",
		cwd: "/w",
	});
	assert.deepEqual(gateAction({ toolCall: { name: "write_to_file", args: { TargetFile: "/w/a.ts" } } }), { kind: "write", path: "/w/a.ts" });
	assert.deepEqual(gateAction({ toolCall: { name: "replace_file_content", args: { TargetFile: "/w/a.ts" } } }), { kind: "write", path: "/w/a.ts" });
	assert.deepEqual(gateAction({ toolCall: { name: "view_file", args: { AbsolutePath: "/etc/hosts" } } }), { kind: "read", path: "/etc/hosts" });
	assert.equal(gateAction({ toolCall: { name: "search_web", args: { query: "x" } } }), undefined);
	assert.equal(gateAction({ toolCall: { name: "mcp_pi_ask", args: { Path: "/x" } } }), undefined);
});

test("rules, workspace and mode decide whether pi asks", async () => {
	const { needsAsking, coveredBy } = await import("../extensions/pi-bridge/agy-gate.ts");
	const cmd = { kind: "command" as const, command: "gh pr list --limit 5" };
	assert.ok(coveredBy(["command(gh pr list)"], cmd));
	assert.ok(!coveredBy(["command(gh pr)x"], cmd));
	assert.ok(!coveredBy(["command(gh pr lis)"], cmd));
	assert.ok(needsAsking(cmd, "default", ["/w"], []));
	assert.ok(!needsAsking(cmd, "default", ["/w"], ["command(gh pr list)"]));

	const write = { kind: "write" as const, path: "/w/src/a.ts" };
	assert.ok(needsAsking(write, "default", ["/w"], []));
	assert.ok(!needsAsking(write, "accept-edits", ["/w"], []));
	assert.ok(needsAsking({ kind: "write", path: "/other/a.ts" }, "accept-edits", ["/w"], []));
	assert.ok(!needsAsking(write, "default", ["/w"], ["write_file(/w/src)"]));
	assert.ok(needsAsking(write, "default", ["/w"], ["write_file(/w/s)"]));

	assert.ok(!needsAsking({ kind: "read", path: "/w/x" }, "default", ["/w"], []));
	assert.ok(needsAsking({ kind: "read", path: "/etc/hosts" }, "default", ["/w"], []));
});

test("agy's hook: allows what needs no question, asks once per session rule, saves always rules", async () => {
	const { agyHook } = await import("../extensions/pi-bridge/tools.ts");
	const settings = join(work, "agy-settings.json");
	writeFileSync(settings, JSON.stringify({ permissions: { allow: ["command(ls)"] } }));
	const answers: string[][] = [];
	const ui = {
		notify() {},
		custom(factory: any) {
			return new Promise((resolve) => {
				const d = factory({ requestRender() {} }, theme, undefined, resolve);
				for (const key of answers.shift() ?? []) d.handleInput(key);
			});
		},
	};
	const host: any = { ctx: () => ({ hasUI: true, ui }), sessionRules: new Set<string>() };
	const client = { provider: "agy", kind: "agy" as const, data: { cwd: "/w", agySettings: settings, mode: "default" } };
	const run = (command: string) => agyHook(host, { toolCall: { name: "run_command", args: { CommandLine: command } }, workspacePaths: ["/w"] }, client);

	assert.deepEqual(await run("ls -la"), { decision: "allow" });
	assert.deepEqual(await agyHook(host, { toolCall: { name: "search_web", args: {} } }, client), {});

	answers.push(["2"]); // Allow for this session
	assert.deepEqual(await run("npm test"), { decision: "allow" });
	assert.deepEqual(await run("npm test"), { decision: "allow" }, "no second question");

	answers.push(["4", ..."use pnpm", ENTER]); // Deny with a reason
	assert.deepEqual(await run("npm publish"), { decision: "deny", reason: "The user denied this action: use pnpm" });

	answers.push(["3"]); // Always allow
	assert.deepEqual(await run("make"), { decision: "allow" });
	assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")).permissions.allow, ["command(ls)", "command(make)"]);

	// Outside default and accept-edits the hook has no opinion: agy's mode decides.
	for (const mode of ["plan", "auto", "bypass"]) {
		assert.deepEqual(await agyHook(host, { toolCall: { name: "run_command", args: { CommandLine: "rm x" } } }, { ...client, data: { ...client.data, mode } }), {});
	}

	host.ctx = () => ({ hasUI: false, ui });
	assert.equal((await run("rm x")).decision, "deny");
});

test("a wish to change pi can be worked on here: the agent gets the package folder and its rules", async () => {
	const { bridgeTools, PACKAGE_ROOT, WISH_HERE } = await import("../extensions/pi-bridge/tools.ts");
	let shown: string[] = [];
	const ui = {
		notify() {},
		custom(factory: any) {
			return new Promise((resolve) => {
				const d = factory({ requestRender() {} }, theme, undefined, resolve);
				shown = d.render(120).join("\n").split("\n");
				d.handleInput(ENTER); // the recommended option
			});
		},
	};
	const host: any = { pi: {}, ctx: () => ({ hasUI: true, cwd: work, ui }), sessionRules: new Set<string>(), wishesFile: join(work, "wishes.md") };
	const tool = bridgeTools(host).find((t) => t.name === "change_request")!;
	const result: any = await tool.call({ request: "make the status line red" }, { provider: "claude", kind: "claude" } as any);
	assert.ok(shown.some((l) => l.includes(WISH_HERE)));
	assert.match(result.text, /done now, in this chat/);
	assert.ok(result.text.includes(PACKAGE_ROOT) && result.text.includes("CLAUDE.md") && result.text.includes("/reload"));
});

// =============================================================================
// Wish list
// =============================================================================

test("the wish list keeps title, short title, status and description in Markdown, and reads the old one-line list", async () => {
	const { addWish, formatWishes, openWishes, parseWishes, readWishes, setWishStatus, wishLines } = await import("../extensions/pi-bridge/wishes.ts");
	const legacy = parseWishes("# Wishes for pi\n\n- 2026-11-01 (/work): Make MCP calls readable. With highlighting.\n");
	assert.equal(legacy.length, 1);
	assert.deepEqual([legacy[0].id, legacy[0].status, legacy[0].added, legacy[0].project], [1, "open", "2026-11-01", "/work"]);
	assert.ok(legacy[0].short.length <= 20);

	const file = join(work, "wish-list", "wishes.md");
	const first = addWish(file, { title: "Readable MCP tool calls", short: "Readable MCP calls", description: "Line one.\n\nLine two.", project: "/work" });
	const second = addWish(file, { title: "Red status line", short: "A short title that is far too long to be shown", description: "Make it red." });
	assert.deepEqual([first.id, second.id], [1, 2]);
	assert.ok(second.short.endsWith("…") && second.short.length <= 20);
	assert.deepEqual(parseWishes(formatWishes(readWishes(file))), readWishes(file), "survives a round trip");
	assert.equal(readWishes(file)[0].description, "Line one.\n\nLine two.");

	assert.equal(setWishStatus(file, 2, "in progress")?.status, "in progress");
	assert.equal(setWishStatus(file, 9, "done"), undefined);
	assert.deepEqual(openWishes(readWishes(file)).map((w) => w.id), [2, 1], "in progress first");
	const lines = wishLines(theme, readWishes(file));
	assert.equal(lines[0], "Wishes ›", "the heading reads as a link");
	assert.ok(lines[1].includes("◐") && lines[2].includes("Readable MCP calls"));
	assert.equal(lines.at(-1), "click or /wishes", "says how to open the list");

	setWishStatus(file, 1, "done");
	setWishStatus(file, 2, "done");
	assert.ok(readWishes(file)[0].done, "done wishes keep their date");
	assert.deepEqual(wishLines(theme, readWishes(file)), [], "nothing to show once all are done");
});

test("a wish put on the list gets its titles, and the agent can read the list and mark a wish in progress", async () => {
	const { bridgeTools } = await import("../extensions/pi-bridge/tools.ts");
	const { readWishes } = await import("../extensions/pi-bridge/wishes.ts");
	const ui = {
		notify() {},
		custom(factory: any) {
			return new Promise((resolve) => {
				const d = factory({ requestRender() {} }, theme, undefined, resolve);
				d.handleInput("2"); // Add to the wish list
			});
		},
	};
	let changed = 0;
	const wishesFile = join(work, "tool-wishes.md");
	const host: any = { pi: {}, ctx: () => ({ hasUI: true, cwd: work, ui }), sessionRules: new Set<string>(), wishesFile, wishesChanged: () => changed++ };
	const tools = bridgeTools(host);
	const call = (name: string, args: any) => tools.find((t) => t.name === name)!.call(args, { provider: "claude", kind: "claude" } as any) as Promise<any>;

	await assert.rejects(
		call("change_request", { title: "Red status line", short: "The status line in red", request: "Make the status line red." }),
		/at most 20/,
		"a short title that is too long is refused before the dialog",
	);
	const added = await call("change_request", { title: "Red status line", short: "Red status", request: "Make the status line red." });
	assert.match(added.text, /wish list as #1/);
	assert.deepEqual(
		readWishes(wishesFile).map((w) => [w.title, w.short, w.description, w.status, w.project]),
		[["Red status line", "Red status", "Make the status line red.", "open", work]],
	);

	assert.match((await call("wishes", { status: "open" })).text, /#1 Red status line \(short: Red status; status: open/);
	assert.match((await call("wish_update", { id: 1, status: "in progress" })).text, /now in progress/);
	assert.equal(readWishes(wishesFile)[0].status, "in progress");
	assert.equal((await call("wish_update", { id: 7, status: "done" })).isError, true);
	assert.match((await call("wishes", { status: "open" })).text, /No wishes open/);
	assert.equal(changed, 2);
});

test("agy is told to call again before its 3-minute limit, the dialog stays open and every agy action waits for the answer", async () => {
	let answer: (text: string) => void = () => {};
	const shown: unknown[] = [];
	const ask: BridgeTool = {
		name: "ask",
		description: "Asks",
		inputSchema: { type: "object" },
		call(args) {
			shown.push(args);
			return new Promise((resolve) => {
				answer = (text) => resolve({ text });
			});
		},
	};
	const server = new BridgeServer(() => [ask]);
	server.agyCallLimitMs = 50;
	const hooked: unknown[] = [];
	server.hook = async (payload) => {
		hooked.push(payload);
		return { decision: "allow" };
	};
	const url = await server.start();
	try {
		const agy = server.token({ provider: "agy-home", kind: "agy" });
		const call = (id: number, args: unknown = { q: 1 }) => rpc(url, agy, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "ask", arguments: args } });

		// An action agy runs next to the open dialog already waits, before the limit is reached.
		const firstCall = call(1);
		await new Promise((r) => setTimeout(r, 10));
		let early = false;
		const earlyHook = rpc(`${url.replace(/\/mcp$/, "")}/hook`, agy, { toolCall: { name: "view_file" } }).then(() => {
			early = true;
		});
		const first = await firstCall;
		assert.equal(early, false);
		assert.equal(first.body.result.content[0].text, stillWaiting("ask"));
		assert.equal(first.body.result.isError, false);
		// Calling again attaches to the open dialog instead of showing a second one.
		assert.equal((await call(2)).body.result.content[0].text, stillWaiting("ask"));
		assert.equal(shown.length, 1);

		// agy's hook holds its next action until the user has answered.
		let hookDone = false;
		const hook = rpc(`${url.replace(/\/mcp$/, "")}/hook`, agy, { toolCall: { name: "run_command" } }).then((r) => {
			hookDone = true;
			return r;
		});
		await new Promise((r) => setTimeout(r, 120));
		assert.equal(hookDone, false);
		assert.deepEqual(hooked, []);

		answer("blue");
		assert.deepEqual((await hook).body, { decision: "allow" });
		await earlyHook;
		// The answer goes to the next call, once.
		assert.equal((await call(3)).body.result.content[0].text, "blue");
		const fresh = call(4);
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(shown.length, 2, "a new question opens a new dialog");
		answer("red");
		assert.equal((await fresh).body.result.content[0].text, "red");
	} finally {
		await server.stop();
	}
});

test("claude's calls are not cut short: it waits itself", async () => {
	const slow: BridgeTool = {
		name: "ask",
		description: "Asks",
		inputSchema: { type: "object" },
		call: () => new Promise((resolve) => setTimeout(() => resolve({ text: "late" }), 120)),
	};
	const server = new BridgeServer(() => [slow]);
	server.agyCallLimitMs = 20;
	const url = await server.start();
	try {
		const claude = server.token({ provider: "claude-bag", kind: "claude" });
		const reply = await rpc(url, claude, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask", arguments: {} } });
		assert.equal(reply.body.result.content[0].text, "late");
	} finally {
		await server.stop();
	}
});

// =============================================================================
// Wish popup
// =============================================================================

test("each row of the wish list in the empty chat opens its wish; the heading and the hint the first, '+n more' the first not listed", async () => {
	const { wishLineIds, wishLines } = await import("../extensions/pi-bridge/wishes.ts");
	const wishes = [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id, title: `Wish ${id}`, short: `W${id}`, status: id === 5 ? "in progress" : "open", description: "" }) as const);
	const ids = wishLineIds(wishes as any);
	assert.equal(ids.length, wishLines(theme, wishes as any).length);
	assert.deepEqual(ids, [5, 5, 1, 2, 3, 4, 6, 5]);
	assert.deepEqual(wishLineIds([]), []);
});

test("a click on a right-aligned row opens it; clicks beside it and other buttons pass", async () => {
	const { rowClick } = await import("../extensions/shared/wish-list.ts");
	const opened: number[] = [];
	const at = (type: string, x: number, y: number, button = "left") => rowClick({ type, button, x, y } as any, ["Wishes", "A wish"], 5, 40, (row) => opened.push(row));
	// "A wish" spans columns 33..38 of row 6.
	assert.deepEqual(at("press", 35, 6), { handled: true, render: false });
	at("click", 35, 6);
	assert.deepEqual(opened, [1]);
	assert.equal(at("click", 30, 6), undefined, "left of the row");
	assert.equal(at("click", 39, 6), undefined, "the edge column");
	assert.equal(at("click", 35, 4), undefined, "above the list");
	assert.equal(at("click", 35, 6, "right"), undefined);
	assert.equal(at("wheel", 35, 6), undefined, "the wheel still scrolls");
	assert.deepEqual(opened, [1]);
});

test("the wish popup lists the wishes on the left and shows the selected one in full on the right", async () => {
	const { BOX_ROWS, filterWishes, nextStatus, WishBrowser, workPrompt } = await import("../extensions/pi-bridge/wish-popup.ts");
	const { visibleWidth } = await import("@earendil-works/pi-tui");
	const { addWish, readWishes, setWishStatus } = await import("../extensions/pi-bridge/wishes.ts");
	const file = join(work, "popup", "wishes.md");
	addWish(file, { title: "Readable MCP tool calls", short: "Readable MCP", description: "Show FreeCAD calls readably.", project: "/work" });
	addWish(file, { title: "Stepper for steps", short: "Stepper", description: "Steps the model sets.\n\nSecond paragraph about the bar." });
	addWish(file, { title: "Wishes popup", short: "Wishes popup", description: "A popup with list and preview." });
	setWishStatus(file, 1, "done");
	setWishStatus(file, 3, "in progress");

	const fullTheme = { ...theme, bg: (_c: string, t: string) => t, inverse: (t: string) => t };
	const events: string[] = [];
	const make = (selected?: number, rows = 20) =>
		new WishBrowser({
			theme: fullTheme,
			load: () => readWishes(file),
			markdown: (text) => text.split("\n"),
			rows: () => rows,
			requestRender() {},
			selected,
			setStatus: (id, status) => {
				setWishStatus(file, id, status);
				events.push(`status ${id} ${status}`);
			},
			work: (wish) => events.push(`work ${wish.id}`),
			edit: () => events.push("edit"),
			copy: (wish) => events.push(`copy ${wish.id}`),
			close: () => events.push("close"),
		});

	assert.deepEqual(filterWishes(readWishes(file), 0, "").map((w) => w.id), [3, 2], "active: in progress first");
	assert.deepEqual(filterWishes(readWishes(file), 4, "paragraph bar").map((w) => w.id), [2], "search in the description, all words");
	assert.equal(nextStatus("done"), "open");
	assert.match(workPrompt(readWishes(file)[2]), /wish #3 "Wishes popup"/);

	const popup = make(2);
	let screen = popup.render(100).join("\n");
	assert.equal(popup.render(100).length, 20, "takes the rows it is given");
	assert.ok(popup.render(100).every((line) => visibleWidth(line) === 100), "every line as wide as the popup");
	assert.match(screen, /Active 2 .*Open 1 .*In progress 1 .*Done 1 .*All 3/);
	assert.match(screen, /│ ◐ #3 Wishes popup /, "a box per wish");
	assert.match(screen, /│ added \d{4}-\d{2}-\d{2} /, "with the date it was added");
	assert.match(screen, /│ A popup with list/, "and the start of its description");
	assert.match(screen, /Stepper for steps/, "the selected wish's title");
	assert.match(screen, /Second paragraph about the bar/, "its whole description");
	assert.doesNotMatch(screen, /Readable MCP/, "done wishes are not active");

	popup.handleInput(DOWN);
	assert.match(popup.render(100).join("\n"), /Second paragraph/, "the last one stays selected");
	popup.handleInput("k");
	assert.match(popup.render(100).join("\n"), /A popup with list and preview/);

	popup.handleInput("\t");
	popup.handleInput("\t");
	popup.handleInput("\t");
	screen = popup.render(100).join("\n");
	assert.match(screen, /Show FreeCAD calls readably/, "tab to Done");
	assert.match(screen, /added \d{4}-\d{2}-\d{2} · done/);

	popup.handleInput("/");
	for (const key of "zzz") popup.handleInput(key);
	assert.match(popup.render(100).join("\n"), /No wish matches/);
	popup.handleInput(ESC);
	assert.match(popup.render(100).join("\n"), /FreeCAD/, "esc clears the search");

	popup.handleInput("c");
	popup.handleInput("s");
	assert.equal(readWishes(file)[0].status, "open", "s cycles done to open");
	assert.match(popup.render(100).join("\n"), /No wishes here/, "it leaves the Done tab");
	popup.handleInput("e");
	popup.handleInput("\x1b[Z"); // shift+tab back to In progress
	popup.handleInput(ENTER);
	popup.handleInput("q");
	assert.deepEqual(events, ["copy 1", "status 1 open", "edit", "work 3", "close"]);

	// A done wish opened from outside shows with the "All" tab.
	setWishStatus(file, 1, "done");
	assert.match(make(1).render(100).join("\n"), /FreeCAD/);

	// The mouse: a click on a tab and on a row of the list.
	events.length = 0;
	const clicked = make();
	clicked.render(100);
	const click = (x: number, y: number, clickCount = 1) => clicked.handleMouse({ type: "click", button: "left", x, y, clickCount } as any);
	click(3 + "Active 2   Open 1    In progress 1    Done 1 ".length, 1); // "All"
	assert.match(clicked.render(100).join("\n"), /✓ #1 Readable MCP/);
	click(4, 3); // first row of All: the one in progress
	assert.match(clicked.render(100).join("\n"), /A popup with list and preview/);
	click(4, 4 + BOX_ROWS, 2); // the second box
	assert.deepEqual(events, ["work 1"], "a double click works on the wish");

	// Narrow: the list, enter opens the wish, esc goes back, esc again closes.
	events.length = 0;
	const narrow = make(3);
	assert.doesNotMatch(narrow.render(50).join("\n"), /in progress · #3/);
	narrow.handleInput(ENTER);
	assert.match(narrow.render(50).join("\n"), /in progress · #3/);
	narrow.handleInput(ESC);
	assert.doesNotMatch(narrow.render(50).join("\n"), /in progress · #3/);
	narrow.handleInput(ESC);
	assert.deepEqual(events, ["close"]);
});

test("the wish popup opens like /usage: the frame unfolds, then the title is typed and the rows appear", async () => {
	const { WishBrowser } = await import("../extensions/pi-bridge/wish-popup.ts");
	const { visibleWidth } = await import("@earendil-works/pi-tui");
	const { addWish, readWishes } = await import("../extensions/pi-bridge/wishes.ts");
	const { OPENING_MS, UNFOLD_MS } = await import("../extensions/shared/opening.ts");
	const file = join(work, "opening", "wishes.md");
	addWish(file, { title: "Animated popup", short: "Animated", description: "It unfolds." });
	const popup = new WishBrowser({
		theme: { ...theme, bg: (_c: string, t: string) => t, inverse: (t: string) => t },
		load: () => readWishes(file),
		markdown: (text) => text.split("\n"),
		rows: () => 20,
		requestRender() {},
		setStatus() {},
		work() {},
		edit() {},
		copy() {},
		close() {},
	});
	assert.equal(popup.height(), 20);
	const folded = popup.renderUnfolding(30, 4);
	assert.equal(folded.length, 4, "as high as the frame has unfolded");
	assert.ok(folded.every((line) => visibleWidth(line) === 30));
	assert.doesNotMatch(folded.join("\n"), /Wishes|Animated/, "an empty frame");

	const start = popup.render(100, UNFOLD_MS).join("\n");
	assert.doesNotMatch(start, /Wishes|Animated/, "no title and no rows yet");
	const opened = popup.render(100, OPENING_MS - 1);
	assert.match(opened.join("\n"), /Animated/, "the rows have appeared");
	assert.equal(opened.length, 20);
	assert.ok(opened.every((line) => visibleWidth(line) === 100), "every line as wide as the popup while it opens");
	assert.match(popup.render(100).join("\n"), /╭─ Wishes /, "the plain title once open");
});
