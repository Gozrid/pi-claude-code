/**
 * The chat crab: a tiny, slim Clawd (10×6 pixels, three terminal rows) and its moods.
 * For Antigravity the same moods play with Gravi, a small hover bot: a rounded
 * body and a flickering thruster instead of feet (see Mascot).
 *
 * Kept separate from provider-logo's clawd.ts so the two can change on their
 * own; the parts (eyes, arms, feet) are the same, the body is narrower.
 *
 * Besides the crab, a frame can carry things beside it: a prop of three
 * coloured rows (a thought bubble, a book, an editor, a terminal, …) or a
 * buddy crab.
 */

type Eyes = "open" | "half" | "closed";
type Arm = "down" | "up";
type Feet = "both" | "left" | "right";

interface Pose {
	eyes?: Eyes;
	/** Eye offset in pixels: -1 looks left, 1 looks right. */
	look?: number;
	left?: Arm;
	right?: Arm;
	feet?: Feet;
	/** Body pressed down by one pixel, after a landing. */
	squash?: boolean;
	/** One pixel up, mid-hop. */
	lifted?: boolean;
}

export type Mood =
	/** Nothing going on: blinks, looks around, patters now and then. */
	| "idle"
	/** Idle for a long time. */
	| "sleep"
	/** The model is thinking: a thought bubble. */
	| "thinking"
	/** The model is writing its answer. */
	| "writing"
	/** A search or another tool runs: the crab walks to and fro with the tool's name. */
	| "walking"
	/** A file is read: the crab reads a book. */
	| "reading"
	/** A file is edited or written: the crab types its name. */
	| "typing"
	/** A shell command runs: the crab types it into a terminal. */
	| "terminal"
	/** A web fetch or search: a spinning globe with the host. */
	| "surfing"
	/** A search in files (grep, glob): a magnifier sweeps a line. */
	| "searching"
	/** A subagent runs: a small buddy crab scurries off. */
	| "delegating"
	/** The todo list changes: a checklist gets ticked. */
	| "planning"
	/** A message is sent: an envelope flies up from the editor, the crab catches it and hops. */
	| "catch"
	/** A tool failed. */
	| "ouch"
	/** Something is done: a hop with raised arms and a wave. */
	| "cheer";

/** Who acts: Clawd for Claude, Gravi for Antigravity (see ../shared/brand.ts). */
export type Mascot = "clawd" | "gravi";

/** What the crab acts out, beyond its mood. */
export interface Scene {
	/** Clawd unless set. */
	mascot?: Mascot;
	/** Where a walking crab heads. */
	direction: -1 | 1;
	/** Name of the running tool. */
	tool?: string;
	/** What the tool works on: a file name, a command, a host. */
	detail?: string;
	/** The agent has been at it for long: droopy eyes. */
	tired?: boolean;
	/** Text of a cheer, "done" by default. */
	cheer?: string;
	/** Columns free beside the crab; `SIDE_ROOM` unless the terminal is narrower. */
	room?: number;
}

/** Theme colours a prop may use; "clawd" is the crab's own orange. */
export type PropColor = "text" | "muted" | "dim" | "accent" | "success" | "error" | "warning" | "clawd";

/** A piece of a prop row in one colour (muted when unset). */
export interface Span {
	text: string;
	color?: PropColor;
}

/** One terminal row beside the crab. */
export type PropRow = Span[];

const s = (text: string, color?: PropColor): Span => ({ text, color });

/** The plain text of a prop row. */
export const rowText = (row: PropRow) => row.map((span) => span.text).join("");
const textWidth = (row: PropRow) => rowText(row).length;

export interface CrabFrame {
	/** Pixel rows: "o" body, "l" eyelid, "f"/"h" Gravi's thruster flame, "." empty. */
	art: string[];
	/** Rows beside the crab, one per terminal row: a thought bubble, a book, a terminal, … */
	prop?: PropRow[];
	/** A small crab beside this one: its pixel rows, its offset in columns and a caption above it. */
	buddy?: { art: string[]; x: number; caption?: PropRow };
}

