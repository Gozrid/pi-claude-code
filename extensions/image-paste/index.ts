/**
 * Image paste for pi
 *
 * pi pastes a clipboard image (Ctrl+V) as the path of a temp file, and a dragged
 * file as its path; the model only gets the text and has to open the file
 * itself, if it can. This extension attaches every image file named in a prompt
 * to the message, so the model sees the image directly. The path stays in the
 * text, followed by "[image N attached]".
 *
 * Images are attached only for models that take them (pi resizes them to the
 * model's limits) and not with pi's setting images.blockImages.
 *
 * PI_IMAGE_PASTE=0 turns it off.
 */

import { readFile, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { detectSupportedImageMimeTypeFromFile, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findImagePaths, markAttached } from "./paths.ts";

/** Larger files are left as a path. */
const MAX_BYTES = 30 * 1024 * 1024;
/** Images per message. */
const MAX_IMAGES = 20;

const isImageFile = (path: string) => {
	try {
		const info = statSync(path);
		return info.isFile() && info.size > 0;
	} catch {
		return false;
	}
};

export default function (pi: ExtensionAPI) {
	if (process.env.PI_IMAGE_PASTE === "0") return;

	pi.on("input", async (event, ctx) => {
		if (!ctx.model?.input?.includes("image")) return { action: "continue" };
		const settings = pi.getSettings() as { images?: { blockImages?: boolean } };
		if (settings.images?.blockImages) return { action: "continue" };

		const found = findImagePaths(event.text, isImageFile);
		if (found.length === 0) return { action: "continue" };

		const images = [...(event.images ?? [])];
		const numbers = new Map<string, number>();
		const skipped: string[] = [];
		for (const { path } of found) {
			if (numbers.has(path) || skipped.includes(path)) continue;
			try {
				const mimeType = await detectSupportedImageMimeTypeFromFile(path);
				if (!mimeType || (await stat(path)).size > MAX_BYTES || images.length >= MAX_IMAGES) {
					skipped.push(path);
					continue;
				}
				images.push({ type: "image", data: (await readFile(path)).toString("base64"), mimeType });
				numbers.set(path, images.length);
			} catch {
				skipped.push(path);
			}
		}
		if (skipped.length > 0) ctx.ui.notify(`Not attached (no image, too large or too many): ${skipped.join(", ")}`, "warning");
		if (numbers.size === 0) return { action: "continue" };
		const attached = found.filter((f) => numbers.has(f.path));
		return { action: "transform", text: markAttached(event.text, attached, (path) => numbers.get(path)!), images };
	});
}
