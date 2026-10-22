// @ts-nocheck — deterministic scripted model for loop-foundation tests.
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

function script() {
	try {
		const parsed = JSON.parse(process.env.SITRA_LOOP_MODEL_SCRIPT || "[]");
		return Array.isArray(parsed) ? parsed : [];
	} catch (error) {
		throw new Error(`Invalid SITRA_LOOP_MODEL_SCRIPT: ${String(error)}`);
	}
}

function autoHelpers() {
	try {
		const parsed = JSON.parse(process.env.SITRA_LOOP_AUTO_HELPERS || "[]");
		return Array.isArray(parsed) ? parsed : [];
	} catch (error) {
		throw new Error(`Invalid SITRA_LOOP_AUTO_HELPERS: ${String(error)}`);
	}
}

function textFrom(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

export default function (pi) {
	const faux = fauxProvider({
		provider: "sitra-loop-faux",
		models: [{ id: "script", contextWindow: 200000, maxTokens: 8000 }],
	});
	const steps = script();
	const helpers = autoHelpers();
	const sentHelpers = new Set();
	let next = 0;
	faux.setResponses(
		Array.from({ length: 50 }, () => () => {
			const step = steps[next++];
			if (!step) throw new Error("SITRA_LOOP_MODEL_SCRIPT ran out of steps");
			if (Array.isArray(step.customMessages)) {
				for (const details of step.customMessages) {
					void pi.sendMessage(
						{ customType: "subagent_result", content: "helper finished", display: false, details },
						{ deliverAs: "followUp", streamingBehavior: "followUp" },
					);
				}
			}
			if (step.tool?.name) {
				return fauxAssistantMessage(fauxToolCall(step.tool.name, step.tool.arguments ?? {}), { stopReason: "toolUse" });
			}
			return fauxAssistantMessage(typeof step.text === "string" ? step.text : "done");
		}),
	);
	pi.registerProvider(faux.provider);
	pi.on("message_end", async (event) => {
		const text = textFrom(event.message);
		if (!text) return;
		const index = helpers.findIndex(
			(helper, i) => !sentHelpers.has(i) && typeof helper?.when === "string" && text.includes(helper.when),
		);
		if (index < 0) return;
		sentHelpers.add(index);
		const batch = helpers[index]?.messages;
		if (!Array.isArray(batch)) return;
		for (const details of batch) {
			await pi.sendMessage(
				{ customType: "subagent_result", content: "helper finished", display: false, details },
				{ deliverAs: "followUp", streamingBehavior: "followUp" },
			);
		}
	});
}
