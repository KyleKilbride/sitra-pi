// @ts-nocheck — deterministic scripted model for loop-foundation tests.
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

function script() {
	try {
		const parsed = JSON.parse(process.env.SITRA_LOOP_MODEL_SCRIPT || "[]");
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export default function (pi) {
	const faux = fauxProvider({
		provider: "sitra-loop-faux",
		models: [{ id: "script", contextWindow: 200000, maxTokens: 8000 }],
	});
	const steps = script();
	let next = 0;
	faux.setResponses(
		Array.from({ length: 50 }, () => () => {
			const step = steps[next++] ?? { text: "done" };
			if (step.tool?.name) {
				return fauxAssistantMessage(fauxToolCall(step.tool.name, step.tool.arguments ?? {}), { stopReason: "toolUse" });
			}
			return fauxAssistantMessage(typeof step.text === "string" ? step.text : "done");
		}),
	);
	pi.registerProvider(faux.provider);
}
