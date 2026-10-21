// @ts-nocheck — a zero-cost scripted model for the end-of-reply PR check e2e test: it names a PR as waiting, then corrects itself only if sitra's note arrives.
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
export default function (pi) {
	const faux = fauxProvider({
		provider: "sitra-faux",
		models: [{ id: "replycheck", contextWindow: 200_000, maxTokens: 4000 }],
	});
	const text = (m) =>
		typeof m?.content === "string" ? m.content : (m?.content ?? []).map((p) => p.text ?? "").join("");
	const step = (context) => {
		const all = context.messages.map(text).join("\n");
		return all.includes("is merged")
			? fauxAssistantMessage("CORRECTED: https://github.com/acme/app/pull/7 is merged.")
			: fauxAssistantMessage("Waiting on you: review https://github.com/acme/app/pull/7");
	};
	faux.setResponses(Array.from({ length: 6 }, () => step));
	pi.registerProvider(faux.provider);
}
