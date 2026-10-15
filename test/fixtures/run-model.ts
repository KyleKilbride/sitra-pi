// @ts-nocheck — scripted model: starts one quick run in a pane, then answers "ok" to everything after.
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
				ctx.messages.filter((m) => m.role === "assistant").length === 0
					? fauxAssistantMessage(
							fauxToolCall("run_in_pane", { command: "echo quick-run-output; exit 2", label: "quick run" }),
							{
								stopReason: "toolUse",
							},
						)
					: fauxAssistantMessage("ok"),
		),
	);
	pi.registerProvider(faux.provider);
}
