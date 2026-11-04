/**
 * Image paths in a prompt: found however they got there, and marked as attached.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { findImagePaths, markAttached } from "../extensions/image-paste/paths.ts";

const files = new Set([
	"/var/folders/T/pi-clipboard-1234.png",
	"/Users/me/Desktop/Bildschirmfoto 2026-11-01 um 18.51.30.png",
	"/Users/me/Desktop/Screenshot 2026-11-01 at 6.51.30 PM.png",
	"/Users/me/Pictures/a (1).jpg",
	"/Users/me/x.webp",
]);
const exists = (path: string) => files.has(path);
const paths = (text: string) => findImagePaths(text, exists, "/Users/me").map((f) => f.path);

test("a pasted temp file and a typed path are found", () => {
	assert.deepEqual(paths("what is this /var/folders/T/pi-clipboard-1234.png?"), ["/var/folders/T/pi-clipboard-1234.png"]);
	assert.deepEqual(paths("~/x.webp"), ["/Users/me/x.webp"]);
});

test("spaces: escaped by dragging, quoted, or plain", () => {
	const shot = "/Users/me/Desktop/Bildschirmfoto 2026-11-01 um 18.51.30.png";
	assert.deepEqual(paths("look: /Users/me/Desktop/Bildschirmfoto\\ 2026-11-01\\ um\\ 18.51.30.png"), [shot]);
	assert.deepEqual(paths(`'${shot}' and`), [shot]);
	assert.deepEqual(paths(`why ${shot}`), [shot]);
	assert.deepEqual(paths("/Users/me/Pictures/a\\ \\(1\\).jpg"), ["/Users/me/Pictures/a (1).jpg"]);
});

test("macOS's narrow space before PM and file:// URLs", () => {
	assert.deepEqual(paths("/Users/me/Desktop/Screenshot 2026-11-01 at 6.51.30 PM.png"), ["/Users/me/Desktop/Screenshot 2026-11-01 at 6.51.30 PM.png"]);
	assert.deepEqual(paths("file:///Users/me/Pictures/a%20(1).jpg"), ["/Users/me/Pictures/a (1).jpg"]);
});

test("several paths, missing files and other extensions", () => {
	assert.deepEqual(paths("~/x.webp vs /Users/me/missing.png and /Users/me/x.txt\n/var/folders/T/pi-clipboard-1234.png."), [
		"/Users/me/x.webp",
		"/var/folders/T/pi-clipboard-1234.png",
	]);
	assert.deepEqual(paths("see src/logo.png or http://example.com/a.png"), []);
});

test("each path gets the number of its image; quotes stay", () => {
	const text = "'/Users/me/x.webp' then ~/x.webp and /var/folders/T/pi-clipboard-1234.png end";
	const found = findImagePaths(text, exists, "/Users/me");
	const numbers = new Map([
		["/Users/me/x.webp", 1],
		["/var/folders/T/pi-clipboard-1234.png", 2],
	]);
	assert.equal(
		markAttached(text, found, (p) => numbers.get(p)!),
		"'/Users/me/x.webp' [image 1 attached] then ~/x.webp [image 1 attached] and /var/folders/T/pi-clipboard-1234.png [image 2 attached] end",
	);
});
