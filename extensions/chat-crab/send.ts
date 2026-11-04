/**
 * Send fold (part of chat-crab)
 *
 * When a message is sent while the crab is shown, its first line folds into an
 * envelope in the editor: the characters slide together under the spot where
 * the crab's envelope takes off, fade, and become the envelope ([✉]); then the crab's catch goes
 * on above the editor (see crab.ts). The message goes out at once; the fold only
 * plays in the editor that is empty again, so sending is never delayed.
 *
 * pi has no hook for submitting, so this replaces the editor with pi's own
 * CustomEditor that wraps the submit handler pi hands it. Another extension that
 * replaces the editor takes over from it.
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { ENVELOPE, FOLD_MS } from "./crab.ts";

const FRAME_MS = 30;
/** The end of the fold shows the finished envelope before it takes off. */
const SEALED_MS = 120;
const RESET = "\x1b[0m";

type Keybindings = ConstructorParameters<typeof CustomEditor>[2];

const gray = (v: number) => `\x1b[38;2;${v};${v};${v}m`;
const segmenter = new Intl.Segmenter();

/**
 * The editor row `time` ms into the fold: the characters of `text`, starting at
 * column `from`, slide together at column `target` and fade, then the envelope.
 */
export function foldLine(text: string, time: number, width: number, from: number, target: number): string {
	const cells: string[] = Array(width).fill(" ");
	// The envelope's middle sits at `at`, so it keeps a cell on either side.
	const at = Math.max(1, Math.min(width - 2, target));
	const gather = FOLD_MS - SEALED_MS;
	if (time >= gather) {
		[...ENVELOPE].forEach((char, i) => {
			cells[at - 1 + i] = char;
		});
		return cells.join("");
	}
	const t = time / gather;
	const pull = t * t;
	const color = gray(Math.round(220 - 120 * t));
	const chars = [...segmenter.segment(text.split("\n")[0]!)].map(({ segment }) => (visibleWidth(segment) === 1 ? segment : "·"));
	chars.slice(0, Math.max(0, width - from)).forEach((char, i) => {
		const col = from + i;
		const pos = Math.round(col + (at - col) * pull);
		if (char !== " ") cells[pos] = `${color}${char}${RESET}`;
	});
	return cells.join("");
}

export class FoldEditor extends CustomEditor {
	private fold?: { text: string; start: number; target: number };
	private timer?: ReturnType<typeof setInterval>;

	/** `onSend` starts the crab's catch and gives the column to fold up at, or nothing while the crab is away. */
	constructor(tui: TUI, theme: EditorTheme, keybindings: Keybindings, onSend: () => number | undefined) {
		// pi's own editor shows the working status in its top border.
		super(tui, theme, keybindings, { embedWorkingStatus: true });
		// Editor declares onSubmit as a class field, so it is wrapped per instance;
		// pi assigns its handler right after the factory returns.
		let submit: ((text: string) => void) | undefined;
		Object.defineProperty(this, "onSubmit", {
			configurable: true,
			get: () =>
				submit &&
				((text: string) => {
					// Commands and shell lines are no messages to the agent.
					const target = text.trim() && !/^[/!]/.test(text.trim()) ? onSend() : undefined;
					if (target !== undefined) this.start(text, target);
					submit!(text);
				}),
			set: (handler) => {
				submit = handler;
			},
		});
	}

	private start(text: string, target: number): void {
		clearInterval(this.timer);
		this.fold = { text, start: Date.now(), target };
		this.timer = setInterval(() => {
			if (this.fold && Date.now() - this.fold.start >= FOLD_MS) {
				clearInterval(this.timer);
				this.fold = undefined;
			}
			this.tui.requestRender();
		}, FRAME_MS);
	}

	render(width: number): string[] {
		const lines = super.render(width);
		// Only while the editor is empty: text typed meanwhile wins over the fold.
		if (!this.fold || lines.length < 3 || this.getText()) return lines;
		lines[1] = foldLine(this.fold.text, Date.now() - this.fold.start, width, this.getPaddingX(), this.fold.target);
		return lines;
	}
}
