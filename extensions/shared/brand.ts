/**
 * The look of a provider in the extensions that act out the agent: the colour
 * and spinner of the working animation, its verbs, the mark of the "Cooked
 * for …" line and the mascot (chat-crab, provider-logo).
 *
 * Not an extension itself; pi loads only the entries listed in package.json.
 */

export type Rgb = { r: number; g: number; b: number };

export interface Brand {
	id: "claude" | "antigravity" | "default";
	/** Colour of the spinner and the working verb … */
	accent: Rgb;
	/** … and the light it shimmers to. */
	light: Rgb;
	/** Spinner frames of the working animation and the tab title. */
	frames: string[];
	/** Before "Cooked for 1m 12s". */
	mark: string;
	/** A verb for while it works (the running tool's verb wins). */
	verbs: string[];
	/** A verb for the line after the answer. */
	doneVerbs: string[];
	/** The figure in chat-crab and provider-logo; none for providers without one. */
	mascot?: "clawd" | "gravi";
}

const CLAUDE: Brand = {
	id: "claude",
	accent: { r: 217, g: 119, b: 87 },
	light: { r: 255, g: 222, b: 190 },
	frames: ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"],
	mark: "✻",
	verbs: [
		"Clauding",
		"Pondering",
		"Noodling",
		"Musing",
		"Cogitating",
		"Brewing",
		"Percolating",
		"Ruminating",
		"Conjuring",
		"Synthesizing",
		"Tinkering",
		"Scheming",
		"Mulling",
		"Simmering",
		"Untangling",
	],
	doneVerbs: ["Baked", "Brewed", "Churned", "Cogitated", "Cooked", "Crunched", "Sautéed", "Simmered", "Worked"],
	mascot: "clawd",
};

/** Google blue, an orbit for a spinner and verbs of weightlessness. */
const ANTIGRAVITY: Brand = {
	id: "antigravity",
	accent: { r: 66, g: 133, b: 244 },
	light: { r: 198, g: 218, b: 252 },
	frames: ["◜", "◠", "◝", "◞", "◡", "◟"],
	mark: "◝",
	verbs: [
		"Levitating",
		"Floating",
		"Orbiting",
		"Hovering",
		"Drifting",
		"Gliding",
		"Soaring",
		"Ascending",
		"Defying gravity",
		"Weightlessly pondering",
	],
	doneVerbs: ["Floated", "Orbited", "Levitated", "Drifted", "Hovered", "Glided", "Soared"],
	mascot: "gravi",
};

/** Every other provider: Claude Code's look, without a mascot. */
const DEFAULT: Brand = { ...CLAUDE, id: "default", mascot: undefined };

/** The brand of a model: by its provider first (Claude through Antigravity is Antigravity), then by its name. */
export function brandFor(model: { provider: string; id: string } | undefined): Brand {
	if (!model) return DEFAULT;
	if (/^antigravity/i.test(model.provider)) return ANTIGRAVITY;
	if (/^claude|anthropic/i.test(model.provider) || /claude|opus|sonnet|haiku|fable/i.test(model.id)) return CLAUDE;
	return DEFAULT;
}

export const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)];
