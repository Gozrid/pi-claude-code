/**
 * Event channel for the open wishes of pi's wish list (pi-bridge), shown while
 * the chat is empty.
 *
 * pi-bridge offers the rows on WISH_LIST_CHANNEL; provider-logo takes them and
 * draws them at the bottom right of its header. Nobody taking them, pi-bridge
 * shows them right-aligned above the editor itself. pi's event bus runs its
 * listeners synchronously, so `take` is known right after the emit. A click on
 * a row is handed back through `open`, which opens pi-bridge's wish popup.
 *
 * Not an extension itself; pi loads only the entries listed in package.json.
 */

import { type TuiMouseEvent, type TuiMouseEventResult, visibleWidth } from "@earendil-works/pi-tui";

/** pi.events channel; the payload is a WishListOffer (no lines: hidden). */
export const WISH_LIST_CHANNEL = "pi-bridge:wish-list";

export interface WishListOffer {
	/** Styled rows, each at most a short title wide. */
	lines: string[];
	take(): void;
	/** Opens the wish popup at the wish of a clicked row (an index into `lines`). */
	open?(row: number): void;
}

/**
 * Mouse handling for a list of rows drawn right-aligned (one column in from the
 * edge) from row `top`: a left click on a row calls `open` with its index.
 */
export function rowClick(event: TuiMouseEvent, lines: string[], top: number, width: number, open: (row: number) => void): TuiMouseEventResult | undefined {
	const row = event.y - top;
	const line = lines[row];
	if (event.button !== "left" || line === undefined || event.x < width - visibleWidth(line) - 1 || event.x >= width - 1) return undefined;
	if (event.type === "click") open(row);
	if (event.type === "press" || event.type === "release" || event.type === "click") return { handled: true, render: false };
	return undefined;
}
