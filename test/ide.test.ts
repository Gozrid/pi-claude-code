import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { IdeConnection } from "../extensions/ide/connection.ts";
import { hintsFor, IDE_KINDS, integrationInstalled, parseProcesses, runningIdes } from "../extensions/ide/detect.ts";
import { type IdeLock, parseLock, pickLock, readLocks } from "../extensions/ide/lockfiles.ts";
import {
	contextFor,
	insertion,
	locationLabel,
	MAX_ATTACHED_CHARS,
	mentionFromParams,
	referenceFor,
	selectionFromParams,
} from "../extensions/ide/reference.ts";

const CWD = "/work/TRIP/AppFrontend";

test("a selection counts lines from 1 and leaves out a last line it does not reach into", () => {
	const sel = selectionFromParams({
		filePath: `${CWD}/src/foo.ts`,
		text: "a\nb\n",
		selection: { start: { line: 11, character: 0 }, end: { line: 13, character: 0 } },
	});
	assert.deepEqual(sel, { filePath: `${CWD}/src/foo.ts`, lineStart: 12, lineEnd: 13, text: "a\nb\n" });
	assert.equal(referenceFor(sel!, CWD), "@src/foo.ts#L12-13");
	assert.equal(locationLabel(sel!, CWD), "src/foo.ts:12-13");
});

test("an empty selection is just the open file", () => {
	const sel = selectionFromParams({
		filePath: `${CWD}/src/foo.ts`,
		text: "",
		selection: { start: { line: 4, character: 2 }, end: { line: 4, character: 2 } },
	});
	assert.deepEqual(sel, { filePath: `${CWD}/src/foo.ts` });
	assert.equal(referenceFor(sel!, CWD), "@src/foo.ts");
	assert.match(contextFor(sel!, CWD, "IntelliJ IDEA"), /has src\/foo\.ts open in IntelliJ IDEA/);
});

test("files outside the project keep their absolute path; one line is L12", () => {
	const sel = mentionFromParams({ filePath: "/elsewhere/x.kt", lineStart: 11, lineEnd: 11 });
	assert.equal(referenceFor(sel!, CWD), "@/elsewhere/x.kt#L12");
});

test("the inserted reference gets the spaces it needs", () => {
	assert.equal(insertion("@a.ts", ""), "@a.ts ");
	assert.equal(insertion("@a.ts", "look at"), " @a.ts ");
	assert.equal(insertion("@a.ts", "look at "), "@a.ts ");
});

test("the context carries the selected text, or only where it is when too long", () => {
	const sel = { filePath: `${CWD}/a.ts`, lineStart: 3, lineEnd: 4, text: "x = 1\ny = 2" };
	assert.match(contextFor(sel, CWD, "WebStorm"), /lines 3 to 4 of a\.ts in WebStorm:\nx = 1\ny = 2/);
	const long = { ...sel, text: "x".repeat(MAX_ATTACHED_CHARS + 1) };
	assert.doesNotMatch(contextFor(long, CWD, "WebStorm"), /xxxx/);
});

test("lock files: the IDE whose project holds pi's folder wins, the deepest first", () => {
	const lock = (port: number, folders: string[]): IdeLock => ({ port, ideName: `ide${port}`, workspaceFolders: folders, transport: "ws" });
	const locks = [lock(1, ["/work/other"]), lock(2, ["/work/TRIP"]), lock(3, ["/work/TRIP/AppFrontend"])];
	assert.equal(pickLock(locks, CWD)?.port, 3);
	assert.equal(pickLock(locks.slice(0, 2), CWD)?.port, 2);
	assert.equal(pickLock([lock(4, ["/work/TRIP/AppFrontend/sub"])], CWD)?.port, 4);
	assert.equal(pickLock([locks[0]], CWD), undefined);
	// Started in the IDE's terminal: that IDE, if it fits at all.
	assert.equal(pickLock(locks, CWD, "2")?.port, 2);
	assert.equal(pickLock(locks, CWD, "1")?.port, 3);
});

test("lock files are read from the folders given, broken and dead ones left out", () => {
	const dir = mkdtempSync(join(tmpdir(), "ide-locks-"));
	writeFileSync(join(dir, "4711.lock"), JSON.stringify({ pid: process.pid, workspaceFolders: [CWD], ideName: "IntelliJ IDEA", transport: "ws", authToken: "t" }));
	writeFileSync(join(dir, "4712.lock"), "{broken");
	writeFileSync(join(dir, "4713.lock"), JSON.stringify({ pid: 999_999_999, workspaceFolders: [CWD], ideName: "Gone", transport: "ws" }));
	assert.deepEqual(readLocks([dir]).map((l) => l.port), [4711]);
	assert.equal(parseLock("x.lock", "{}"), undefined);
});

