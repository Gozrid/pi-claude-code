/**
 * Clawd, Claude Code's mascot, as animated pixel art.
 *
 * Clawd hops in with raised arms and waves, then idles in a loop: blinks, looks
 * left and right, patters with its feet and hops now and then. Frames are built
 * from parts (eyes, arms, feet) on a 12×6 grid after the small Clawd in the CLI.
 * On holidays Clawd dresses up (see COSTUMES); /costume or PI_CLAWD_COSTUME=<name>
 * or "none" picks a costume regardless of the date.
 *
 * Gravi, Antigravity's hover bot, plays the same: a rounded body, a thruster
 * flame where Clawd has feet, and it bobs gently while it hovers.
 */

import type { Frame } from "./logos.ts";

/** Who is drawn: Clawd for Claude Code, Gravi for Antigravity. */
export type Species = "clawd" | "gravi";

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
	/** Height above the ground, 0-1 of the maximum lift. */
	lift?: number;
	/** Glowing eyes in this colour instead of holes. */
	glow?: string;
	/** Mouth wide open, with fangs. */
	mouth?: boolean;
	/** Sideways offset in pixels, for shaking. */
	dx?: number;
	/** Out of the dark: 0 only the glowing eyes, 1-2 a dimmed silhouette, 3 or unset in full colour. */
	shade?: number;
}

const WIDTH = 12;
/** Row 0 stays free for raised arms. */
const HEIGHT = 6;

// =============================================================================
// Costumes
// =============================================================================

/** Colours of the costume pixels; Clawd's own are "o" and "l". */
export const COSTUME_COLORS: Record<string, string> = {
	R: "#D42A2A",
	W: "#F2F2F2",
	P: "#F4A6C0",
	V: "#6A3FA0",
	A: "#FF8C1A",
	Y: "#FFD23F",
	M: "#E040A0",
	C: "#3FC8E0",
	G: "#3BAA4A",
	// Firework sparks (drawn as glyphs, see COSTUME_GLYPHS), bright and fading.
	j: "#FFD23F",
	k: "#E040A0",
	n: "#3FC8E0",
	t: "#3BAA4A",
	// Dimmed variants: fading sparks (glyphs), lightning and hearts (blocks).
	y: "#8C7426",
	m: "#7A2459",
	c: "#24707E",
	g: "#235F2C",
	w: "#7A7A7A",
	r: "#7A1E2E",
	p: "#9C5A72",
	// The pink partner's eyelids.
	q: "#B0607A",
	// Halloween: glowing eyes and the silhouette in the dark.
	E: "#B8FF3A",
	X: "#FF2A2A",
	"1": "#26170F",
	"2": "#4E2E21",
	// Snowflakes, near and far.
	S: "#F2F2F2",
	s: "#8A8A8A",
	// Carnival (glyphs): streamers, and confetti seen flat.
	u: "#FFD23F",
	v: "#E040A0",
	D: "#FFD23F",
	F: "#3BAA4A",
	H: "#3FC8E0",
	I: "#E040A0",
};

/** Costume pixels drawn as a small text glyph instead of a full block. */
export const COSTUME_GLYPHS: Record<string, string> = {
	S: "*",
	s: "·",
	j: "*",
	k: "*",
	n: "*",
	t: "*",
	y: "·",
	m: "·",
	c: "·",
	g: "·",
	u: "~",
	v: "~",
	D: "▪",
	F: "▪",
	H: "▪",
	I: "▪",
};

type Pixel = [row: number, col: number, char: string];

/**
 * A scene around Clawd: the grid widened by `left`/`right` columns and `top` rows, with
 * animated pixels behind Clawd. Clawd then jumps inside the grid instead of moving the whole art.
 */
interface Backdrop {
	left: number;
	right: number;
	top: number;
	/** Pixels at `time` ms, in the widened grid's coordinates. */
	pixels?(time: number, width: number, height: number): Pixel[];
	/** A second Clawd at the right edge, facing Clawd, in these colours. */
	partner?: { body: string; lid: string };
}

interface Costume {
	/** Rows above the body; the last one rests on the head and moves with it. */
	hat: string[];
	/** Pixels on the body: [row, column, colour character]. */
	face?: Pixel[];
	backdrop?: Backdrop;
}

