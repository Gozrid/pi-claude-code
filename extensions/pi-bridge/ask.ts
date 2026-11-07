/**
 * The question dialog: one or more questions in one dialog, each with options
 * (single or multiple choice, one may be recommended, each may have a
 * description), an own answer typed right in the list, and an extra input
 * field when the agent asks for one (for the whole question or for an option).
 *
 *   Question 1/2 · Database
 *   Which database should the app use?
 *
 *   › ● Postgres  recommended
 *         Reliable, runs in Docker
 *     ○ SQLite
 *     ✎ Own answer: _
 *
 *   ↑↓ choose · enter confirm · ←/→ question · esc cancel
 *
 * The mouse (pi's fullscreen mode): a click on an option chooses it (toggles it
 * when several may be chosen), on the own answer or the extra field puts the
 * cursor there, on a question tab switches to it; the wheel moves the cursor.
 */

import {
	Input,
	Key,
	matchesKey,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export interface AskOption {
	label: string;
	description?: string;
	recommended?: boolean;
	/** When set, choosing the option opens an input field with this prompt. */
	input?: string;
}

export interface AskQuestion {
	question: string;
	/** Short label, e.g. "Database". */
	header?: string;
	options?: AskOption[];
	multiSelect?: boolean;
	/** When set, an input field with this prompt follows the choice. */
	details?: string;
	/** Lines shown under the question, e.g. a command or a diff (`+`/`-` lines coloured). */
	preview?: string;
}

export interface AskAnswer {
	question: string;
	/** Labels of the chosen options. */
	selected: string[];
	/** The answer the user typed instead of or besides the options. */
	own?: string;
	/** Text of the extra input field and its prompt. */
	extra?: { prompt: string; text: string };
}

/** The JSON Schema of `questions`, for the tool definitions. */
export const QUESTIONS_SCHEMA = {
	type: "array",
	minItems: 1,
	description: "The questions, shown together in one dialog.",
	items: {
		type: "object",
		required: ["question"],
		properties: {
			question: { type: "string", description: "The full question." },
			header: { type: "string", description: "Short label of the question (one to three words)." },
			options: {
				type: "array",
				description: "Answers to choose from. The user can always type an own answer as well.",
				items: {
					type: "object",
					required: ["label"],
					properties: {
						label: { type: "string" },
						description: { type: "string", description: "What the option means or implies." },
						recommended: { type: "boolean", description: "Mark the option you recommend (at most one)." },
						input: { type: "string", description: "Ask for more text when this option is chosen; the prompt of that field." },
					},
				},
			},
			multiSelect: { type: "boolean", description: "Several options may be chosen." },
			details: { type: "string", description: "Ask for more text after the choice; the prompt of that field." },
			preview: { type: "string", description: "Text shown under the question, e.g. code or a diff (lines starting with + or - are coloured)." },
		},
	},
} as const;

/** The answers as text for the agent. */
export function formatAnswers(answers: AskAnswer[] | undefined): string {
	if (!answers) return "The user closed the dialog without answering.";
	return answers
		.map((answer, i) => {
			const parts = [`${i + 1}. ${answer.question}`];
			if (answer.selected.length > 0) parts.push(`   Chosen: ${answer.selected.join("; ")}`);
			if (answer.own) parts.push(`   Own answer: ${answer.own}`);
			if (answer.extra) parts.push(`   ${answer.extra.prompt}: ${answer.extra.text}`);
			if (answer.selected.length === 0 && !answer.own) parts.push("   (no answer)");
			return parts.join("\n");
		})
		.join("\n");
}

interface Theme {
	fg(color: any, text: string): string;
	bold(text: string): string;
}

type Focus = "list" | "own" | "extra";

/** What a rendered row is, for the mouse. `column` is where an input field starts. */
type RowTarget =
	| { kind: "option"; index: number }
	| { kind: "own"; column: number }
	| { kind: "extra"; column: number }
	| { kind: "tabs"; spans: { from: number; to: number; index: number }[] };

interface QuestionState {
	cursor: number;
	selected: Set<number>;
	own: Input;
	extra: Input;
	answered: boolean;
}

const INDENT = "  ";

export class AskDialog {
	private index = 0;
	private focus: Focus = "list";
	private readonly states: QuestionState[];
	private readonly title: string | undefined;
	private readonly questions: AskQuestion[];
	private readonly theme: Theme;
	private readonly requestRender: () => void;
	private readonly done: (answers: AskAnswer[] | undefined) => void;
	/** What each row drawn last stands for, for the mouse. */
	private targets: (RowTarget | undefined)[] = [];

	constructor(
		title: string | undefined,
		questions: AskQuestion[],
		theme: Theme,
		requestRender: () => void,
		done: (answers: AskAnswer[] | undefined) => void,
	) {
		this.title = title;
		this.questions = questions;
		this.theme = theme;
		this.requestRender = requestRender;
		this.done = done;
		this.states = questions.map((q) => {
			const own = new Input();
			const extra = new Input();
			const recommended = (q.options ?? []).findIndex((o) => o.recommended);
			return { cursor: Math.max(0, recommended), selected: new Set<number>(), own, extra, answered: false };
		});
		for (const state of this.states) {
			state.own.onSubmit = () => this.submitOwn();
			state.extra.onSubmit = () => this.next();
		}
		this.syncFocus();
	}

	private get question(): AskQuestion {
		return this.questions[this.index];
	}

	private get state(): QuestionState {
		return this.states[this.index];
	}

	private get options(): AskOption[] {
		return this.question.options ?? [];
	}

	/** The own-answer row comes after the options. */
	private get ownRow(): number {
		return this.options.length;
	}

	/** Prompt of the extra field for the current choice, if any. */
	private extraPrompt(index = this.index): string | undefined {
		const question = this.questions[index];
		const state = this.states[index];
		const chosen = [...state.selected].map((i) => question.options?.[i]).find((o) => o?.input);
		return chosen?.input ?? question.details;
	}

	private syncFocus(): void {
		this.states.forEach((state, i) => {
			state.own.focused = i === this.index && (this.focus === "own" || (this.focus === "list" && state.cursor === this.ownRow));
			state.extra.focused = i === this.index && this.focus === "extra";
		});
	}

	private refresh(): void {
		this.syncFocus();
		this.requestRender();
	}

	private move(delta: number): void {
		const rows = this.options.length + 1;
		this.state.cursor = (this.state.cursor + delta + rows) % rows;
		this.focus = this.state.cursor === this.ownRow ? "own" : "list";
		this.refresh();
	}

	private goTo(index: number): void {
		this.index = Math.min(this.questions.length - 1, Math.max(0, index));
		this.focus = this.state.cursor === this.ownRow ? "own" : "list";
		this.refresh();
	}

	private choose(option: number): void {
		const state = this.state;
		if (this.question.multiSelect) {
			if (state.selected.has(option)) state.selected.delete(option);
			else state.selected.add(option);
			this.refresh();
			return;
		}
		state.selected = new Set([option]);
		this.afterChoice();
	}

	private submitOwn(): void {
		if (!this.state.own.getValue().trim() && this.state.selected.size === 0) return;
		this.afterChoice();
	}

	/** After a choice: the extra field when one is asked for, else the next question. */
	private afterChoice(): void {
		if (this.extraPrompt() && this.focus !== "extra") {
			this.focus = "extra";
			this.refresh();
			return;
		}
		this.next();
	}

	private next(): void {
		this.state.answered = true;
		const open = this.states.findIndex((s, i) => i > this.index && !s.answered);
		const anyOpen = open >= 0 ? open : this.states.findIndex((s) => !s.answered);
		if (anyOpen < 0) {
			this.done(this.answers());
			return;
		}
		this.goTo(anyOpen);
	}

	answers(): AskAnswer[] {
		return this.questions.map((question, i) => {
			const state = this.states[i];
			const own = state.own.getValue().trim();
			const extraText = state.extra.getValue().trim();
			const prompt = this.extraPrompt(i);
			return {
				question: question.question,
				selected: [...state.selected].sort((a, b) => a - b).map((o) => question.options![o].label),
				...(own ? { own } : {}),
				...(prompt && extraText ? { extra: { prompt, text: extraText } } : {}),
			};
		});
	}

	handleInput(data: string): void {
		const state = this.state;
		if (this.focus === "extra") {
			if (matchesKey(data, Key.escape)) {
				this.focus = state.cursor === this.ownRow ? "own" : "list";
				this.refresh();
			} else {
				state.extra.handleInput(data);
				this.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.up)) return this.move(-1);
		if (matchesKey(data, Key.down)) return this.move(1);
		if (matchesKey(data, Key.tab)) return this.goTo((this.index + 1) % this.questions.length);
		if (matchesKey(data, Key.shift("tab"))) return this.goTo((this.index - 1 + this.questions.length) % this.questions.length);
		if (matchesKey(data, Key.escape)) return this.done(undefined);

		if (this.focus === "own") {
			// Typing goes to the own answer; enter submits it (see submitOwn).
			state.own.handleInput(data);
			this.requestRender();
			return;
		}
		if (matchesKey(data, Key.left)) return this.goTo(this.index - 1);
		if (matchesKey(data, Key.right)) return this.goTo(this.index + 1);
		if (data === " " && this.question.multiSelect) return this.choose(state.cursor);
		if (/^[1-9]$/.test(data) && Number(data) <= this.options.length) {
			state.cursor = Number(data) - 1;
			return this.choose(state.cursor);
		}
		if (matchesKey(data, Key.enter)) {
			if (this.question.multiSelect) {
				if (state.selected.size === 0) state.selected.add(state.cursor);
				return this.afterChoice();
			}
			return this.choose(state.cursor);
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel" && event.wheelDelta) {
			if (this.focus !== "extra") this.move(event.wheelDelta < 0 ? -1 : 1);
			return { handled: true };
		}
		if (event.type !== "press" && event.type !== "release" && event.type !== "click") return undefined;
		const consumed: TuiMouseEventResult = { handled: true, render: false };
		const target = this.targets[event.y];
		if (event.button !== "left" || !target) return consumed;
		const state = this.state;
		switch (target.kind) {
			case "tabs": {
				if (event.type !== "click") return consumed;
				const tab = target.spans.find((span) => event.x >= span.from && event.x < span.to);
				if (tab && tab.index !== this.index) this.goTo(tab.index);
				return { handled: true };
			}
			case "option":
				if (event.type !== "click") return consumed;
				state.cursor = target.index;
				this.focus = "list";
				this.choose(target.index);
				this.refresh();
				return { handled: true };
			case "own":
			case "extra": {
				if (event.type !== "press") return consumed;
				if (target.kind === "own") {
					state.cursor = this.ownRow;
					this.focus = "own";
				} else this.focus = "extra";
				const input = target.kind === "own" ? state.own : state.extra;
				input.handleMouse?.({ ...event, x: event.x - target.column, y: 0 });
				this.refresh();
				return { handled: true };
			}
		}
	}

	render(width: number): string[] {
		const { theme } = this;
		const targets: (RowTarget | undefined)[] = [];
		const question = this.question;
		const state = this.state;
		const inner = Math.max(10, width - INDENT.length * 2);
		const lines: string[] = [theme.fg("accent", "─".repeat(width))];
		if (this.title) lines.push(`${INDENT}${theme.fg("muted", this.title)}`);

		if (this.questions.length > 1) {
			const spans: { from: number; to: number; index: number }[] = [];
			let column = INDENT.length;
			const tabs = this.questions
				.map((q, i) => {
					const label = q.header ?? `Question ${i + 1}`;
					const mark = this.states[i].answered ? "✓ " : "";
					const text = i === this.index ? `[${mark}${label}]` : ` ${mark}${label} `;
					spans.push({ from: column, to: column + visibleWidth(text), index: i });
					column += visibleWidth(text) + 1;
					return i === this.index ? theme.bold(theme.fg("accent", text)) : theme.fg("dim", text);
				})
				.join(" ");
			targets[lines.length] = { kind: "tabs", spans };
			lines.push(`${INDENT}${tabs}`);
		} else if (question.header) {
			lines.push(`${INDENT}${theme.fg("accent", question.header)}`);
		}
		for (const line of wrapTextWithAnsi(theme.bold(question.question), inner)) lines.push(`${INDENT}${line}`);
		if (question.preview) {
			lines.push("");
			for (const raw of question.preview.split("\n")) {
				const color = raw.startsWith("+ ") ? "success" : raw.startsWith("- ") ? "error" : "muted";
				lines.push(`${INDENT}  ${theme.fg(color, raw)}`);
			}
		}
		lines.push("");

		this.options.forEach((option, i) => {
			const here = state.cursor === i && this.focus === "list";
			const chosen = state.selected.has(i);
			const box = question.multiSelect ? (chosen ? "■" : "□") : chosen ? "●" : "○";
			const pointer = here ? theme.fg("accent", "›") : " ";
			const label = here ? theme.bold(theme.fg("accent", option.label)) : option.label;
			const tag = option.recommended ? theme.fg("success", "  recommended") : "";
			targets[lines.length] = { kind: "option", index: i };
			lines.push(`${INDENT}${pointer} ${theme.fg(chosen ? "accent" : "dim", box)} ${theme.fg("dim", `${i + 1}.`)} ${label}${tag}`);
			if (option.description) {
				for (const line of wrapTextWithAnsi(option.description, inner - 7)) {
					targets[lines.length] = { kind: "option", index: i };
					lines.push(`${INDENT}       ${theme.fg("muted", line)}`);
				}
			}
		});
		const onOwn = state.cursor === this.ownRow && this.focus !== "extra";
		const ownLabel = this.options.length > 0 ? "Own answer:" : "Answer:";
		const ownField = state.own.render(Math.max(10, inner - ownLabel.length - 6))[0] ?? "";
		targets[lines.length] = { kind: "own", column: INDENT.length + 5 + ownLabel.length };
		lines.push(
			`${INDENT}${onOwn ? theme.fg("accent", "›") : " "} ${theme.fg(onOwn ? "accent" : "dim", "✎")} ${onOwn ? theme.bold(ownLabel) : theme.fg("muted", ownLabel)} ${ownField}`,
		);

		const prompt = this.extraPrompt();
		if (prompt && (this.focus === "extra" || state.extra.getValue())) {
			lines.push("");
			lines.push(`${INDENT}${theme.fg(this.focus === "extra" ? "accent" : "muted", prompt)}`);
			targets[lines.length] = { kind: "extra", column: INDENT.length };
			lines.push(`${INDENT}${state.extra.render(inner)[0] ?? ""}`);
		}

		lines.push("");
		const keys =
			this.focus === "extra"
				? "type · enter confirm · esc back"
				: this.focus === "own"
					? "type · enter confirm · ↑↓ choose · esc cancel"
					: [
							"↑↓/click choose",
							question.multiSelect ? "space toggle" : undefined,
							"enter confirm",
							this.questions.length > 1 ? "tab/←→ question" : undefined,
							"esc cancel",
						]
							.filter(Boolean)
							.join(" · ");
		lines.push(`${INDENT}${theme.fg("dim", keys)}`);
		lines.push(theme.fg("accent", "─".repeat(width)));
		this.targets = targets;
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {}
}

interface AskUI {
	custom<T>(factory: (tui: { requestRender(): void }, theme: any, keybindings: any, done: (result: T) => void) => any): Promise<T>;
}

/** Shows the dialog; resolves to the answers, or undefined when the user cancelled. */
export function ask(ui: AskUI, questions: AskQuestion[], title?: string): Promise<AskAnswer[] | undefined> {
	return ui.custom<AskAnswer[] | undefined>(
		(tui, theme, _keybindings, done) => new AskDialog(title, questions, theme, () => tui.requestRender(), done),
	);
}
