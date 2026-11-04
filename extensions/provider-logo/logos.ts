/**
 * Provider logos as small pixel art, plus a block font for providers without one.
 *
 * Art is a grid of characters: "." is empty, any other character is a pixel whose
 * colour comes from the logo's palette (or a gradient over its rows). Each pixel
 * is drawn two terminal cells wide so it looks roughly square.
 */

import { COSTUME_COLORS, COSTUME_GLYPHS, clawdArt, clawdFrame } from "./clawd.ts";

export type Rgb = { r: number; g: number; b: number };

/** One frame of an animated logo. */
export interface Frame {
	/** Pixel rows, the same size in every frame. */
	art: string[];
	/** Height above the resting position, 0-1 of `Logo.lift`. */
	lift: number;
}

export interface Logo {
	/** Wordmark shown under the art. */
	name: string;
	/** Pixel rows (of the resting frame, for animated logos). */
	art: string[];
	/** Colour per pixel character; a function receives (row, column, char). */
	color: Record<string, Rgb> | ((row: number, col: number, char: string) => Rgb);
	/** Pixel characters drawn as a text glyph in their colour instead of a block, for small details. */
	glyphs?: Record<string, string>;
	/** Animation: the frame `time` ms after the logo appeared. */
	frame?: (time: number) => Frame;
	/** Room above the art for jumps, in pixels. */
	lift?: number;
	/** Largest pixel scale (default 3). */
	maxScale?: number;
}

const hex = (value: string): Rgb => ({
	r: Number.parseInt(value.slice(1, 3), 16),
	g: Number.parseInt(value.slice(3, 5), 16),
	b: Number.parseInt(value.slice(5, 7), 16),
});

function mix(a: Rgb, b: Rgb, t: number): Rgb {
	return {
		r: Math.round(a.r + (b.r - a.r) * t),
		g: Math.round(a.g + (b.g - a.g) * t),
		b: Math.round(a.b + (b.b - a.b) * t),
	};
}

/** A diagonal gradient across the art, from the top left to the bottom right. */
function diagonal(from: string, to: string, rows: number, cols: number) {
	const a = hex(from);
	const b = hex(to);
	return (row: number, col: number) => mix(a, b, (row / Math.max(1, rows - 1) + col / Math.max(1, cols - 1)) / 2);
}

// =============================================================================
// Logos
// =============================================================================

/** Claude's spark: a starburst in Claude orange. */
const CLAUDE: Logo = {
	name: "Claude",
	art: [
		"....o....",
		".o..o..o.",
		"..o.o.o..",
		"...ooo...",
		"ooooOoooo",
		"...ooo...",
		"..o.o.o..",
		".o..o..o.",
		"....o....",
	],
	color: { o: hex("#D97757"), O: hex("#E8A285") },
};

/** Clawd, Claude Code's mascot, animated and dressed up on holidays (see clawd.ts). The eyes are holes. */
const CLAWD: Logo = {
	name: "Claude Code",
	// Read on every use: the costume changes with the date.
	get art() {
		return clawdArt();
	},
	color: {
		o: hex("#D97757"),
		l: hex("#8F4A33"),
		...Object.fromEntries(Object.entries(COSTUME_COLORS).map(([char, value]) => [char, hex(value)])),
	},
	frame: clawdFrame,
	glyphs: COSTUME_GLYPHS,
	lift: 1,
	maxScale: 1,
};

/** Gravi, Antigravity's hover bot: Clawd's moves and costumes in Google blue, a thruster flame for feet. */
const GRAVI: Logo = {
	name: "Antigravity",
	// Read on every use: the costume changes with the date.
	get art() {
		return clawdArt("gravi");
	},
	color: {
		o: hex("#4285F4"),
		l: hex("#1A56C4"),
		h: hex("#FBBC05"),
		f: hex("#EA4335"),
		...Object.fromEntries(Object.entries(COSTUME_COLORS).map(([char, value]) => [char, hex(value)])),
	},
	frame: (time) => clawdFrame(time, "gravi"),
	glyphs: COSTUME_GLYPHS,
	lift: 1,
	maxScale: 1,
};

