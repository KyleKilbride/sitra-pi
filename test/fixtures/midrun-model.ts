// @ts-nocheck — a zero-cost scripted model for the mid-run handover e2e test: repeated tool calls, a handover summary when asked, then a final reply that reports what it could see.
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
export default function (pi) {
	const faux = fauxProvider({
		provider: "sitra-faux",
		models: [{ id: "midrun", contextWindow: 1_000_000, maxTokens: 8000 }],
	});
	let calls = 0;
	const text = (m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => p.text ?? "").join(""));
	const step = (context) => {
		const all = context.messages.map(text).join("\n");
		if (text(context.messages.at(-1) ?? {}).startsWith("This summary is a handover"))
			return fauxAssistantMessage("1. Goal: MIDRUN SUMMARY");
		calls++;
		if (calls <= 5) {
			return fauxAssistantMessage(fauxToolCall("read", { path: process.env.SITRA_TEST_FILE }), {
				stopReason: "toolUse",
			});
		}
		return fauxAssistantMessage(
			`FINAL summary=${all.includes("MIDRUN SUMMARY")} request=${all.includes("Keep going until done")}`,
		);
	};
	faux.setResponses(Array.from({ length: 12 }, () => step));
	pi.registerProvider(faux.provider);
}