test("running IDEs are the apps' main executables, not their helpers", () => {
	const ps = parseProcesses(
		[
			"  101 /Applications/IntelliJ IDEA.app/Contents/MacOS/idea",
			"  102 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper",
			"  103 /Applications/Visual Studio Code.app/Contents/MacOS/Code",
			"  104 /bin/zsh",
		].join("\n"),
	);
	assert.deepEqual(runningIdes(ps).map((r) => [r.kind.name, r.pid]), [["IntelliJ IDEA", 101], ["Visual Studio Code", 103]]);
});

test("hints: missing plugin, plugin without server, none with a lock file", () => {
	const idea = IDE_KINDS.find((k) => k.name === "IntelliJ IDEA")!;
	const code = IDE_KINDS.find((k) => k.name === "Visual Studio Code")!;
	const storm = IDE_KINDS.find((k) => k.name === "WebStorm")!;
	const hints = hintsFor(
		[{ kind: idea, pid: 1 }, { kind: code, pid: 2 }, { kind: storm, pid: 3 }],
		new Set([2]),
		(kind) => kind === storm,
	);
	assert.deepEqual(hints.map((h) => h.id), ["IntelliJ IDEA:missing", "WebStorm:inactive"]);
	assert.match(hints[0].text, /Claude Code \[Beta\]/);
});

test("the JetBrains plugin counts in the newest config folder of the product", () => {
	const home = mkdtempSync(join(tmpdir(), "ide-home-"));
	const base = join(home, "Library/Application Support/JetBrains");
	mkdirSync(join(base, "IntelliJIdea2026.2/plugins/claude-code-jetbrains-plugin"), { recursive: true });
	mkdirSync(join(base, "WebStorm2026.2/plugins"), { recursive: true });
	mkdirSync(join(home, ".vscode/extensions/anthropic.claude-code-2.1.0"), { recursive: true });
	const kind = (name: string) => IDE_KINDS.find((k) => k.name === name)!;
	assert.equal(integrationInstalled(kind("IntelliJ IDEA"), home), true);
	assert.equal(integrationInstalled(kind("WebStorm"), home), false);
	assert.equal(integrationInstalled(kind("Visual Studio Code"), home), true);
	assert.equal(integrationInstalled(kind("Cursor"), home), false);
});