export const WIDTH = 10;
/** Columns kept free right of the crab for what is beside it. */
export const SIDE_ROOM = 56;
/** Row 0 stays free for raised arms. */
const HEIGHT = 6;

function draw(pose: Pose, tired = false, mascot: Mascot = "clawd"): string[] {
	const grid = Array.from({ length: HEIGHT }, () => Array<string>(WIDTH).fill("."));
	const set = (row: number, col: number, char = "o") => {
		if (row >= 0 && row < HEIGHT && col >= 0 && col < WIDTH) grid[row][col] = char;
	};
	const top = pose.squash ? 2 : 1;
	const gravi = mascot === "gravi";
	for (let row = top; row <= 4; row++) {
		for (let col = 1; col <= WIDTH - 2; col++) {
			// Gravi is round: no body pixels in its corners.
			if (gravi && (row === top || row === 4) && (col === 1 || col === WIDTH - 2)) continue;
			set(row, col);
		}
	}

	const eyes = pose.eyes ?? (tired ? "half" : "open");
	for (const col of [2, WIDTH - 3].map((c) => c + (pose.look ?? 0))) {
		if (eyes === "open") set(2, col, ".");
		else if (eyes === "half") set(2, col, "l");
	}

	const arm = (side: -1 | 1, state: Arm) => set(state === "down" ? 3 : 0, side < 0 ? 0 : WIDTH - 1);
	arm(-1, pose.left ?? "down");
	arm(1, pose.right ?? "down");

	const feet = pose.feet ?? "both";
	if (gravi) {
		// The thruster's flame under the body: a hot core, a red edge; pattering feet make it flicker sideways.
		const shift = feet === "left" ? -1 : feet === "right" ? 1 : 0;
		const middle = WIDTH / 2 + shift;
		set(5, middle - 2, "f");
		set(5, middle - 1, "h");
		set(5, middle, "h");
		set(5, middle + 1, "f");
	} else {
		if (feet !== "left") [1, 3].forEach((col) => set(5, col));
		if (feet !== "right") [WIDTH - 4, WIDTH - 2].forEach((col) => set(5, col));
	}

	if (!pose.lifted) return grid.map((row) => row.join(""));
	// Mid-hop everything moves up a pixel; raised arms stay at the top corners.
	const lifted = grid.slice(1).map((row) => [...row]);
	lifted.push(Array<string>(WIDTH).fill("."));
	if (grid[0][0] === "o") lifted[0][0] = "o";
	if (grid[0][WIDTH - 1] === "o") lifted[0][WIDTH - 1] = "o";
	return lifted.map((row) => row.join(""));
}

/** The buddy: a 7×4 crab with two feet that take turns. */
function buddy(step: number, mascot: Mascot = "clawd"): string[] {
	if (mascot === "gravi") return [".ooooo.", "oo.o.oo", ".ooooo.", step % 2 ? "..fhf.." : "..hfh.."];
	return [".ooooo.", "oo.o.oo", ".ooooo.", step % 2 ? ".o...o." : "..o.o.."];
}

/** Steps of a timeline: [duration in ms, pose]. */
type Step = [number, Pose];

const total = (steps: Step[]) => steps.reduce((sum, [duration]) => sum + duration, 0);

/** The pose at `time` ms into a timeline; past its end it loops, or holds the last pose. */
function at(steps: Step[], time: number, loop = true): Pose {
	let t = loop ? time % total(steps) : time;
	for (const [duration, pose] of steps) {
		if (t < duration) return pose;
		t -= duration;
	}
	return steps[steps.length - 1][1];
}

const blink: Step[] = [
	[60, { eyes: "half" }],
	[90, { eyes: "closed" }],
	[60, { eyes: "half" }],
];

const patter = (times: number, ms: number, pose: Pose = {}): Step[] =>
	Array.from({ length: times }, (): Step[] => [
		[ms, { ...pose, feet: "left" }],
		[ms, { ...pose, feet: "right" }],
	]).flat();

const wave = (times: number): Step[] =>
	Array.from({ length: times }, (): Step[] => [
		[180, { right: "up" }],
		[180, { right: "down" }],
	]).flat();

