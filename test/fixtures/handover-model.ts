// @ts-nocheck — a zero-cost scripted model for the handover e2e test: a first turn, then one large tool call, a retryable error, and a reply.
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
export default function (pi) {
	const faux = fauxProvider({
		provider: "sitra-faux",
		models: [{ id: "handover", contextWindow: 1_000_000, maxTokens: 8000 }],
	});
	const call = fauxAssistantMessage(fauxToolCall("read", { path: process.env.SITRA_TEST_FILE }), {
		stopReason: "toolUse",
	});
	call.usage = { ...call.usage, input: 170_000, totalTokens: 170_000 };
	faux.setResponses([
		fauxAssistantMessage("Noted."),
		call,
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit exceeded" }),
		fauxAssistantMessage("RECOVERED AFTER RETRY"),
	]);
	pi.registerProvider(faux.provider);
	pi.on("session_before_compact", (e) => ({
		compaction: {
			summary: "1. Goal: test handover",
			firstKeptEntryId: e.preparation.firstKeptEntryId,
			tokensBefore: e.preparation.tokensBefore,
		},
	}));
}