/** One firework: where it bursts, when in the cycle it is launched, and its colour (bright, dimmed). */
const ROCKETS = [
	{ col: 3, row: 3, at: 0, color: ["j", "y"] },
	{ col: 20, row: 2, at: 1100, color: ["k", "m"] },
	{ col: 8, row: 1, at: 2000, color: ["n", "c"] },
	{ col: 21, row: 6, at: 2900, color: ["t", "g"] },
];
const FIREWORKS_CYCLE_MS = 4000;

/** Snowflakes: column, start offset in rows, and whether they are near (bright, faster, swaying). */
const FLAKES = [
	[1, 0, true], [4, 5, false], [7, 2, true], [10, 8, false], [13, 4, false], [15, 9, true],
	[18, 1, false], [20, 6, true], [22, 3, false], [2, 7, false], [9, 10, true], [17, 5, true],
	[23, 9, true], [5, 3, false], [12, 0, true], [21, 10, false],
] as const;

/** Hearts rise from between the two Clawds, swaying, and fade near the top. */
function risingHearts(time: number, _width: number, height: number): Pixel[] {
	const pixels: Pixel[] = [];
	const start = height - 4;
	for (let i = 0; i < 4; i++) {
		const t = (time + i * 700) % 2800;
		const row = Math.round(start - t / 260);
		if (row < -1) continue;
		const col = 13 + (i % 2) + Math.round(Math.sin(time / 500 + i * 2));
		const [bright, dim] = i % 2 === 0 ? ["R", "r"] : ["P", "p"];
		const char = row < 2 ? dim : bright;
		pixels.push([row, col - 1, char], [row, col + 1, char], [row + 1, col, char]);
	}
	return pixels;
}

/** Two flashes of lightning that show Clawd's dark silhouette (shade 1 in SCARE, from 2320 ms). */
function lightning(time: number, width: number, height: number): Pixel[] {
	const flash = (time >= 2350 && time < 2420) || (time >= 2510 && time < 2560);
	if (!flash) return [];
	const pixels: Pixel[] = [];
	for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) pixels.push([row, col, "w"]);
	return pixels;
}

/** Snow falling past Clawd: near flakes are brighter, faster and drift side to side. */
function snowfall(time: number, width: number, height: number): Pixel[] {
	return FLAKES.map(([col, offset, near], i): Pixel => {
		const rowMs = near ? 380 : 650;
		const row = Math.floor(time / rowMs + offset) % height;
		const drift = near ? Math.round(Math.sin(time / 900 + i)) : 0;
		return [row, (col + drift + width) % width, near ? "S" : "s"];
	});
}
const RISE_MS = 600;

/** Rockets rise from the ground and burst into a ring of sparks that grows, fades and drops. */
function fireworks(time: number, _width: number, height: number): Pixel[] {
	const pixels: Pixel[] = [];
	const ring = (row: number, col: number, r: number, char: string) => {
		const d = Math.max(1, Math.round(r * 0.7));
		for (const [dr, dc] of [
			[-r, 0], [r, 0], [0, -r], [0, r],
			[-d, -d], [-d, d], [d, -d], [d, d],
		]) pixels.push([row + dr, col + dc, char]);
	};
	for (const rocket of ROCKETS) {
		const t = (time - rocket.at + FIREWORKS_CYCLE_MS) % FIREWORKS_CYCLE_MS;
		const [bright, dim] = rocket.color;
		const ground = height - 1;
		if (t < RISE_MS) {
			const row = Math.round(ground - (t / RISE_MS) * (ground - rocket.row));
			pixels.push([row + 1, rocket.col, "s"], [row, rocket.col, bright]);
		} else if (t < RISE_MS + 150) {
			pixels.push([rocket.row, rocket.col, "S"]);
			ring(rocket.row, rocket.col, 1, bright);
		} else if (t < RISE_MS + 350) {
			ring(rocket.row, rocket.col, 1, dim);
			ring(rocket.row, rocket.col, 2, bright);
		} else if (t < RISE_MS + 600) {
			ring(rocket.row, rocket.col, 3, bright);
		} else if (t < RISE_MS + 900) {
			// The sparks fade and fall.
			ring(rocket.row + 1, rocket.col, 3, dim);
		}
	}
	return pixels;
}

