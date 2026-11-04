/**
 * Session titles: which model writes them, what it is asked, and how its answer
 * becomes a title.
 */

/** Just the fields of a pi model the choice reads. */
export interface TitleModel {
	id: string;
	provider: string;
	name?: string;
	cost?: { input: number; output: number };
}

/** Name patterns of small models, smallest first; models matching none come last. */
const SMALL_NAMES = [
	/nano/i,
	/\b(0\.5|1|1\.5|2|3)b\b/i,
	/lite/i,
	/mini/i,
	/haiku/i,
	/tiny/i,
	/small/i,
	/flash/i,
	/\b(7|8|9)b\b/i,
];

const tier = (m: TitleModel) => {
	const name = `${m.id} ${m.name ?? ""}`;
	const index = SMALL_NAMES.findIndex((pattern) => pattern.test(name));
	return index < 0 ? SMALL_NAMES.length : index;
};

const price = (m: TitleModel) => (m.cost ? m.cost.input + m.cost.output : Number.POSITIVE_INFINITY);

/** The smallest of `provider`'s models: by name (nano, mini, haiku, flash, …), then by price. */
export function smallestModel<T extends TitleModel>(models: readonly T[], provider: string): T | undefined {
	return models
		.filter((m) => m.provider === provider)
		.sort((a, b) => tier(a) - tier(b) || price(a) - price(b) || a.id.localeCompare(b.id))[0];
}

export const TITLE_SYSTEM_PROMPT =
	"You name chat sessions. Reply with a short title of 3 to 6 words for the conversation you are given, " +
	"in the language of the conversation. Reply with the title only: no quotes, no trailing punctuation, no explanation.";

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** What the model gets to read: the first prompt and the start of the answer. */
export function titlePrompt(prompt: string, answer: string): string {
	return `User: ${clip(prompt.trim(), 1500)}\n\nAssistant: ${clip(answer.trim(), 800)}`;
}

/** The model's answer as a title: one line, without quotes, labels or a trailing full stop; undefined if nothing is left. */
export function cleanTitle(text: string | undefined, max = 60): string | undefined {
	let title = (text ?? "")
		.split("\n")
		.map((line) => line.trim())
		.find(Boolean);
	if (!title) return undefined;
	title = title
		.replace(/^(title|titel)\s*:\s*/i, "")
		.replace(/^[#*\s]+|[*\s]+$/g, "")
		.replace(/^["'`„“«]+|["'`”“»]+$/g, "")
		.replace(/[.!?:;,]+$/, "")
		.replace(/\s+/g, " ")
		.trim();
	if (title.length > max) {
		const cut = title.slice(0, max);
		title = cut.slice(0, cut.lastIndexOf(" ") > max / 2 ? cut.lastIndexOf(" ") : max).trim();
	}
	return title || undefined;
}
