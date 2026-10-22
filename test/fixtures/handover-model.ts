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
	const script = [
		fauxAssistantMessage("Noted."),
		call,
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit exceeded" }),
		fauxAssistantMessage("RECOVERED AFTER RETRY"),
	];
	const text = (m) =>
		typeof m?.content === "string" ? m.content : (m?.content ?? []).map((p) => p.text ?? "").join("");
	// sitra's mid-run handover asks the model for a summary; answer it without using up the script.
	const step = (context) =>
		text(context.messages.at(-1)).startsWith("This summary is a handover")
			? fauxAssistantMessage("1. Goal: test handover")
			: script.shift();
	faux.setResponses(Array.from({ length: 8 }, () => step));
	pi.registerProvider(faux.provider);
	pi.on("session_before_compact", (e) => ({
		compaction: {
			summary: "1. Goal: test handover",
			firstKeptEntryId: e.preparation.firstKeptEntryId,
			tokensBefore: e.preparation.tokensBefore,
		},
	}));
}