/** Confetti colours: flat, and dimmed while a piece shows its edge. Glyphs keep it thinner than blocks. */
const CONFETTI = [["D", "y"], ["F", "g"], ["H", "c"], ["I", "m"]];

/** Streamers waving across the top and confetti fluttering down, flipping as it falls. */
function confetti(time: number, width: number, height: number): Pixel[] {
	const pixels: Pixel[] = [];
	for (let col = 0; col < width; col++) {
		const row = Math.round(0.5 + 0.5 * Math.sin(col * 0.7 - time / 350));
		pixels.push([row, col, Math.floor(col / 4) % 2 ? "v" : "u"]);
	}
	for (let i = 0; i < 14; i++) {
		const rowMs = 300 + (i % 3) * 120;
		const row = 2 + (Math.floor(time / rowMs + i * 1.9) % (height - 2));
		const col = (i * 7 + 2 + Math.round(Math.sin(time / 300 + i * 1.7)) + width) % width;
		const [bright, dim] = CONFETTI[i % CONFETTI.length];
		pixels.push([row, col, Math.floor(time / 220 + i) % 3 ? bright : dim]);
	}
	return pixels;
}

/** Painted eggs in the grass: column, shell and stripe colour; they hop in turn. */
const EGGS = [
	{ col: 0, shell: "C", stripe: "Y" },
	{ col: 4, shell: "P", stripe: "W" },
	{ col: 23, shell: "Y", stripe: "M" },
];
const EGG_HOP_MS = 1200;
const EGG_SHAPE = ["ss", "ss", "SS", "ss"];
const TUFTS = [3, 21, 27];

/** Grass tufts swaying in the wind and eggs that hop and wobble, one after the other. */
function eggHunt(time: number, _width: number, height: number): Pixel[] {
	const pixels: Pixel[] = [];
	const ground = height - 1;
	TUFTS.forEach((col, i) => {
		const sway = Math.round(Math.sin(time / 600 + i * 1.3));
		pixels.push([ground, col, "G"], [ground - 1, col + sway, "G"]);
	});
	EGGS.forEach((egg, i) => {
		const t = (time - i * EGG_HOP_MS + EGGS.length * EGG_HOP_MS) % (EGGS.length * EGG_HOP_MS);
		const hop = t < 400 ? Math.round(arc(t / 400) * 2) : 0;
		const wobble = t >= 400 && t < 600 ? (Math.floor(t / 50) % 2 ? 1 : -1) : 0;
		EGG_SHAPE.forEach((line, r) => {
			[...line].forEach((char, c) => {
				if (char === ".") return;
				const tilt = r === 0 ? wobble : 0;
				pixels.push([ground - EGG_SHAPE.length + 1 + r - hop, egg.col + c + tilt, char === "S" ? egg.stripe : egg.shell]);
			});
		});
	});
	return pixels;
}

export const COSTUMES: Record<string, Costume> = {
	christmas: {
		hat: [
			"........RRW.", //
			".....RRRRR..",
			"..RRRRRRRR..",
			".WWWWWWWWWW.",
		],
		backdrop: { left: 6, right: 6, top: 2, pixels: snowfall },
	},
	newYear: {
		hat: [
			".....YY.....", //
			".....CC.....",
			"....MMMM....",
			"...CCCCCC...",
		],
		backdrop: { left: 6, right: 6, top: 2, pixels: fireworks },
	},
	carnival: {
		hat: [
			".Y........Y.", //
			"..R......G..",
			"..RRR..GGG..",
			"..RRRRGGGG..",
		],
		face: [
			[3, 5, "R"],
			[3, 6, "R"],
		],
		backdrop: { left: 6, right: 6, top: 2, pixels: confetti },
	},
	valentine: {
		hat: [],
		backdrop: { left: 0, right: 16, top: 5, pixels: risingHearts, partner: { body: "P", lid: "q" } },
	},
	easter: {
		hat: [
			"..WW....WW..", //
			"..WP....PW..",
			"..WP....PW..",
			"..WW....WW..",
		],
		backdrop: { left: 8, right: 8, top: 0, pixels: eggHunt },
	},
	halloween: {
		hat: [
			".......V....", //
			"......VV....",
			".....VVV....",
			"....VVVV....",
			"...AAAAAA...",
			".VVVVVVVVVV.",
		],
		// Room to shake, and lightning behind the silhouette.
		backdrop: { left: 1, right: 1, top: 1, pixels: lightning },
	},
};

