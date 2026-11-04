import assert from "node:assert/strict";
import { test } from "node:test";
import { usageFromGetUsage, usageFromRateLimitEvent } from "../extensions/claude-code/usage.ts";
import { formatDuration, formatTokens } from "../extensions/shared/format.ts";

test("get_usage reports percent and ISO reset times", () => {
	const usage = usageFromGetUsage({
		rate_limits_available: true,
		subscription_type: "team",
		rate_limits: {
			five_hour: { utilization: 42.5, resets_at: "2026-10-28T15:40:00Z" },
			seven_day: { utilization: 30 },
		},
	});
	assert.equal(usage?.session?.percent, 42.5);
	assert.equal(usage?.session?.resetsAt, Date.parse("2026-10-28T15:40:00Z"));
	assert.equal(usage?.weekly?.percent, 30);
	assert.equal(usage?.subscriptionType, "team");
});

test("get_usage without limits gives nothing", () => {
	assert.equal(usageFromGetUsage({ rate_limits_available: false }), undefined);
});

test("rate limit events report fractions and keep what they leave out", () => {
	const previous = usageFromGetUsage({ rate_limits_available: true, rate_limits: { seven_day: { utilization: 30 } } });
	const usage = usageFromRateLimitEvent({ unifiedWindows: { five_hour: { utilization: 0.25, resets_at: 2e9 } } }, previous);
	assert.equal(usage?.session?.percent, 25);
	assert.equal(usage?.session?.resetsAt, 2e12);
	assert.equal(usage?.weekly?.percent, 30);
});

test("formatting", () => {
	assert.equal(formatDuration(0), "now");
	assert.equal(formatDuration(3 * 3600_000 + 16 * 60_000), "3hr 16m");
	assert.equal(formatDuration(26 * 3600_000), "1d 2hr");
	assert.equal(formatTokens(950), "950");
	assert.equal(formatTokens(3400), "3.4k");
	assert.equal(formatTokens(1_250_000), "1.25M");
});
