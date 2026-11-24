import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { CodexClient } from "./client.ts";
import { runTurn, type TurnEvents, type TurnOptions } from "./turn.ts";

export function streamTurn(
	model: Model<Api>,
	opts: TurnOptions,
	client: CodexClient,
	observers: Omit<TurnEvents, "delta" | "end">,
) {
	const stream = createAssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: Date.now(),
		stopReason: "pending",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const open = new Map<string, number>();
	let baseline: Record<string, number> | undefined;
	const end = (key: string) => {
		const contentIndex = open.get(key);
		if (contentIndex === undefined) return;
		open.delete(key);
		const block = output.content[contentIndex];
		if (block.type === "text") stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
		if (block.type === "thinking") stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
	};
	void (async () => {
		try {
			stream.push({ type: "start", partial: output });
			const result = await runTurn(client, opts, {
				...observers,
				delta(key, kind, delta) {
					let contentIndex = open.get(key);
					if (contentIndex === undefined) {
						contentIndex = output.content.length;
						open.set(key, contentIndex);
						output.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
						stream.push({ type: kind === "text" ? "text_start" : "thinking_start", contentIndex, partial: output });
					}
					const block = output.content[contentIndex];
					if (block.type === "text") block.text += delta;
					if (block.type === "thinking") block.thinking += delta;
					stream.push({ type: kind === "text" ? "text_delta" : "thinking_delta", contentIndex, delta, partial: output });
				},
				end,
				resolved(name) {
					output.responseModel = name;
					observers.resolved?.(name);
				},
				usage(last, total, window) {
					// Codex gives cumulative thread usage and the last inference. Sum all inferences of this turn.
					baseline ??= Object.fromEntries(Object.keys(total).map((key) => [key, (total[key] || 0) - (last[key] || 0)]));
					const n = (key: string) => Math.max(0, (total[key] || 0) - (baseline?.[key] ?? 0));
					output.usage.cacheRead = n("cachedInputTokens");
					output.usage.cacheWrite = n("cacheWriteInputTokens");
					output.usage.input = Math.max(0, n("inputTokens") - output.usage.cacheRead - output.usage.cacheWrite);
					output.usage.output = n("outputTokens");
					output.usage.totalTokens = n("totalTokens");
					observers.usage?.(last, total, window);
				},
			});
			for (const key of open.keys()) end(key);
			output.responseId = result.responseId;
			output.stopReason = "stop";
			stream.push({ type: "done", reason: "stop", message: output });
		} catch (error) {
			for (const key of open.keys()) end(key);
			output.stopReason = opts.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
		} finally {
			if (output.stopReason !== "stop" || !opts.park) client.close();
			stream.end();
		}
	})();
	return stream;
}