/** Easter Sunday of a year (Gregorian calendar, anonymous algorithm). */
export function easter(year: number): Date {
	const a = year % 19;
	const b = Math.floor(year / 100);
	const c = year % 100;
	const d = Math.floor(b / 4);
	const e = b % 4;
	const f = Math.floor((b + 8) / 25);
	const g = Math.floor((b - f + 1) / 3);
	const h = (19 * a + b - d - g + 15) % 30;
	const i = Math.floor(c / 4);
	const k = c % 4;
	const l = (32 + 2 * e + 2 * i - h - k) % 7;
	const m = Math.floor((a + 11 * h + 22 * l) / 451);
	const month = Math.floor((h + l - 7 * m + 114) / 31);
	const day = ((h + l - 7 * m + 114) % 31) + 1;
	return new Date(year, month - 1, day);
}

/** The costume for a day, by local date. */
export function costumeFor(date: Date): string | undefined {
	const month = date.getMonth() + 1;
	const day = date.getDate();
	const today = new Date(date.getFullYear(), month - 1, day);
	const sunday = easter(date.getFullYear());
	/** Days from Easter Sunday to today. */
	const fromEaster = Math.round((today.getTime() - sunday.getTime()) / 86_400_000);

	if (month === 12 && day <= 26) return "christmas";
	if ((month === 12 && day === 31) || (month === 1 && day === 1)) return "newYear";
	if (month === 2 && day === 14) return "valentine";
	// Weiberfastnacht to Shrove Tuesday.
	if (fromEaster >= -52 && fromEaster <= -47) return "carnival";
	// Good Friday to Easter Monday.
	if (fromEaster >= -2 && fromEaster <= 1) return "easter";
	if (month === 10 && day >= 24) return "halloween";
	return undefined;
}

/** Picked with /costume for this pi process; undefined follows PI_CLAWD_COSTUME and the date. */
let chosen: string | undefined;

/** Picks a costume name or "none"; undefined goes back to the automatic choice. */
export function chooseCostume(name: string | undefined): void {
	chosen = name;
}

/** The costume name in effect: picked, forced by the environment or by the date. */
export function costumeName(): string | undefined {
	const name = chosen ?? (process.env.PI_CLAWD_COSTUME || costumeFor(new Date()));
	return name && name in COSTUMES ? name : undefined;
}

function currentCostume(): Costume | undefined {
	const name = costumeName();
	return name ? COSTUMES[name] : undefined;
}

// =============================================================================
// Poses
// =============================================================================

/** Paints Clawd's (or Gravi's) body in a pose through `set`, in its own 12×6 coordinates. */
function paintClawd(
	pose: Pose,
	set: (row: number, col: number, char: string) => void,
	body = "o",
	lid = "l",
	species: Species = "clawd",
): void {
	const top = pose.squash ? 2 : 1;
	const gravi = species === "gravi";
	for (let row = top; row <= 4; row++) {
		for (let col = 1; col <= 10; col++) {
			// Gravi is round: no body pixels in its corners.
			if (gravi && (row === top || row === 4) && (col === 1 || col === 10)) continue;
			set(row, col, body);
		}
	}

	// Eyes: holes in the body; half-closed shows the lid, closed fills them.
	const eyes = pose.eyes ?? "open";
	for (const col of [3, 8].map((c) => c + (pose.look ?? 0))) {
		if (pose.glow && eyes !== "closed") set(2, col, pose.glow);
		else if (eyes === "open") set(2, col, ".");
		else if (eyes === "half") set(2, col, lid);
	}

	// An open mouth with two fangs.
	if (pose.mouth) [3, 4, 5, 6, 7, 8].forEach((col) => set(3, col, col === 4 || col === 7 ? "W" : "."));

	// Arms: one pixel at the side, or raised above the body's corner.
	const arm = (side: -1 | 1, state: Arm) => set(state === "down" ? 3 : 0, side < 0 ? 0 : 11, body);
	arm(-1, pose.left ?? "down");
	arm(1, pose.right ?? "down");

	// Feet: four legs; a lifted pair is hidden under the body. Gravi has a thruster
	// flame instead (a hot core, a red edge) that flickers sideways when Clawd would patter.
	const feet = pose.feet ?? "both";
	if (gravi) {
		const middle = 6 + (feet === "left" ? -1 : feet === "right" ? 1 : 0);
		[
			[middle - 2, "f"],
			[middle - 1, "h"],
			[middle, "h"],
			[middle + 1, "f"],
		].forEach(([col, char]) => set(5, col as number, char as string));
		return;
	}
	if (feet !== "left") [2, 4].forEach((col) => set(5, col, body));
	if (feet !== "right") [7, 9].forEach((col) => set(5, col, body));
}