/** A fake IDE: answers MCP over WebSocket after checking the token, then sends a selection. */
async function fakeIde(token: string) {
	const { createHash } = await import("node:crypto");
	const received: any[] = [];
	const server = createServer();
	server.on("upgrade", (req, socket) => {
		if (req.headers["x-claude-code-ide-authorization"] !== token) {
			socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
			return;
		}
		const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
		socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: mcp\r\n\r\n`);
		const send = (message: unknown) => {
			const data = Buffer.from(JSON.stringify(message));
			const header = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
			socket.write(Buffer.concat([header, data]));
		};
		let buffer = Buffer.alloc(0);
		socket.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			while (buffer.length >= 6) {
				let length = buffer[1] & 127;
				let offset = 2;
				if (length === 126) {
					length = buffer.readUInt16BE(2);
					offset = 4;
				}
				if (buffer.length < offset + 4 + length) return;
				const mask = buffer.subarray(offset, offset + 4);
				const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length).map((b, i) => b ^ mask[i % 4]));
				const opcode = buffer[0] & 15;
				buffer = buffer.subarray(offset + 4 + length);
				if (opcode === 8) {
					socket.end();
					return;
				}
				const message = JSON.parse(payload.toString());
				received.push(message);
				if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {} } });
				if (message.method === "tools/list") send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "openFile" }] } });
				if (message.method === "tools/call") send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `opened ${message.params.arguments.filePath}` }] } });
				if (message.method === "notifications/initialized")
					send({ jsonrpc: "2.0", method: "selection_changed", params: { filePath: "/p/a.ts", text: "x", selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } });
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, received, port: (server.address() as AddressInfo).port };
}

test("the connection runs MCP's handshake, gets notifications and calls tools", async () => {
	const ide = await fakeIde("secret");
	const notifications: Array<[string, unknown]> = [];
	let closed = false;
	const conn = new IdeConnection(
		{ port: ide.port, ideName: "Fake IDE", workspaceFolders: ["/p"], authToken: "secret", transport: "ws" },
		{ notification: (method, params) => notifications.push([method, params]), closed: () => (closed = true) },
	);
	await conn.connect();
	assert.deepEqual(conn.tools, ["openFile"]);
	assert.deepEqual((await conn.callTool("openFile", { filePath: "/p/a.ts" })).text, "opened /p/a.ts");
	assert.equal(notifications[0]?.[0], "selection_changed");
	assert.deepEqual(selectionFromParams(notifications[0][1]), { filePath: "/p/a.ts", lineStart: 1, lineEnd: 1, text: "x" });
	assert.ok(ide.received.some((m) => m.method === "ide_connected"));
	conn.close();
	assert.equal(closed, true);
	ide.server.close();
});

test("a wrong token does not connect", async () => {
	const ide = await fakeIde("secret");
	const conn = new IdeConnection(
		{ port: ide.port, ideName: "Fake IDE", workspaceFolders: [], authToken: "wrong", transport: "ws" },
		{ notification() {}, closed() {} },
	);
	await assert.rejects(conn.connect(), /Could not connect/);
	ide.server.close();
});

test("file references: line, range, column, @#L form and plain paths", async () => {
	const { parseFileRef } = await import("../extensions/ide/links.ts");
	assert.deepEqual(parseFileRef("src/foo.ts:12"), { path: "src/foo.ts", line: 12, lineEnd: undefined });
	assert.deepEqual(parseFileRef("src/foo.ts:12-30"), { path: "src/foo.ts", line: 12, lineEnd: 30 });
	assert.deepEqual(parseFileRef("src/foo.ts:12:5"), { path: "src/foo.ts", line: 12, lineEnd: undefined });
	assert.deepEqual(parseFileRef("@src/foo.ts#L12-30"), { path: "src/foo.ts", line: 12, lineEnd: 30 });
	assert.deepEqual(parseFileRef("src/foo.ts"), { path: "src/foo.ts", line: undefined, lineEnd: undefined });
	assert.equal(parseFileRef("two words"), undefined);
});

test("references in Markdown become links; fences, links and unknown files stay", async () => {
	const { linkFileReferences } = await import("../extensions/ide/links.ts");
	const known = new Set(["src/foo.ts", "a.kt"]);
	const link = (ref: { path: string; line?: number }) => (known.has(ref.path) ? `x://${ref.path}/${ref.line ?? ""}` : undefined);
	const md = [
		"See `src/foo.ts:12` and src/foo.ts:3-4, also @a.kt#L7.",
		"Not `missing.ts:1`, not `npm test`, not [src/foo.ts:1](http://x) or https://h/src/foo.ts:5.",
		"```",
		"src/foo.ts:9",
		"```",
	].join("\n");
	assert.equal(
		linkFileReferences(md, link),
		[
			"See [`src/foo.ts:12`](x://src/foo.ts/12) and [src/foo.ts:3-4](x://src/foo.ts/3), also [@a.kt#L7](x://a.kt/7).",
			"Not `missing.ts:1`, not `npm test`, not [src/foo.ts:1](http://x) or https://h/src/foo.ts:5.",
			"```",
			"src/foo.ts:9",
			"```",
		].join("\n"),
	);
});

test("links go to the connected IDE's URL scheme, none for IDEs without one", async () => {
	const { openUrl } = await import("../extensions/ide/links.ts");
	assert.equal(openUrl("Visual Studio Code", "/p/a b.ts", 3), "vscode://file/p/a%20b.ts:3");
	assert.equal(openUrl("IntelliJ IDEA", "/p/a.ts", 3), "idea://open?file=%2Fp%2Fa.ts&line=3");
	assert.equal(openUrl("WebStorm", "/p/a.ts"), "webstorm://open?file=%2Fp%2Fa.ts");
	assert.equal(openUrl("Rider", "/p/a.ts", 3), undefined);
});

test("openFile's anchor is the line's text, grown until it is found there first", async () => {
	const { anchorFor } = await import("../extensions/ide/links.ts");
	const content = "a\n}\n\nb\n}\nc";
	assert.equal(anchorFor(content, 1), "a");
	assert.equal(anchorFor(content, 4), "b");
	assert.equal(anchorFor(content, 3), "b");
	assert.equal(anchorFor(content, 5), "}\nc");
	assert.equal(anchorFor("x\nx", 2), undefined);
});

test("git status: changed and new files, deleted ones and rename sources left out", async () => {
	const { parseStatus } = await import("../extensions/ide/actions.ts");
	const status = [" M src/a.ts", "?? new.ts", " D gone.ts", "R  to.ts", "from.ts", ""].join("\0");
	assert.deepEqual(parseStatus(status, "/r"), [
		{ path: "/r/src/a.ts", rel: "src/a.ts", untracked: false },
		{ path: "/r/new.ts", rel: "new.ts", untracked: true },
		{ path: "/r/to.ts", rel: "to.ts", untracked: false },
	]);
});

test("/ide open asks the IDE to open the file at the line's text", async () => {
	const { openInIde } = await import("../extensions/ide/actions.ts");
	const dir = mkdtempSync(join(tmpdir(), "ide-open-"));
	writeFileSync(join(dir, "a.ts"), "x\n}\ny\n}\nz");
	const ide = await fakeIde("t");
	const conn = new IdeConnection({ port: ide.port, ideName: "Fake", workspaceFolders: [dir], authToken: "t", transport: "ws" }, { notification() {}, closed() {} });
	await conn.connect();
	after(() => {
		conn.close();
		ide.server.close();
	});
	await openInIde(conn, { path: "a.ts", line: 4 }, dir);
	const call = ide.received.find((m) => m.method === "tools/call");
	assert.deepEqual(call.params, {
		name: "openFile",
		arguments: { filePath: join(dir, "a.ts"), preview: false, makeFrontmost: true, startText: "}\nz", selectToEndOfLine: true },
	});
	await assert.rejects(openInIde(conn, { path: "nope.ts" }, dir), /No such file/);
	conn.close();
	ide.server.close();
});