/** Arms going up and down in turn, as on a keyboard. */
const typing = (times: number, pose: Pose = {}): Step[] =>
	Array.from({ length: times }, (): Step[] => [
		[130, { ...pose, left: "up" }],
		[130, { ...pose, right: "up" }],
	]).flat();

const IDLE: Step[] = [
	[2600, {}],
	...blink,
	[1400, {}],
	[1200, { look: -1 }],
	[1200, { look: 1 }],
	[400, {}],
	...blink,
	[2000, {}],
	...patter(3, 140),
	[1800, {}],
	...blink,
	[160, {}],
	...blink,
	[2400, {}],
];

const THINKING: Step[] = [
	[700, { look: -1, right: "up" }],
	[140, { look: -1, right: "up", eyes: "half" }],
	[700, { look: 1, right: "up" }],
	[500, { look: 1 }],
	...blink,
	[600, {}],
];

const WRITING: Step[] = [...patter(4, 120, { look: 1 }), ...blink.map(([ms, pose]): Step => [ms, { ...pose, look: 1 }])];

/** Eyes run along the lines, then jump back. */
const READING: Step[] = [
	[450, { look: -1 }],
	[450, {}],
	[450, { look: 1 }],
	[450, { look: -1 }],
	[450, {}],
	[450, { look: 1 }],
	...blink.map(([ms, pose]): Step => [ms, { ...pose, look: 1 }]),
];

const TYPING: Step[] = [...typing(6, { look: 1 }), [300, { look: 1 }]];

const SURFING: Step[] = [...patter(3, 160, { look: 1 }), [500, { look: 1, right: "up" }], ...blink];

const DELEGATING: Step[] = [...wave(2).map(([ms, pose]): Step => [ms, { ...pose, look: 1 }]), [900, { look: 1 }], ...blink];

const PLANNING: Step[] = [
	[300, { look: 1 }],
	[100, { look: 1, right: "up" }],
];

const SLEEP: Step[] = [
	[1600, { eyes: "closed" }],
	[1600, { eyes: "closed", squash: true }],
];

/** First the message folds into an envelope in the editor (see send.ts), this long. */
export const FOLD_MS = 420;
/** The envelope's flight: this long after folding, it is in the crab's raised arm. */
const FLIGHT_MS = FOLD_MS + 480;

const CATCH: Step[] = [
	[FOLD_MS, { look: 1 }],
	[360, { look: 1 }],
	[120, { look: 1, right: "up" }],
	[90, { squash: true, right: "up" }],
	[280, { lifted: true, left: "up", right: "up" }],
	[110, { squash: true }],
	[200, {}],
];
/** When the crab lands again after the hop. */
const LANDING_MS = FLIGHT_MS + 90 + 280;

const OUCH: Step[] = [
	[500, { squash: true, eyes: "closed" }],
	[300, { squash: true, eyes: "half" }],
	[300, {}],
];

const CHEER: Step[] = [
	[90, { squash: true }],
	[300, { lifted: true, left: "up", right: "up" }],
	[110, { squash: true }],
	[120, {}],
	...wave(3),
	[200, {}],
];

/** How long the one-off moods last; afterwards the caller picks the next mood. */
export const DURATION: Partial<Record<Mood, number>> = {
	catch: total(CATCH),
	ouch: total(OUCH),
	cheer: total(CHEER),
};

/** Walking: one step per this many ms. */
export const STEP_MS = 110;

/** Moods per tool name; tools not listed walk with their name. */
const TOOL_MOODS: [RegExp, Mood][] = [
	[/^(read|view|cat|notebookread)$/i, "reading"],
	[/^(edit|write|multiedit|notebookedit|apply_?patch|patch)$/i, "typing"],
	[/^(bash|shell|powershell|terminal|exec)$/i, "terminal"],
	[/^(webfetch|websearch|web_?fetch|web_?search|fetch|browse)$/i, "surfing"],
	[/^(agent|task|subagent)$/i, "delegating"],
	[/^(grep|glob|find|ls|rg|search|code_?search)$/i, "searching"],
	[/^(todowrite|todo|task(create|update|list|get)|update_?plan)$/i, "planning"],
];