/** Pixel rows of a pose: "o" body, "l" eyelid, "f"/"h" Gravi's flame, a costume colour, "." empty. */
function draw(pose: Pose, costume: Costume | undefined, time = 0, species: Species = "clawd"): string[] {
	const backdrop = costume?.backdrop;
	// A hat needs rows above the one kept free for raised arms.
	const extra = Math.max(0, (costume?.hat.length ?? 0) - 1) + (backdrop?.top ?? 0);
	const left = backdrop?.left ?? 0;
	const width = WIDTH + left + (backdrop?.right ?? 0);
	const height = HEIGHT + extra;
	const grid = Array.from({ length: height }, () => Array<string>(width).fill("."));
	const put = (r: number, c: number, char: string) => {
		if (r >= 0 && r < height && c >= 0 && c < width) grid[r][c] = char;
	};
	/** In a scene Clawd jumps inside the grid (by whole pixels). */
	const jump = (p: Pose) => (backdrop ? Math.round(p.lift ?? 0) : 0);

	// The backdrop goes first, so the Clawds and the hat cover it.
	for (const [row, col, char] of backdrop?.pixels?.(time, width, height) ?? []) put(row, col, char);

	const partner = backdrop?.partner;
	if (partner) {
		// Its own rhythm, mirrored so it faces Clawd.
		const other = partnerPose(time);
		const dy = jump(other);
		paintClawd(other, (row, col, char) => put(row + extra - dy, width - 1 - col, char), partner.body, partner.lid, species);
	}

	const dy = jump(pose);
	const dx = pose.dx ?? 0;
	const shade = pose.shade ?? 3;
	/** Sets a pixel in Clawd's own 12×6 coordinates; in the dark only glowing eyes keep their colour. */
	const set = (row: number, col: number, char = "o") => {
		if (col < 0 || col >= WIDTH) return;
		if (shade < 3 && char !== "." && char !== pose.glow) {
			if (shade === 0) return;
			char = String(shade);
		}
		put(row + extra - dy, col + left + dx, char);
	};
	paintClawd(pose, set, "o", "l", species);

	if (costume) {
		// The hat's last row sits right on the head, so it follows a squash.
		const top = pose.squash ? 2 : 1;
		costume.hat.forEach((line, i) => {
			[...line].forEach((char, col) => {
				if (char !== ".") set(top - costume.hat.length + i, col, char);
			});
		});
		for (const [row, col, char] of costume.face ?? []) set(row, col, char);
	}
	return grid.map((row) => row.join(""));
}

/** A jump arc: 0 → 1 → 0 over progress 0-1. */
const arc = (progress: number) => 4 * progress * (1 - progress);

/** Steps of a timeline: [duration in ms, pose or pose at progress 0-1]. */
type Step = [number, Pose | ((progress: number) => Pose)];

function at(steps: Step[], time: number): Pose {
	let start = 0;
	for (const [duration, pose] of steps) {
		if (time < start + duration) return typeof pose === "function" ? pose((time - start) / duration) : pose;
		start += duration;
	}
	const last = steps[steps.length - 1][1];
	return typeof last === "function" ? last(1) : last;
}

const total = (steps: Step[]) => steps.reduce((sum, [duration]) => sum + duration, 0);

const blink: Step[] = [
	[60, { eyes: "half" }],
	[90, { eyes: "closed" }],
	[60, { eyes: "half" }],
];

const wave = (times: number): Step[] =>
	Array.from({ length: times }, (): Step[] => [
		[180, { right: "up" }],
		[180, { right: "down" }],
	]).flat();

