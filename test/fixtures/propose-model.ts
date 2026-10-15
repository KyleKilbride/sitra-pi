// @ts-nocheck — a zero-cost scripted model for the e2e test: it proposes one entry, then stops.
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
export default function (pi) {
	const faux = fauxProvider({
		provider: "sitra-faux",
		models: [{ id: "script", contextWindow: 200000, maxTokens: 8000 }],
	});
	faux.setResponses(
		Array.from(
			{ length: 20 },
			() => (ctx) =>
				ctx.messages.some((m) => m.role === "toolResult")
					? fauxAssistantMessage("done")
					: fauxAssistantMessage(
							fauxToolCall("kb_propose", {
								kind: "warning",
								title: "Never force-push a colleague's branch",
								body: "It happened on Oct 8.",
								evidence: "POSTMORTEM section 3",
							}),
							{ stopReason: "toolUse" },
						),
		),
	);
	pi.registerProvider(faux.provider);
}