export function toolMood(tool: string): Mood {
	return TOOL_MOODS.find(([pattern]) => pattern.test(tool))?.[1] ?? "walking";
}


// =============================================================================
// Props: what is beside the crab, three rows of coloured spans
// =============================================================================

const fileName = (path?: string) => path?.split(/[\\/]/).filter(Boolean).pop();

function hostOf(detail?: string): string | undefined {
	try {
		return detail ? new URL(detail).host.replace(/^www\./, "") : undefined;
	} catch {
		return detail;
	}
}

const clip = (text: string, max: number) =>
	max <= 0 ? "" : text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** Strokes that read as words on a line: a sheet being written, a line of code. */
const WORDS = "━━━ ━━ ━━━━━ ━ ━━━━ ━━━ ━━━━━━ ━━ ━━━━ ━ ━━━━━ ━━━ ";
const words = (offset: number, length: number) => {
	const from = offset % WORDS.length;
	return (WORDS.slice(from) + WORDS + WORDS).slice(0, Math.max(0, length));
};

/** A frame around one line: top and bottom border with `width` columns in total, after a leading space. */
function box(width: number, line: PropRow, top: PropRow = [s("─".repeat(width - 2), "dim")]): PropRow[] {
	const inner = width - 2;
	const used = textWidth(line);
	const pad = Math.max(0, inner - used);
	const topUsed = textWidth(top);
	return [
		[s(" ╭", "dim"), ...top, s(`${"─".repeat(Math.max(0, inner - topUsed))}╮`, "dim")],
		[s(" │", "dim"), ...line, s(" ".repeat(pad)), s("│", "dim")],
		[s(` ╰${"─".repeat(inner)}╯`, "dim")],
	];
}

/**
 * The thought bubble: its trail of circles puffs up from the crab's head, the
 * dots fill one by one, then a question comes up and turns into an idea.
 */
function thoughtBubble(time: number): PropRow[] {
	const t = time % 5200;
	const content: Span =
		t < 3000
			? s(["•    ", "• •  ", "• • •"][Math.floor(t / 500) % 3], "muted")
			: t < 3900
				? s("  ?  ", "warning")
				: s(Math.floor(t / 180) % 2 ? "  ✦  " : "  ✧  ", "accent");
	const puff = Math.floor(time / 350) % 3;
	const small = s("∘", puff === 0 ? "text" : "dim");
	const big = s("○", puff === 1 ? "text" : "dim");
	return [
		[s("  "), big, s(" ╭───────╮", "dim")],
		[s(" "), small, s("  │ ", "dim"), content, s(" │", "dim")],
		[s("    ╰───────╯", "dim")],
	];
}

/** A sheet the crab writes on: strokes appear behind the pen, a full line starts over with the next. */
function sheet(time: number, room: number): PropRow[] {
	const width = Math.max(10, Math.min(room - 1, 26));
	const inner = width - 3;
	const perLine = inner + 6;
	const step = Math.floor(time / 80);
	const line = Math.floor(step / perLine);
	const written = Math.min(inner - 1, step % perLine);
	return box(width, [s(" "), s(words(line * 7, written), "muted"), s("✎", "accent")]);
}

/**
 * An open book and the file's name: the line being read lights up as the eyes
 * move along it, then the page turns and the new one fills.
 */
function book(time: number, name: string, room: number): PropRow[] {
	const t = time % 2700;
	const lit = Math.floor(t / 300);
	let left: PropRow = [];
	let right: PropRow = [];
	if (t < 1800) {
		// Eyes left → right over both pages; the char being read is lit.
		const page = (from: number) =>
			[0, 1, 2].map((i) => s("≡", lit === from + i ? "accent" : "muted"));
		left = page(0);
		right = page(3);
	} else {
		const flip = ["≡≡╱", "≡╱ ", "╱  ", "   "][Math.min(3, Math.floor((t - 1800) / 110))];
		const after = Math.floor((t - 2240) / 150);
		left = [s(t < 2240 ? "≡≡≡" : "≡≡≡".slice(0, Math.max(0, after)).padEnd(3), "muted")];
		right = [s(t < 2240 ? flip : "   ", "text")];
	}
	const spine = s(t >= 1800 && t < 2240 ? "╲" : "│", "dim");
	const label = clip(name, room - 13);
	return [
		[s(" ╭───┬───╮", "dim")],
		[s(" │", "dim"), ...left, spine, ...right, s("│", "dim"), s(label ? `  ${label}` : "", "muted")],
		[s(" ╰───┴───╯", "dim")],
	];
}

