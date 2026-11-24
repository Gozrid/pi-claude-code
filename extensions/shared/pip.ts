/** Pip is a pocket terminal. The inset screen shows a prompt and a blinking block cursor. */
export function paintPip(
	width: number,
	pose: {
		squash?: boolean;
		eyes?: string;
		look?: number;
		feet?: string;
		left?: string;
		right?: string;
		glow?: string;
		mouth?: boolean;
	},
	set: (row: number, col: number, color: string) => void,
) {
	const top = pose.squash ? 1 : 0;
	for (let x = 1; x < width - 1; x++) {
		set(top, x, "o");
		for (let y = top + 1; y <= 3; y++) {
			set(y, x, x === 1 || x === width - 2 ? "o" : "l");
		}
		set(4, x, "o");
	}
	// The prompt occupies three screen pixels vertically, even on landing.
	const x = 3 + (pose.look ?? 0);
	set(1, x, "i");
	set(2, x + 1, "i");
	set(3, x, "i");
	if (pose.eyes !== "closed") {
		const cursor = pose.eyes === "half" ? "v" : "i";
		set(3, 5, cursor);
		set(3, 6, cursor);
	}
	set(4, 3, "v");
	set(4, 4, "v");
	set(4, width - 3, "a");
	set(pose.left === "up" ? 0 : 3, 0, "o");
	set(pose.right === "up" ? 0 : 3, width - 1, "o");
	if (pose.feet !== "left") set(5, 2, "v");
	if (pose.feet !== "right") set(5, width - 3, "v");
}
