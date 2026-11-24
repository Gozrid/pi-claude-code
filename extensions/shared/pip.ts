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
	body = "o",
	screen = "l",
) {
	const top = pose.squash ? 2 : 1;
	for (let y = top; y <= 4; y++) {
		for (let x = 1; x < width - 1; x++) {
			const edge = x === 1 || x === width - 2;
			if (edge && (y === top || y === 4)) continue;
			set(y, x, y === top || edge || (y === 4 && (x === 2 || x === width - 3)) ? body : screen);
		}
	}
	const prompt = 2 + (pose.look ?? 0);
	const light = pose.glow ?? body;
	set(2, prompt, light);
	set(3, prompt + 1, light);
	set(4, prompt, light);
	if (pose.eyes !== "closed") set(3, width - 4 + (pose.look ?? 0), pose.eyes === "half" ? screen : light);
	set(pose.left === "down" || !pose.left ? 3 : 0, 0, body);
	set(pose.right === "down" || !pose.right ? 3 : 0, width - 1, body);
	if (pose.feet !== "left") set(5, 2, body);
	if (pose.feet !== "right") set(5, width - 3, body);
}
