/**
 * Clawd's holiday costumes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { COSTUMES, clawdArt, clawdFrame, costumeFor, easter } from "../extensions/provider-logo/clawd.ts";

const on = (day: string) => costumeFor(new Date(`${day}T12:00`));

test("finds Easter Sunday", () => {
	assert.equal(easter(2026).toDateString(), new Date(2026, 3, 5).toDateString());
	assert.equal(easter(2027).toDateString(), new Date(2027, 2, 28).toDateString());
});

test("dresses Clawd up on holidays", () => {
	assert.equal(on("2026-10-29"), "halloween");
	assert.equal(on("2026-12-01"), "christmas");
	assert.equal(on("2026-12-26"), "christmas");
	assert.equal(on("2026-12-31"), "newYear");
	assert.equal(on("2027-01-01"), "newYear");
	assert.equal(on("2027-02-14"), "valentine");
	// Weiberfastnacht to Shrove Tuesday 2027.
	assert.equal(on("2027-02-04"), "carnival");
	assert.equal(on("2027-02-09"), "carnival");
	assert.equal(on("2027-02-10"), undefined);
	// Good Friday to Easter Monday 2027.
	assert.equal(on("2027-03-26"), "easter");
	assert.equal(on("2027-03-29"), "easter");
	assert.equal(on("2027-06-01"), undefined);
});

test("every costume has a moving background", () => {
	for (const name of Object.keys(COSTUMES)) {
		process.env.PI_CLAWD_COSTUME = name;
		assert.ok(COSTUMES[name].backdrop?.pixels, name);
		assert.notDeepEqual(clawdFrame(30_000).art, clawdFrame(30_400).art, name);
	}
	delete process.env.PI_CLAWD_COSTUME;
});

test("every frame of a costume has the same size", () => {
	for (const name of Object.keys(COSTUMES)) {
		process.env.PI_CLAWD_COSTUME = name;
		const { hat, backdrop } = COSTUMES[name];
		const rest = clawdArt();
		assert.equal(rest.length, 6 + Math.max(0, hat.length - 1) + (backdrop?.top ?? 0), name);
		for (let time = 0; time < 20_000; time += 50) {
			const { art } = clawdFrame(time);
			assert.equal(art.length, rest.length, name);
			assert.ok(art.every((row) => row.length === 12 + (backdrop?.left ?? 0) + (backdrop?.right ?? 0)), name);
		}
	}
	process.env.PI_CLAWD_COSTUME = "none";
	assert.ok(clawdArt().every((row) => row.length === 12));
	assert.equal(clawdArt().length, 6);
	delete process.env.PI_CLAWD_COSTUME;
});

test("Gravi is round, hovers on a thruster flame and wears the costumes too", () => {
	process.env.PI_CLAWD_COSTUME = "none";
	const art = clawdArt("gravi");
	assert.deepEqual(art, [
		"............",
		"..oooooooo..",
		".oo.oooo.oo.",
		"oooooooooooo",
		"..oooooooo..",
		"....fhhf....",
	]);
	// It bobs: some idle frames are lifted, Clawd's are not.
	const lifts = Array.from({ length: 40 }, (_, i) => clawdFrame(20_000 + i * 50, "gravi").lift);
	assert.ok(Math.max(...lifts) > 0.3);
	for (const name of Object.keys(COSTUMES)) {
		process.env.PI_CLAWD_COSTUME = name;
		assert.equal(clawdArt("gravi").length, clawdArt().length, name);
	}
	delete process.env.PI_CLAWD_COSTUME;
});

test("the empty chat's header puts the extension list bottom left and the wishes bottom right, beside the logo", async () => {
	const { compose } = await import("../extensions/provider-logo/index.ts");
	const rows = compose(["LOGO"], 0, ["ext"], 3, 20, ["wish one", "two"])!;
	assert.deepEqual(rows, ["        LOGO", "           wish one", "ext             two"]);
	assert.equal(compose(["A-WIDE-LOGO-LINE"], 2, [], 3, 20, ["wishes"]), undefined, "no room beside the logo");
});
