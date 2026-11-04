/**
 * Which user message sticks to the top of the transcript, and how far the next one pushes it out.
 */

/** Rows of one message in the transcript, end exclusive. */
export interface Span {
	start: number;
	end: number;
}

/**
 * The message to pin at scroll position `scrollTop`, like `position: sticky; top: 0`:
 * the last message that began above the viewport. `hiddenRows` are its top rows
 * already pushed out by the next message coming up below it.
 */
export function pinnedRows(
	messages: Span[],
	scrollTop: number,
	maxRows: number,
): { index: number; hiddenRows: number } | undefined {
	let index = -1;
	for (let i = 0; i < messages.length && messages[i]!.start < scrollTop; i++) index = i;
	if (index < 0) return undefined;
	const height = Math.min(maxRows, messages[index]!.end - messages[index]!.start);
	const next = messages[index + 1];
	const room = next ? next.start - scrollTop : Number.POSITIVE_INFINITY;
	const hiddenRows = Math.max(0, height - room);
	return hiddenRows >= height ? undefined : { index, hiddenRows };
}
