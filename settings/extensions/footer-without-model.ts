/**
 * Replaces the built-in footer with one that omits the right-hand
 * "(provider) model • thinking level" part and the token/cost/context line.
 * It also drops the cwd; the git branch, session name and extension statuses stay.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					// No cwd: only the git branch and session name, when there are any.
					const branch = footerData.getGitBranch();
					const info = [branch && `(${branch})`, ctx.sessionManager.getSessionName()].filter(Boolean).join(" • ");

					const lines = info ? [truncateToWidth(theme.fg("dim", info), width, theme.fg("dim", "..."))] : [];

					const statuses = footerData.getExtensionStatuses();
					if (statuses.size > 0) {
						const line = Array.from(statuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, t]) => t.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
							.join(" ");
						lines.push(truncateToWidth(line, width, theme.fg("dim", "...")));
					}

					return lines;
				},
			};
		});
	});
}
