/**
 * The end-of-reply PR check: a status reply that names a pull request the agent didn't look up this turn is checked
 * against GitHub before it goes out. Agents copy status lists forward from earlier replies; a rule in the prompt didn't
 * stop it, so this is a check in code. Matching links and commands here is agent tooling, not reading user meaning.
 */
import type { Msg } from "./sharpen.ts";

export interface PrState {
	url: string;
	state: string;
	mergedAt?: string;
}

const PR_LINK = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;

/** Each GitHub pull request link in `text`, normalised, once, in order. */
export function prLinks(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(PR_LINK)) {
		const url = `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`;
		if (!out.includes(url)) out.push(url);
	}
	return out;
}

/** Shell commands the agent ran since the person's last message. */
function commandsThisTurn(messages: readonly Msg[]): string[] {
	const start = messages.findLastIndex((m) => m.role === "user") + 1;
	const out: string[] = [];
	for (const m of messages.slice(start)) {
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const p of m.content as { type?: string; arguments?: unknown; input?: unknown }[]) {
			if (p?.type !== "toolCall" && p?.type !== "tool_use") continue;
			const args = (p.arguments ?? p.input) as Record<string, unknown> | undefined;
			const command = typeof args?.command === "string" ? args.command : JSON.stringify(args ?? "");
			out.push(command);
		}
	}
	return out;
}

/** The links whose state the agent looked up with `gh` this turn: by link or number, or a `gh pr list` of that repo. */
export function checkedInTurn(messages: readonly Msg[], links: readonly string[]): string[] {
	const gh = commandsThisTurn(messages).filter((c) => /\bgh\s+(pr|api|search)\b/.test(c));
	return links.filter((url) => {
		const [, , , owner, repo, , n] = url.split("/");
		return gh.some(
			(c) =>
				c.includes(url) ||
				(new RegExp(`\\bgh\\s+pr\\s+(view|status|checks)\\s+(#)?${n}\\b`).test(c) &&
					(!c.includes("--repo") || c.includes(`${owner}/${repo}`))) ||
				(/\bgh\s+pr\s+list\b/.test(c) && c.includes(`${owner}/${repo}`)),
		);
	});
}

/** The note back to the agent: facts about the PRs it named that are merged or closed. Nothing when all are open. */
export function correctionNote(states: readonly PrState[]): string | undefined {
	const done = states.filter((s) => s.state === "MERGED" || s.state === "CLOSED");
	if (!done.length) return undefined;
	const lines = done.map((s) =>
		s.state === "MERGED"
			? `- ${s.url} is merged${s.mergedAt ? ` (${s.mergedAt.slice(0, 10)})` : ""}.`
			: `- ${s.url} is closed without merging.`,
	);
	return [
		"sitra checked the live state of pull requests in your reply that you had not checked this turn:",
		...lines,
		"If your reply lists any of these as open, in progress or waiting on review, send a corrected reply. Otherwise repeat your reply unchanged.",
	].join("\n");
}
