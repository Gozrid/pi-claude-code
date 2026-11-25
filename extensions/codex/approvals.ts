import { execFile } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Fields } from "./client.ts";

const exec = promisify(execFile);
const ref = "[A-Za-z0-9_][A-Za-z0-9_./-]*";
const localSwitch = new RegExp("^git +switch +(?:" + ref + "|-c +" + ref + "(?: +" + ref + ")?)$");
const shellWrapper = /^\/(?:bin|usr\/bin)\/(?:bash|zsh|sh) -l?c '([^']+)'$/;
const externalGitConfig =
	/^(?:core\.(?:hookspath|fsmonitor|worktree)$|filter\.|include(?:if)?\.|submodule\.recurse$|extensions\.partialclone$|remote\..*\.promisor$)/i;

async function hasHooks(gitDir: string): Promise<boolean> {
	try {
		const path = join(gitDir, "hooks");
		if (!(await lstat(path)).isDirectory()) return true;
		const hooks = await readdir(path);
		return hooks.some((name) => !name.endsWith(".sample"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/** Approve only a single, local checkout in the trusted project root. */
export async function canAutoApprove(ctx: ExtensionContext, p: Fields, signal: AbortSignal): Promise<boolean> {
	if (
		signal.aborted ||
		(p.kind != null && p.kind !== "command") ||
		p.approvalId != null ||
		(p.environmentId != null && p.environmentId !== "local") ||
		p.additionalPermissions != null ||
		p.networkApprovalContext != null ||
		p.proposedNetworkPolicyAmendments != null ||
		p.cwd !== ctx.cwd ||
		typeof p.command !== "string" ||
		/[^\x20-\x7e]/.test(p.command)
	) return false;

	const command = shellWrapper.exec(p.command)?.[1] ?? p.command;
	if (!localSwitch.test(command) || !ctx.isProjectTrusted()) return false;
	if (Object.keys(process.env).some((name) => /^GIT_(?:DIR$|WORK_TREE$|COMMON_DIR$|INDEX_FILE$|CONFIG)/.test(name))) return false;

	try {
		const gitDir = join(ctx.cwd, ".git");
		if (!(await lstat(gitDir)).isDirectory()) return false;
		const options = { cwd: ctx.cwd, signal, timeout: 1500 };
		const [hooks, root, location, config] = await Promise.all([
			hasHooks(gitDir),
			realpath(ctx.cwd),
			exec("git", ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"], options),
			exec("git", ["config", "--includes", "--null", "--list", "--name-only"], options),
		]);
		const [top, actualGitDir, commonDir] = location.stdout.trimEnd().split("\n");
		return (
			!signal.aborted &&
			!hooks &&
			top === root &&
			actualGitDir === join(root, ".git") &&
			commonDir === ".git" &&
			!config.stdout.split("\0").some((key) => externalGitConfig.test(key))
		);
	} catch {
		return false;
	}
}