/**
 * A tiny editor titled with the file: the old line is deleted from its end in
 * red, the new one typed in green, the file marked as modified.
 */
function editor(time: number, name: string, room: number): PropRow[] {
	const width = room - 1;
	const inner = width - 2;
	const length = Math.max(3, Math.min(inner - 5, 22));
	const removeMs = 45;
	const addMs = 75;
	const cycle = length * removeMs + length * addMs + 1300;
	const t = time % cycle;
	const removing = t < length * removeMs;
	const cursorOn = Math.floor(time / 300) % 2 === 0;
	let line: PropRow;
	if (removing) {
		const left = length - Math.floor(t / removeMs);
		line = [s(" - ", "error"), s(words(0, left), "error"), s(cursorOn ? "▌" : " ", "accent")];
	} else {
		const typed = Math.min(length, Math.floor((t - length * removeMs) / addMs));
		line = [s(" + ", "success"), s(words(4, typed), "success"), s(typed < length || cursorOn ? "▌" : " ", "accent")];
	}
	const title = clip(name, inner - 7);
	const top: PropRow = [
		s("─ ", "dim"),
		s(title, "accent"),
		s(" ● ", "warning"),
	];
	return box(width, line, top);
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * A small terminal with window buttons, filling `room`: the command is typed
 * in, then a spinner runs while it does. Long commands scroll.
 */
function terminal(command: string, time: number, room: number): PropRow[] {
	const inner = Math.max(4, room - 6);
	const text = oneLine(command).slice(0, 240);
	const typeMs = 60;
	const cycle = text.length * typeMs + 3200;
	const t = time % cycle;
	const typing = t < text.length * typeMs;
	const shown = text.slice(0, typing ? Math.floor(t / typeMs) : text.length);
	const tail = typing ? "▌" : ` ${SPINNER[Math.floor(time / 90) % SPINNER.length]}`;
	const full = shown + tail;
	const visible = full.length > inner ? full.slice(full.length - inner) : full;
	const cmd = visible.slice(0, visible.length - tail.length);
	const end = visible.slice(cmd.length);
	return [
		[s(" ┌─", "dim"), s("●", "error"), s(" "), s("●", "warning"), s(" "), s("●", "success"), s(`${"─".repeat(Math.max(0, inner - 4))}┐`, "dim")],
		[s(" │", "dim"), s("$ ", "success"), s(cmd, "text"), s(end, "accent"), s(" ".repeat(Math.max(0, inner - visible.length))), s("│", "dim")],
		[s(` └${"─".repeat(inner + 2)}┘`, "dim")],
	];
}

const GLOBE = ["◐", "◓", "◑", "◒"];

/** A spinning globe sending a packet to the host and back. */
function globe(time: number, host: string, room: number): PropRow[] {
	const track = 7;
	const pos = Math.floor(time / 110) % (track * 2);
	const out = pos < track;
	const at = out ? pos : track * 2 - 1 - pos;
	const line = [...Array(track)].map((_, i) => (i === at ? (out ? "•" : "∘") : "·"));
	return [
		[],
		[
			s(" "),
			s(GLOBE[Math.floor(time / 180) % GLOBE.length], "accent"),
			s(" "),
			...line.map((c) => s(c, c === "·" ? "dim" : "accent")),
			s(" "),
			s(clip(host, room - 3 - track - 2), "text"),
		],
		[],
	];
}

/** A magnifier sweeping a line, lighting up the matches it passes; the pattern above. */
function magnifier(time: number, pattern: string, room: number): PropRow[] {
	const width = Math.max(6, Math.min(room - 2, 24));
	const pos = Math.floor(time / 90) % (width + 6);
	const row: PropRow = [s(" ")];
	for (let i = 0; i < width; i++) {
		const match = (i * 7 + 3) % 5 === 0;
		if (i === pos) row.push(s("◉", "accent"));
		else if (match && i < pos) row.push(s("▪", "success"));
		else row.push(s("·", i < pos ? "muted" : "dim"));
	}
	return [[s(" ⌕ ", "accent"), s(clip(oneLine(pattern), room - 4), "muted")], row, []];
}

/** A checklist of three, ticked one after another, then a fresh one. */
function checklist(time: number): PropRow[] {
	const lengths = [6, 4, 7];
	const done = Math.floor(time / 650) % 5;
	return lengths.map((length, i) => {
		if (i < done) return [s(" ☑ ", "success"), s("━".repeat(length), "dim")];
		const current = i === done && Math.floor(time / 220) % 2 === 0;
		return [s(" ☐ ", current ? "accent" : "muted"), s("━".repeat(length), "muted")];
	});
}

/** Z's rising from the sleeping crab, one after another. */
function snooze(time: number): PropRow[] {
	const rows: PropRow[] = [[], [], []];
	for (const offset of [0, 1400]) {
		const t = (time + offset) % 2800;
		const level = Math.min(2, Math.floor(t / 900));
		const char = ["z", "z", "Z"][level];
		rows[2 - level] = [s(" ".repeat(1 + level * 2)), s(char, level === 2 ? "text" : level === 1 ? "muted" : "dim")];
	}
	return rows;
}

/** A red mark, then stars circling above the dizzy crab. */
function dizzy(time: number): PropRow[] {
	const mark: PropRow = [s(" ✗ ", "error"), s("!", "error")];
	if (time < 450) return [[], mark, []];
	const ring = ["✶", " ", "·", " ", "✧", " "];
	const shift = Math.floor(time / 120) % ring.length;
	const stars = [...ring.slice(shift), ...ring.slice(0, shift)].join("");
	return [[s(" "), s(stars, "warning")], mark, []];
}

const CONFETTI = ["✦", "✧", "·", "*", "◆", "+"];
const CONFETTI_COLORS: PropColor[] = ["success", "accent", "warning", "clawd"];

/** Confetti bursting out to the right, with the cheer once the crab has landed. */
function confetti(time: number, text: string, room: number): PropRow[] {
	const width = Math.max(6, Math.min(room - 1, 22));
	const rows: PropRow[] = [];
	for (let r = 0; r < 3; r++) {
		const cells: Span[] = Array.from({ length: width }, () => s(" "));
		for (let p = 0; p < 4; p++) {
			const speed = 1 + ((p + r) % 3);
			const col = Math.floor((time / 140) * speed) + p * 5 + r * 2 - 4;
			if (col >= 0 && col < width) {
				cells[col] = s(CONFETTI[(p + r * 2) % CONFETTI.length], CONFETTI_COLORS[(p + r) % CONFETTI_COLORS.length]);
			}
		}
		rows.push(cells);
	}
	if (time > 600) {
		const label = clip(text, width - 2);
		rows[1] = [s(" "), s(label, "success"), ...rows[1].slice(label.length + 1)];
	}
	return rows;
}

/** The envelope, three cells wide so it reads bigger than the bare glyph; its middle is the ✉. */
export const ENVELOPE = "[✉]";

/** The column beside the crab where the envelope leaves the editor; the message folds up below it. */
export const FLIGHT_START = 11;

/** Where the envelope is during its flight, [row, column] beside the crab: up from the editor into the raised arm. */
const FLIGHT: [number, number][] = [
	[2, FLIGHT_START],
	[2, 8],
	[1, 6],
	[1, 4],
	[0, 2],
	[0, 1],
];

/**
 * A sent message: while it folds into an envelope in the editor, the crab looks
 * on; then the envelope rises from the editor with a short trail, the crab
 * catches it and holds it up while it hops; where it lands, a puff of dust and a
 * spark as it takes the message in.
 */
function envelope(time: number): PropRow[] {
	const rows: PropRow[] = [[], [], []];
	const put = (row: number, col: number, span: Span) => {
		const width = textWidth(rows[row]!);
		rows[row]!.push(s(" ".repeat(Math.max(0, col - width))), span);
	};
	if (time < FOLD_MS) {
		// Still in the editor.
	} else if (time < FLIGHT_MS) {
		const step = Math.min(FLIGHT.length - 1, Math.floor(((time - FOLD_MS) / (FLIGHT_MS - FOLD_MS)) * FLIGHT.length));
		const [row, col] = FLIGHT[step]!;
		const trail = FLIGHT[step - 1];
		// FLIGHT gives the envelope's middle; it starts a cell to the left.
		if (trail && trail[0] !== row) put(trail[0], trail[1], s("·", "dim"));
		put(row, Math.max(0, col - 1), s(ENVELOPE, "text"));
		if (trail && trail[0] === row) put(row, col + 3, s("·", "dim"));
	} else if (time < LANDING_MS) {
		put(0, 0, s(ENVELOPE, "text"));
	} else if (time < LANDING_MS + 300) {
		put(0, 1, s(time < LANDING_MS + 150 ? "✦" : "✧", "accent"));
		put(2, 0, s(time < LANDING_MS + 150 ? " ˙·˙" : "  ·", "dim"));
	}
	return rows;
}

const TOOL_SPINNER = ["◴", "◷", "◶", "◵"];

// =============================================================================
// Frames
// =============================================================================

/**
 * The crab in `mood`, `time` ms after the mood began.
 */
export function crabFrame(mood: Mood, time: number, scene: Scene): CrabFrame {
	const mascot = scene.mascot ?? "clawd";
	const pose = (steps: Step[], loop = true) => draw(at(steps, time, loop), scene.tired, mascot);
	const room = scene.room ?? SIDE_ROOM;
	switch (mood) {
		case "idle":
			return { art: pose(IDLE) };
		case "sleep":
			return { art: pose(SLEEP), prop: snooze(time) };
		case "thinking":
			return { art: pose(THINKING), prop: thoughtBubble(time) };
		case "writing":
			return { art: pose(WRITING), prop: sheet(time, room) };
		case "walking": {
			const step = Math.floor(time / STEP_MS) % 2;
			const name = clip(scene.tool ?? "", room - 4);
			return {
				art: draw({ look: scene.direction, feet: step ? "left" : "right" }, scene.tired, mascot),
				prop: name ? [[], [s(" "), s(TOOL_SPINNER[Math.floor(time / 150) % 4], "accent"), s(` ${name}`, "muted")], []] : undefined,
			};
		}
		case "reading":
			return { art: pose(READING), prop: book(time, fileName(scene.detail) ?? "", room) };
		case "typing":
			return { art: pose(TYPING), prop: editor(time, fileName(scene.detail) ?? scene.tool ?? "", room) };
		case "terminal":
			return { art: pose(TYPING), prop: terminal(scene.detail ?? "", time, room) };
		case "surfing":
			return { art: pose(SURFING), prop: globe(time, hostOf(scene.detail) ?? "", room) };
		case "searching":
			return { art: pose(READING), prop: magnifier(time, scene.detail ?? scene.tool ?? "", room) };
		case "delegating": {
			// The buddy scurries away from the crab and back, its task above it.
			const step = Math.floor(time / 140);
			const x = 1 + Math.abs((step % 10) - 5);
			const task = clip(oneLine(scene.detail ?? ""), room - 4);
			return {
				art: pose(DELEGATING),
				buddy: { art: buddy(step, mascot), x, caption: task ? [s(" ↳ ", "accent"), s(task, "muted")] : undefined },
			};
		}
		case "planning":
			return { art: pose(PLANNING), prop: checklist(time) };
		case "catch":
			return { art: pose(CATCH, false), prop: envelope(time) };
		case "ouch":
			return { art: pose(OUCH, false), prop: dizzy(time) };
		case "cheer":
			return { art: pose(CHEER, false), prop: confetti(time, scene.cheer ?? "done", room) };
	}
}
