/**
 * Keeping long conversations sharp: pure functions (Pi wiring lives in `sharpen-pi.ts`). See docs/SHARPEN.md for
 * the evidence and the experiments behind what is here and what was left out.
 *
 * - Old, large tool output becomes a one-line stub (Anthropic's context editing). The boundary moves in batches so
 *   the earlier context, and the provider's prompt cache, stay stable.
 * - A helper's task carries the person's latest request and the rules that came up.
 * - A structured handover when the context gets long.
 */

/** The parts of a Pi message these functions read. */
export interface Msg {
	role: string;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	customType?: string;
	[key: string]: unknown;
}

type Part = { type?: string; text?: string; id?: string; name?: string; arguments?: unknown };

const parts = (m: Msg): Part[] =>
	typeof m.content === "string"
		? [{ type: "text", text: m.content }]
		: Array.isArray(m.content)
			? (m.content as Part[])
			: [];

const textOf = (m: Msg) =>
	parts(m)
		.filter((p) => p?.type === "text" && typeof p.text === "string")
		.map((p) => p.text as string)
		.join("\n");

const sizeOf = (m: Msg) => (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length);

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** A short description of a call's arguments: the path, command or query when there is one. */
function describeArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	const main = a.path ?? a.file_path ?? a.command ?? a.cmd ?? a.query ?? a.pattern ?? a.url ?? a.agent ?? a.action;
	if (typeof main === "string") return clip(main.replace(/\s+/g, " "), 120);
	return clip(JSON.stringify(a), 80);
}

export interface StubOptions {
	/** Tool results at the end that always stay whole. */
	keepRecent?: number;
	/** The stub boundary advances this many results at a time, so earlier context changes rarely. */
	batch?: number;
	/** Results smaller than this stay whole: stubbing them saves nothing. */
	minChars?: number;
}

/** Old, large tool results replaced by one-line stubs. Never mutates the input; message order and ids are unchanged. */
export function stubToolResults(
	messages: readonly Msg[],
	options: StubOptions = {},
): { messages: Msg[]; stubbed: number; savedChars: number } {
	const keepRecent = options.keepRecent ?? 20;
	const batch = Math.max(1, options.batch ?? 10);
	const minChars = options.minChars ?? 2_000;
	const results = messages.flatMap((m, i) => (m.role === "toolResult" ? [i] : []));
	const boundary = Math.max(0, Math.floor((results.length - keepRecent) / batch) * batch);
	if (boundary === 0) return { messages: [...messages], stubbed: 0, savedChars: 0 };
	const calls = new Map<string, { name: string; args: unknown }>();
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		for (const p of parts(m)) {
			if ((p?.type === "toolCall" || p?.type === "tool_use") && typeof p.id === "string") {
				calls.set(p.id, { name: p.name ?? "tool", args: p.arguments });
			}
		}
	}
	// Results of the latest batch of calls are always whole: the model hasn't seen them yet.
	const lastAssistant = messages.findLastIndex((m) => m.role === "assistant");
	const old = new Set(results.slice(0, boundary).filter((i) => i < lastAssistant));
	let stubbed = 0;
	let savedChars = 0;
	const out = messages.map((m, i) => {
		if (!old.has(i)) return m;
		const size = sizeOf(m);
		if (size < minChars) return m;
		const c = m.toolCallId ? calls.get(m.toolCallId) : undefined;
		const name = c?.name ?? m.toolName ?? "tool";
		const text = textOf(m);
		const lines = text ? text.split("\n").length : 0;
		const stub = `[sitra: this older output was cleared to keep the context sharp. ${name}(${describeArgs(c?.args)}) returned ${lines ? `${lines} lines, ` : ""}${size} characters${m.isError ? " (an error)" : ""}. Run it again if you need it.]`;
		stubbed++;
		savedChars += size - stub.length;
		return { ...m, content: [{ type: "text", text: stub }] };
	});
	return { messages: out, stubbed, savedChars };
}

