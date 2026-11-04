/**
 * pi's MCP servers for the CLI providers: read like pi reads them, in the shape
 * both CLIs take; and agy's mirror of the gemini folder.
 */

import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const work = realpathSync(mkdtempSync(join(tmpdir(), "pi-mcp-test-")));
process.env.PI_MCP_DIR = join(work, "private");

const { hiddenMcpTools, piMcpServers, privateFile, viaProxy } = await import("../extensions/shared/pi-mcp.ts");
const { geminiMirror } = await import("../extensions/antigravity/mcp.ts");

const agentDir = join(work, "agent");
const project = join(work, "project");
mkdirSync(agentDir, { recursive: true });
mkdirSync(join(project, ".pi"), { recursive: true });
const write = (file: string, servers: unknown) => writeFileSync(file, JSON.stringify({ mcpServers: servers }));

write(join(agentDir, "mcp.json"), {
	fs: { command: "npx", args: ["-y", "server-fs", "~/notes"], env: { TOKEN: "${PI_MCP_TEST_TOKEN}", PLAIN: "x" } },
	docs: { url: "https://example.com/mcp", headers: { Authorization: "!echo Bearer abc" } },
	off: { command: "off", enabled: false },
	hidden: { command: "hidden", exposure: "hidden" },
	someHidden: { command: "some", exposure: "hidden", toolExposure: { "*cloud*": "hidden" } },
	fewShown: { command: "few", exposure: "hidden", toolExposure: { search: "direct", "*": "hidden" } },
	tools: { command: "tools", cwd: "sub" },
	internal: { command: "internal" },
});
write(join(project, ".pi", "mcp.json"), {
	internal: { enabled: false },
	docs: { url: "https://project.example/mcp" },
	local: { command: "./bin/local" },
});

const read = (projectTrusted: boolean) =>
	piMcpServers({ agentDir, cwd: project, projectTrusted, home: "/home/me", env: { ...process.env, PI_MCP_TEST_TOKEN: "t0k" } });

test("global servers: env and headers resolved, ~ expanded, disabled and hidden left out (unless toolExposure shows some tools)", () => {
	const { servers, errors } = read(false);
	assert.deepEqual(errors, []);
	assert.deepEqual(Object.keys(servers).sort(), ["docs", "fewShown", "fs", "internal", "tools"]);
	assert.deepEqual(servers.fs, { command: "npx", args: ["-y", "server-fs", "/home/me/notes"], env: { TOKEN: "t0k", PLAIN: "x" } });
	assert.deepEqual(servers.docs, { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer abc" } });
});

test("a server's cwd becomes a shell that changes there first", () => {
	assert.deepEqual(read(false).servers.tools, { command: "/bin/sh", args: ["-c", 'cd "$0" && exec "$@"', join(project, "sub"), "tools"] });
});

test("in a trusted project its mcp.json replaces, overrides and adds servers", () => {
	const { servers } = read(true);
	assert.deepEqual(Object.keys(servers).sort(), ["docs", "fewShown", "fs", "local", "tools"]);
	assert.deepEqual(servers.docs, { type: "http", url: "https://project.example/mcp" });
});

test("without any mcp.json there are no servers", () => {
	assert.deepEqual(piMcpServers({ agentDir: join(work, "none"), cwd: work, projectTrusted: true }), { servers: {}, errors: [] });
});

test("through pi-bridge every server is pi's connection at its own URL", () => {
	const servers = read(false).servers;
	const proxied = viaProxy(servers, { url: (name) => `http://127.0.0.1:1/mcp/${name}`, headers: { Authorization: "Bearer x" } });
	assert.deepEqual(Object.keys(proxied), Object.keys(servers));
	assert.deepEqual(proxied.fs, { type: "http", url: "http://127.0.0.1:1/mcp/fs", headers: { Authorization: "Bearer x" } });
	assert.equal(viaProxy(servers, undefined), servers);
});

test("the tools pi hides, named by server and tool for a CLI that starts the servers itself", () => {
	const mcp = { path: "builtin:mcp" };
	const tools = [
		{ name: "mcp__maestro__run_on_cloud", exposure: "hidden", sourceInfo: mcp },
		{ name: "mcp__maestro__tap_on", exposure: "deferred", sourceInfo: mcp },
		{ name: "mcp__dev_radius__secret", exposure: "hidden", sourceInfo: mcp },
		{ name: "mcp__other__x", exposure: "hidden", sourceInfo: mcp },
		{ name: "mcp__maestro__mine", exposure: "hidden", sourceInfo: { path: "/some/extension.ts" } },
	];
	assert.deepEqual(hiddenMcpTools(tools, ["maestro", "dev-radius"]), [
		{ server: "maestro", tool: "run_on_cloud" },
		{ server: "dev-radius", tool: "secret" },
	]);
});

test("files with credentials are readable by the user only", () => {
	const file = privateFile("test", "{}");
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.equal(statSync(join(work, "private")).mode & 0o777, 0o700);
});

test("agy's mirror links the gemini folder and lists only pi's servers", () => {
	const gemini = join(work, "gemini");
	mkdirSync(join(gemini, "antigravity-cli"), { recursive: true });
	mkdirSync(join(gemini, "config", "projects"), { recursive: true });
	writeFileSync(join(gemini, "config", "mcp_config.json"), '{"mcpServers":{"own":{"command":"own"}}}');
	const config = '{"mcpServers":{"pi":{"command":"pi"}}}\n';
	const mirror = geminiMirror(config, gemini);
	assert.equal(readlinkSync(join(mirror, "antigravity-cli")), join(gemini, "antigravity-cli"));
	assert.equal(readlinkSync(join(mirror, "config", "projects")), join(gemini, "config", "projects"));
	assert.ok(!lstatSync(join(mirror, "config", "mcp_config.json")).isSymbolicLink());
	assert.equal(readFileSync(join(mirror, "config", "mcp_config.json"), "utf8"), config);
	// Entries added to the gemini folder later are linked on the next run.
	mkdirSync(join(gemini, "later"));
	assert.equal(geminiMirror(config, gemini), mirror);
	assert.equal(readlinkSync(join(mirror, "later")), join(gemini, "later"));
});
