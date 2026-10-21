/**
 * Pi wiring for the end-of-reply PR check (see `replycheck.ts`). At `agent_before_settle`, before the reply is final,
 * PR links the agent didn't look up this turn are checked with `gh`; if any is merged or closed, the agent gets one
 * factual note and one more turn. At most once per run, so the corrected reply always goes through. Fails open.
 * `SITRA_REPLY_CHECK=0` turns it off.
 */
import { execFile } from "node:child_process";
import { checkedInTurn, correctionNote, type PrState, prLinks } from "./replycheck.ts";
import type { Msg } from "./sharpen.ts";

interface Pi {
	on(event: string, handler: (event: never, ctx: unknown) => unknown): void;
}
interface Deps {
	lookup(url: string): Promise<PrState>;
}
interface Settle {
	outcome?: string;
	context?: { contextMessages?: Msg[] };
}

function ghLookup(url: string): Promise<PrState> {
	return new Promise((resolve, reject) => {
		execFile("gh", ["pr", "view", url, "--json", "state,mergedAt"], { timeout: 10_000 }, (error, stdout) => {
			if (error) return reject(error);
			try {
				const r = JSON.parse(stdout) as { state?: string; mergedAt?: string | null };
				resolve({ url, state: String(r.state ?? ""), mergedAt: r.mergedAt ?? undefined });
			} catch (e) {
				reject(e);
			}
		});
	});
}

function textOf(m: Msg | undefined): string {
	if (!m) return "";
	if (typeof m.content === "string") return m.content;
	return Array.isArray(m.content)
		? (m.content as { type?: string; text?: string }[])
				.filter((p) => p?.type === "text")
				.map((p) => p.text ?? "")
				.join("\n")
		: "";
}

export default function replyCheck(pi: Pi, deps: Deps = { lookup: ghLookup }): void {
	let nudged = false;
	const reset = () => {
		nudged = false;
	};
	pi.on("before_agent_start", reset);
	pi.on("session_start", reset);

	pi.on("agent_before_settle", async (event: Settle) => {
		try {
			if (process.env.SITRA_REPLY_CHECK === "0" || nudged) return undefined;
			if (event?.outcome !== "completed") return undefined;
			const messages = event.context?.contextMessages ?? [];
			const reply = messages.findLast((m) => m.role === "assistant");
			const links = prLinks(textOf(reply)).slice(0, 15);
			if (!links.length) return undefined;
			const checked = checkedInTurn(messages, links);
			const unchecked = links.filter((l) => !checked.includes(l));
			if (!unchecked.length) return undefined;
			const settled = await Promise.allSettled(unchecked.map((l) => deps.lookup(l)));
			const states = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
			const note = correctionNote(states);
			if (!note) return undefined;
			nudged = true;
			return {
				entries: [{ type: "custom_message", customType: "sitra-reply-check", content: note, display: true }],
				continue: true,
			};
		} catch {
			return undefined;
		}
	});
}