/** Messages sitra or the harness sends as the user, not the person. */
const NOT_THE_PERSON = [
	/^Read AGENTS\.md, CLAUDE\.md/,
	/^Grimoire already had a rule for this/,
	/^Look back over this session/,
	/^\[sitra/,
];
const APPROVAL = /^(go|ok|okay|yes|yep|sure|thanks|thank you|do it|go ahead|merged|continue|k)[.! ]*$/i;

/**
 * The person's own messages in order, each clipped: approvals, one-word replies and sitra's own texts are left out.
 * Past `max`, the first is kept (the original task) with the most recent ones.
 */
export function personRequests(messages: readonly Msg[], options: { max?: number; chars?: number } = {}): string[] {
	const max = options.max ?? 8;
	const chars = options.chars ?? 400;
	const all: string[] = [];
	for (const m of messages) {
		if (m.role !== "user") continue;
		const t = textOf(m).trim();
		if (t.length < 4 || APPROVAL.test(t) || NOT_THE_PERSON.some((r) => r.test(t))) continue;
		all.push(clip(t.replace(/\n{3,}/g, "\n\n"), chars));
	}
	return all.length <= max ? all : [all[0] as string, ...all.slice(-(max - 1))];
}

/** Titles of Grimoire rules that paused an action in this session. */
export function rulesThatCameUp(messages: readonly Msg[]): string[] {
	const titles = new Set<string>();
	for (const m of messages) {
		if (m.role !== "toolResult") continue;
		const t = textOf(m);
		if (!t.startsWith("Paused once so these approved Grimoire rules")) continue;
		for (const match of t.matchAll(/^## \[\w+\] (.+)$/gm)) titles.add((match[1] as string).trim());
	}
	return [...titles];
}

/** What goes with a task the lead hands to a helper: the person's latest request and the rules that came up. */
export function helperBrief(messages: readonly Msg[]): string | undefined {
	const latest = personRequests(messages, { max: 1000, chars: 600 }).at(-1);
	if (!latest) return undefined;
	const rules = rulesThatCameUp(messages);
	const out = [
		"## Context from the lead's conversation (sitra, automatic)",
		"The person's latest request to the lead:",
		latest,
	];
	if (rules.length) out.push("Grimoire rules that came up:", ...rules.slice(0, 8).map((r) => `- ${clip(r, 140)}`));
	return clip(out.join("\n"), 2_000);
}

export class HandoverConfigError extends Error {
	override name = "HandoverConfigError";
}

/**
 * Context size at which to hand over: by default, 40% of the window, with the existing small-window floor (half the
 * window up to 32k, then at least 16k). `handoverTokens` in config.json may set an explicit positive-integer
 * threshold, but it may not be larger than the active model's context window; sitra must never hand over past it.
 */
export function handoverThreshold(contextWindow: number, handoverTokens?: number): number {
	if (handoverTokens !== undefined) {
		if (!Number.isInteger(handoverTokens) || handoverTokens <= 0) {
			throw new HandoverConfigError("handoverTokens in config.json must be a positive integer.");
		}
		if (handoverTokens > contextWindow) {
			throw new HandoverConfigError(
				`handoverTokens in config.json (${handoverTokens}) is larger than the active model's context window (${contextWindow}).`,
			);
		}
		return handoverTokens;
	}
	return Math.max(Math.floor(contextWindow * 0.4), Math.min(16_000, Math.floor(contextWindow / 2)));
}

/** What the handover summary must hold; passed to Pi's compaction as its instructions. */
export const HANDOVER_INSTRUCTIONS = [
	"This summary is a handover: the conversation continues in a fresh context that starts from it. Write it so a capable engineer who never saw the conversation can carry on without asking anything. Use these sections:",
	"1. Goal: what the person wants, quoting their own words verbatim where they matter.",
	"2. Standing instructions: every rule, preference or correction the person gave in this session, verbatim.",
	"3. Decisions and their reasons: what was decided, why, and what was ruled out.",
	"4. State: branch, files changed, commands that matter, pull request links, test results.",
	"5. Next steps: the concrete next actions, and anything waiting on the person.",
	"Be specific: names, paths, numbers. Leave out exploration that led nowhere unless it rules something out.",
].join("\n");

const REQUESTS_HEADING = "## The person's requests, verbatim (carried by sitra)";

/** One line of the transcript a handover summarises: requests and replies whole, calls by their main argument, results clipped. */
function transcriptLine(m: Msg): string | undefined {
	if (m.role === "compactionSummary" && typeof m.summary === "string") return `[Earlier handover]\n${m.summary}`;
	if (m.role === "user") return `Person: ${textOf(m)}`;
	if (m.role === "assistant") {
		const out = parts(m).flatMap((p) =>
			p?.type === "text" && p.text
				? [p.text]
				: p?.type === "toolCall" || p?.type === "tool_use"
					? [`→ ${p.name ?? "tool"} ${describeArgs(p.arguments)}`]
					: [],
		);
		return out.length ? `Agent: ${out.join("\n")}` : undefined;
	}
	if (m.role === "toolResult") return `Result${m.isError ? " (error)" : ""}: ${clip(textOf(m), 1_500)}`;
	return undefined;
}

/**
 * The prompt for a handover written by sitra (mid-run, where Pi's own compaction can't be steered): the handover
 * instructions and a compact transcript, the most recent part kept when it is too long.
 */
export function handoverPrompt(messages: readonly Msg[], maxChars = 300_000): string {
	let transcript = messages.flatMap((m) => transcriptLine(m) ?? []).join("\n\n");
	if (transcript.length > maxChars) transcript = `…\n${transcript.slice(-maxChars)}`;
	return `${HANDOVER_INSTRUCTIONS}\n\nThe conversation so far:\n\n${transcript}`;
}

/**
 * The handover the next context starts from: the model's summary, then the person's requests verbatim. The requests
 * are copied from the previous handover rather than summarised again, so they don't fade over many rounds.
 */
export function handoverSummary(reply: string, messages: readonly Msg[]): string {
	const carried: string[] = [];
	const previous = messages.findLast((m) => m.role === "compactionSummary" && typeof m.summary === "string");
	const section = (previous?.summary as string | undefined)?.split(REQUESTS_HEADING)[1];
	if (section) {
		for (const line of section.split("\n")) if (line.startsWith("- ")) carried.push(line.slice(2));
	}
	const all = [
		...new Set([...carried, ...personRequests(messages, { max: 1000, chars: 600 }).map((r) => r.replace(/\n+/g, " "))]),
	];
	const kept = all.length <= 12 ? all : [all[0] as string, ...all.slice(-11)];
	const body = reply.split(REQUESTS_HEADING)[0]?.trimEnd() ?? "";
	return kept.length ? `${body}\n\n${REQUESTS_HEADING}\n${kept.map((r) => `- ${r}`).join("\n")}` : body;
}