/** Gemini's four-point star with its blue → purple → rose gradient. */
const GEMINI: Logo = {
	name: "Gemini",
	art: [
		"....x....",
		"....x....",
		"...xxx...",
		"..xxxxx..",
		"xxxxxxxxx",
		"..xxxxx..",
		"...xxx...",
		"....x....",
		"....x....",
	],
	color: diagonal("#4285F4", "#D96570", 9, 9),
};

/** Mistral's blocky M with its yellow → red bands. */
const MISTRAL: Logo = {
	name: "Mistral AI",
	art: ["a.....a", "bb...bb", "ccccccc", "d.d.d.d", "e.....e"],
	color: { a: hex("#FFD800"), b: hex("#FFAF00"), c: hex("#FF8205"), d: hex("#FA500F"), e: hex("#E10500") },
};

/** Meta's infinity loop. */
const META: Logo = {
	name: "Meta",
	art: [".xxx.....xxx.", "x...x...x...x", "x....x.x....x", "x.....x.....x", "x....x.x....x", "x...x...x...x", ".xxx.....xxx."],
	color: diagonal("#0064E0", "#0082FB", 7, 13),
};

/** OpenAI's knot, simplified to a six-petal ring. */
const OPENAI: Logo = {
	name: "OpenAI",
	art: ["...xxx...", ".xx...xx.", "x..x.x..x", "x...x...x", "x..x.x..x", ".xx...xx.", "...xxx..."],
	color: { x: hex("#F2F2F2") },
};

/** xAI's slashed X. */
const XAI: Logo = {
	name: "xAI",
	art: ["x.....x", ".x...x.", "..x.x..", "...x...", "..x.x..", ".x...x.", "x.....x"],
	color: { x: hex("#E6E6E6") },
};

/** Ollama's llama head, reduced to ears and face. */
const OLLAMA: Logo = {
	name: "Ollama",
	art: [".x...x.", ".x...x.", "xxxxxxx", "x.x.x.x", "x..x..x", "x.....x", ".xxxxx."],
	color: { x: hex("#EDEDED") },
};

interface Brand {
	/** Matched against the provider id first … */
	provider: RegExp;
	/** … and against the model id only when no provider matched (e.g. Claude on Bedrock). */
	model?: RegExp;
	logo?: Logo;
	/** Wordmark text and colour for brands drawn with the block font. */
	name?: string;
	color?: Rgb;
}

const BRANDS: Brand[] = [
	// The Antigravity CLI gets Gravi, whichever model it runs (Gemini, Claude, …).
	{ provider: /^antigravity/, logo: GRAVI },
	// Claude Code CLI instances (claude-code, claude-work, …) get Clawd, the API keeps the spark.
	{ provider: /^claude/, logo: CLAWD },
	{ provider: /anthropic/, model: /claude|opus|sonnet|haiku|fable/, logo: CLAUDE },
	{ provider: /google|gemini|vertex/, model: /gemini/, logo: GEMINI },
	{ provider: /mistral/, model: /mistral|codestral|devstral/, logo: MISTRAL },
	{ provider: /meta|llama/, model: /llama/, logo: META },
	{ provider: /copilot/, name: "COPILOT", color: hex("#8957E5") },
	{ provider: /openai|codex|azure/, model: /^gpt|^o\d|codex/, logo: OPENAI },
	{ provider: /xai|grok/, model: /grok/, logo: XAI },
	{ provider: /ollama/, logo: OLLAMA },
	{ provider: /deepseek/, model: /deepseek/, name: "DEEPSEEK", color: hex("#4D6BFE") },
	{ provider: /kimi|moonshot/, model: /kimi/, name: "KIMI", color: hex("#1783FF") },
	{ provider: /openrouter/, name: "OPENROUTER", color: hex("#6467F2") },
	{ provider: /qwen|alibaba|dashscope/, model: /qwen/, name: "QWEN", color: hex("#615CED") },
];