/** Jumps in with raised arms, lands with a squash and waves. */
const ENTRANCE: Step[] = [
	[520, (p) => ({ lift: arc(p), left: "up", right: "up" })],
	[110, { squash: true }],
	[160, {}],
	...wave(3),
	[200, {}],
];

/** The idle loop. */
const IDLE: Step[] = [
	[2200, {}],
	...blink,
	[900, {}],
	[1100, { look: -1 }],
	[1100, { look: 1 }],
	[300, {}],
	...blink,
	[1400, {}],
	...Array.from({ length: 4 }, (): Step[] => [
		[140, { feet: "left" }],
		[140, { feet: "right" }],
	]).flat(),
	[900, {}],
	[110, { squash: true }],
	[380, (p) => ({ lift: arc(p) * 0.6, left: "up", right: "up" })],
	[110, { squash: true }],
	[1200, {}],
	...blink,
	[160, {}],
	...blink,
	[1600, {}],
];

/**
 * Halloween: glowing eyes open in the dark and look around, lightning shows the
 * silhouette, then Clawd leaps out with fangs and red eyes, shaking — and calms down.
 */
const SCARE: Step[] = [
	[700, { shade: 0, eyes: "closed" }],
	[500, { shade: 0, glow: "E" }],
	[120, { shade: 0, glow: "E", eyes: "closed" }],
	[400, { shade: 0, glow: "E" }],
	[300, { shade: 0, glow: "E", look: -1 }],
	[300, { shade: 0, glow: "E", look: 1 }],
	[350, { shade: 1, glow: "E" }],
	[350, { shade: 2, glow: "E" }],
	[120, { shade: 2, glow: "E", squash: true }],
	[220, (p) => ({ lift: arc(p), left: "up", right: "up", mouth: true, glow: "X" })],
	...Array.from({ length: 8 }, (_, i): Step => [70, { left: "up", right: "up", mouth: true, glow: "X", dx: i % 2 ? 1 : -1 }]),
	[500, { left: "up", right: "up", mouth: true, glow: "X" }],
	[120, { squash: true }],
	[400, {}],
];

/** Costumes with their own entrance. */
const ENTRANCES: Record<string, Step[]> = { halloween: SCARE };

const ENTRANCE_MS = total(ENTRANCE);
const IDLE_MS = total(IDLE);

const poseAt = (time: number): Pose =>
	time < ENTRANCE_MS ? at(ENTRANCE, time) : at(IDLE, (time - ENTRANCE_MS) % IDLE_MS);

/** The partner hops in a little later and idles out of step with Clawd. */
const PARTNER_DELAY_MS = 400;
const PARTNER_IDLE_SHIFT_MS = 2600;
function partnerPose(time: number): Pose {
	const t = time - PARTNER_DELAY_MS;
	if (t < ENTRANCE_MS) return at(ENTRANCE, Math.max(0, t));
	return at(IDLE, (t - ENTRANCE_MS + PARTNER_IDLE_SHIFT_MS) % IDLE_MS);
}

/** Gravi hovers: half a pixel up and down, slowly. */
const BOB_MS = 1800;
const bob = (time: number) => 0.5 * ((1 - Math.cos((2 * Math.PI * time) / BOB_MS)) / 2);

/** Clawd (or Gravi) at `time` ms after it appeared, in today's costume. */
export function clawdFrame(time: number, species: Species = "clawd"): Frame {
	const name = costumeName();
	const entrance = name ? ENTRANCES[name] : undefined;
	const entranceMs = entrance ? total(entrance) : 0;
	const pose = !entrance
		? poseAt(time)
		: time < entranceMs
			? at(entrance, time)
			: at(IDLE, (time - entranceMs) % IDLE_MS);
	const costume = currentCostume();
	const lift = species === "gravi" ? Math.max(pose.lift ?? 0, bob(time)) : (pose.lift ?? 0);
	// A scene moves Clawd inside its grid; otherwise the whole art lifts.
	return { art: draw(pose, costume, time, species), lift: costume?.backdrop ? 0 : lift };
}

/** A moment with bursting fireworks, for the still picture. */
const STILL_MS = 2000 + RISE_MS + 250;

/** The resting pose in today's costume, for a static logo and for sizing. */
export function clawdArt(species: Species = "clawd"): string[] {
	return draw({}, currentCostume(), STILL_MS, species);
}
