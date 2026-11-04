/**
 * pi's wish list (~/.pi/agent/wishes.md): wishes to change pi, kept for later.
 *
 * Every wish has a title, a short title (only for the empty chat, where the
 * open wishes are listed) and a description, plus a number, a status and where
 * it came from. The file stays Markdown to read and edit by hand:
 *
 *   ## 1. Readable MCP tool calls
 *   - Short: Readable MCP calls
 *   - Status: open
 *   - Added: 2026-11-01
 *   - Project: /Users/me/project
 *
 *   The description, as many paragraphs as needed.
 *
 * Status is open, in progress or done; done wishes stay in the file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const WISH_STATUSES = ["open", "in progress", "done"] as const;
export type WishStatus = (typeof WISH_STATUSES)[number];

export interface Wish {
	id: number;
	title: string;
	short: string;
	status: WishStatus;
	/** YYYY-MM-DD */
	added?: string;
	/** YYYY-MM-DD, when done. */
	done?: string;
	/** Working directory the wish came from. */
	project?: string;
	description: string;
}

/**
 * Most characters of a short title: two or three words, so the list in the
 * empty chat always fits beside the logo. change_request refuses longer ones;
 * longer ones written by hand are cut when shown.
 */
export const SHORT_MAX = 20;

const HEADING = "# Wishes for pi";

const today = () => new Date().toISOString().slice(0, 10);

/** First line of a text, cut to `max` characters with an ellipsis. */
export function cut(value: string, max: number): string {
	const line = value.trim().split("\n")[0].trim();
	return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

export function parseWishes(content: string): Wish[] {
	const wishes: Wish[] = [];
	// Older lists hold one line per wish: "- 2026-11-01 (/cwd): text".
	const [head, ...blocks] = content.split(/^## /m);
	for (const match of head.matchAll(/^- (\d{4}-\d{2}-\d{2}) \(([^)]*)\): (.+)$/gm)) {
		const text = match[3].trim();
		wishes.push({ id: 0, title: cut(text, 80), short: cut(text, SHORT_MAX), status: "open", added: match[1], project: match[2], description: text });
	}
	for (const block of blocks) {
		const lines = block.split("\n");
		const heading = lines[0].trim().match(/^(?:(\d+)\.\s*)?(.*)$/)!;
		const fields: Record<string, string> = {};
		let i = 1;
		while (i < lines.length && lines[i].trim() === "") i++;
		for (; i < lines.length; i++) {
			const field = lines[i].match(/^- ([A-Za-z]+): (.*)$/);
			if (!field) break;
			fields[field[1].toLowerCase()] = field[2].trim();
		}
		const status = WISH_STATUSES.find((s) => s === fields.status?.toLowerCase()) ?? "open";
		const title = heading[2].trim();
		wishes.push({
			id: heading[1] ? Number(heading[1]) : 0,
			title,
			short: fields.short || cut(title, SHORT_MAX),
			status,
			added: fields.added,
			done: fields.done,
			project: fields.project,
			description: lines.slice(i).join("\n").trim(),
		});
	}
	// Wishes without a number (older lists, added by hand) get the next free ones.
	let next = Math.max(0, ...wishes.map((w) => w.id)) + 1;
	for (const wish of wishes) if (!wish.id) wish.id = next++;
	return wishes;
}

export function formatWishes(wishes: Wish[]): string {
	const blocks = wishes.map((w) =>
		[
			`## ${w.id}. ${w.title}`,
			`- Short: ${w.short}`,
			`- Status: ${w.status}`,
			...(w.added ? [`- Added: ${w.added}`] : []),
			...(w.done ? [`- Done: ${w.done}`] : []),
			...(w.project ? [`- Project: ${w.project}`] : []),
			"",
			w.description,
		].join("\n"),
	);
	return `${[HEADING, ...blocks].join("\n\n")}\n`;
}

export function readWishes(file: string): Wish[] {
	try {
		return parseWishes(readFileSync(file, "utf8"));
	} catch {
		return [];
	}
}

function writeWishes(file: string, wishes: Wish[]): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, formatWishes(wishes));
}

export function addWish(file: string, wish: { title: string; short: string; description: string; project?: string }): Wish {
	const wishes = existsSync(file) ? readWishes(file) : [];
	const added: Wish = {
		id: Math.max(0, ...wishes.map((w) => w.id)) + 1,
		title: cut(wish.title, 120),
		short: cut(wish.short || wish.title, SHORT_MAX),
		status: "open",
		added: today(),
		project: wish.project,
		description: wish.description.trim(),
	};
	writeWishes(file, [...wishes, added]);
	return added;
}

/** Sets a wish's status; undefined when there is no wish with that number. */
export function setWishStatus(file: string, id: number, status: WishStatus): Wish | undefined {
	const wishes = readWishes(file);
	const wish = wishes.find((w) => w.id === id);
	if (!wish) return undefined;
	wish.status = status;
	wish.done = status === "done" ? today() : undefined;
	writeWishes(file, wishes);
	return wish;
}

/** The wishes still to do: those in progress first, then the open ones, oldest first. */
export function openWishes(wishes: Wish[]): Wish[] {
	return [...wishes.filter((w) => w.status === "in progress"), ...wishes.filter((w) => w.status === "open")];
}

type Theme = { fg(color: any, text: string): string };

/** Most wishes listed in the empty chat; the rest are counted. */
const MAX_SHOWN = 6;

const shownOf = (open: Wish[]) => (open.length > MAX_SHOWN ? open.slice(0, MAX_SHOWN - 1) : open);

/** The heading of the wish list in the empty chat, drawn like a link. */
export const WISHES_HEADING = "Wishes ›";
/** The last row: how to open the list. */
export const WISHES_HINT = "click or /wishes";

/**
 * The wish each row of wishLines opens in the popup when clicked: the heading
 * and the hint the first one, "+n more" the first one not listed.
 */
export function wishLineIds(wishes: Wish[]): number[] {
	const open = openWishes(wishes);
	if (open.length === 0) return [];
	const shown = shownOf(open);
	return [open[0].id, ...shown.map((w) => w.id), ...(shown.length < open.length ? [open[shown.length].id] : []), open[0].id];
}

/**
 * Rows for the empty chat: a heading in the accent colour with ›, so it reads
 * as something to click, one short title per open wish (◐ in progress), and a
 * hint how to open them.
 */
export function wishLines(theme: Theme, wishes: Wish[]): string[] {
	const open = openWishes(wishes);
	if (open.length === 0) return [];
	const shown = shownOf(open);
	return [
		theme.fg("accent", WISHES_HEADING),
		...shown.map((w) =>
			w.status === "in progress"
				? `${theme.fg("accent", cut(w.short, SHORT_MAX))} ${theme.fg("accent", "◐")}`
				: `${theme.fg("muted", cut(w.short, SHORT_MAX))} ${theme.fg("dim", "•")}`,
		),
		...(shown.length < open.length ? [theme.fg("dim", `+${open.length - shown.length} more`)] : []),
		theme.fg("dim", WISHES_HINT),
	];
}