// =============================================================================
// Block font for wordmarks
// =============================================================================

// prettier-ignore
const FONT: Record<string, string[]> = {
	A: [".#.", "#.#", "###", "#.#", "#.#"], B: ["##.", "#.#", "##.", "#.#", "##."], C: [".##", "#..", "#..", "#..", ".##"],
	D: ["##.", "#.#", "#.#", "#.#", "##."], E: ["###", "#..", "##.", "#..", "###"], F: ["###", "#..", "##.", "#..", "#.."],
	G: [".##", "#..", "#.#", "#.#", ".##"], H: ["#.#", "#.#", "###", "#.#", "#.#"], I: ["###", ".#.", ".#.", ".#.", "###"],
	J: ["..#", "..#", "..#", "#.#", ".#."], K: ["#.#", "#.#", "##.", "#.#", "#.#"], L: ["#..", "#..", "#..", "#..", "###"],
	M: ["#...#", "##.##", "#.#.#", "#...#", "#...#"], N: ["#..#", "##.#", "#.##", "#..#", "#..#"],
	O: [".#.", "#.#", "#.#", "#.#", ".#."], P: ["##.", "#.#", "##.", "#..", "#.."], Q: [".#.", "#.#", "#.#", "#.#", ".##"],
	R: ["##.", "#.#", "##.", "#.#", "#.#"], S: [".##", "#..", ".#.", "..#", "##."], T: ["###", ".#.", ".#.", ".#.", ".#."],
	U: ["#.#", "#.#", "#.#", "#.#", "###"], V: ["#.#", "#.#", "#.#", "#.#", ".#."],
	W: ["#...#", "#...#", "#.#.#", "##.##", "#...#"], X: ["#.#", "#.#", ".#.", "#.#", "#.#"],
	Y: ["#.#", "#.#", ".#.", ".#.", ".#."], Z: ["###", "..#", ".#.", "#..", "###"],
	"0": [".#.", "#.#", "#.#", "#.#", ".#."], "1": [".#.", "##.", ".#.", ".#.", "###"], "2": ["##.", "..#", ".#.", "#..", "###"],
	"3": ["##.", "..#", ".#.", "..#", "##."], "4": ["#.#", "#.#", "###", "..#", "..#"], "5": ["###", "#..", "##.", "..#", "##."],
	"6": [".##", "#..", "##.", "#.#", ".#."], "7": ["###", "..#", ".#.", ".#.", ".#."], "8": [".#.", "#.#", ".#.", "#.#", ".#."],
	"9": [".#.", "#.#", ".##", "..#", "##."], " ": ["..", "..", "..", "..", ".."], "-": ["...", "...", "###", "...", "..."],
};

/** Renders text in the block font as pixel art; unknown characters are skipped. */
function wordmark(text: string): string[] {
	const glyphs = [...text.toUpperCase()].map((c) => FONT[c]).filter((g): g is string[] => g !== undefined);
	return [0, 1, 2, 3, 4].map((row) => glyphs.map((g) => g[row]).join("."));
}

/** The logo for a provider/model pair; providers without art get their name in the block font. */
export function logoFor(provider: string, modelId: string, providerName: string): Logo {
	const p = provider.toLowerCase();
	const m = modelId.toLowerCase();
	const brand = BRANDS.find((b) => b.provider.test(p)) ?? BRANDS.find((b) => b.model?.test(m));
	if (brand?.logo) return brand.logo;
	const name = brand?.name ?? providerName;
	const color = brand?.color;
	return {
		name: brand?.name ? name : providerName,
		art: wordmark(name.length > 12 ? name.slice(0, 12) : name),
		color: color ? { "#": color } : diagonal("#7AA2F7", "#BB9AF7", 5, 40),
	};
}
