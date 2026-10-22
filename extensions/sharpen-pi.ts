/**
 * sitra's Pi wiring for keeping long conversations sharp (see `sharpen.ts` for the why). Before every model call, old
 * tool output is stubbed; a lead's tasks for helpers carry the person's latest request; when a run ends with the context past the handover threshold, Pi compacts it into a structured handover
 * (also `/handover`), saved under `<profile>/handovers/`. The handover waits for `agent_settled`, after Pi's own retries. Nothing here may stop a turn: every handler fails open.
 * `SITRA_SHARPEN=0` turns it all off.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	HANDOVER_INSTRUCTIONS,
	HandoverConfigError,
	handoverPrompt,
	handoverSummary,
	handoverThreshold,
	helperBrief,
	type Msg,
	stubToolResults,
	validateHandoverTokens,
} from "./sharpen.ts";

interface Ctx {
	hasUI?: boolean;
	ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
	getContextUsage?(): { tokens: number | null; contextWindow: number } | undefined;
	compact?(options?: { customInstructions?: string }): void;
	sessionManager?: { getBranch?(): { type?: string; message?: Msg }[]; getSessionId?(): string };
	model?: unknown;
	signal?: AbortSignal;
	modelRegistry?: {
		complete(model: unknown, context: { messages: unknown[] }, options?: Record<string, unknown>): Promise<Msg>;
	};
}

interface TurnEnd {
	message?: Msg;
	messageEntryId?: string;
	outcome?: string;
	context?: { contextMessages?: Msg[] };
}

interface Pi {
	on(event: string, handler: (event: never, ctx: Ctx) => unknown): void;
	registerCommand(name: string, command: { description: string; handler(args: string, ctx: Ctx): Promise<void> }): void;
}

const on = () => process.env.SITRA_SHARPEN !== "0";
const isHelper = () => Boolean(process.env.PI_SUBAGENT_NAME);
const BRIEF_MARK = "## Context from the lead's conversation";

/**
 * Handover summaries can spend output tokens on hidden provider reasoning before visible text. Keep the budget high,
 * and force low provider-level effort or a small thinking budget so thinking leaves room for the summary. Any length
 * stop is still a failed checkpoint.
 */
export const HANDOVER_MAX_TOKENS = 32_000;
const HANDOVER_REASONING = "low";
const HANDOVER_THINKING_BUDGET_TOKENS = 1_024;

class HandoverSummaryError extends Error {
	override name = "HandoverSummaryError";
	readonly stopReason: string;
	constructor(message: string, stopReason: string) {
		super(message);
		this.stopReason = stopReason;
	}
}

function handoverFailureDetails(error: unknown): string {
	if (error instanceof HandoverSummaryError) return `${error.message}; stop reason: ${error.stopReason}`;
	return `${String(error).slice(0, 100)}; stop reason unavailable`;
}

function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function lowerAnthropicHandoverEffort(payload: unknown, model: unknown): Record<string, unknown> | undefined {
	if (!record(model) || model.api !== "anthropic-messages" || !record(payload)) return undefined;
	const thinking = payload.thinking;
	if (!record(thinking) || thinking.type !== "adaptive") return undefined;
	const outputConfig = record(payload.output_config) ? payload.output_config : {};
	const messages = Array.isArray(payload.messages)
		? payload.messages.map((message) =>
				record(message) && record(message.output_config)
					? { ...message, output_config: { ...message.output_config, effort: HANDOVER_REASONING } }
					: message,
			)
		: payload.messages;
	return {
		...payload,
		messages,
		output_config: { ...outputConfig, effort: HANDOVER_REASONING },
	};
}

export function configuredHandoverTokens(): number | undefined {
	const raw = process.env.SITRA_HANDOVER_TOKENS;
	if (raw === undefined) return undefined;
	return validateHandoverTokens(raw, "SITRA_HANDOVER_TOKENS");
}

function currentHandoverThreshold(contextWindow: number): number {
	const raw = process.env.SITRA_HANDOVER_TOKENS;
	return raw === undefined
		? handoverThreshold(contextWindow)
		: handoverThreshold(contextWindow, raw, "SITRA_HANDOVER_TOKENS");
}

function failLoudlyOnHandoverConfig(error: unknown, ctx: Ctx): void {
	if (error instanceof HandoverConfigError) {
		ctx.ui?.notify(error.message, "error");
		throw error;
	}
}

function modelContextWindow(model: unknown): number | undefined {
	return model && typeof model === "object" && typeof (model as { contextWindow?: unknown }).contextWindow === "number"
		? (model as { contextWindow: number }).contextWindow
		: undefined;
}

function validateConfiguredThreshold(ctx: Ctx, model?: unknown): void {
	const raw = process.env.SITRA_HANDOVER_TOKENS;
	if (raw === undefined) return;
	const window = modelContextWindow(model) ?? modelContextWindow(ctx.model);
	if (window === undefined) {
		configuredHandoverTokens();
		return;
	}
	currentHandoverThreshold(window);
}

function branchMessages(ctx: Ctx): Msg[] {
	return (ctx.sessionManager?.getBranch?.() ?? []).flatMap((e) =>
		e?.type === "message" && e.message ? [e.message] : [],
	);
}

function withBrief(task: unknown, brief: string): unknown {
	if (typeof task !== "string" || task.includes(BRIEF_MARK)) return task;
	return `${task}\n\n${brief}`;
}

function addBriefToChild(input: Record<string, unknown>, brief: string): void {
	if (input.agent === "verifier") return;
	if (typeof input.task === "string") input.task = withBrief(input.task, brief);
}

/** Asks the session's model for a handover of `messages`; throws when no usable summary comes back. */
async function writeHandover(ctx: Ctx, messages: Msg[], signal?: AbortSignal): Promise<string> {
	if (!ctx.model || !ctx.modelRegistry) throw new Error("no model");
	const reply = await ctx.modelRegistry.complete(
		ctx.model,
		{
			messages: [{ role: "user", content: [{ type: "text", text: handoverPrompt(messages) }], timestamp: Date.now() }],
		},
		{
			maxTokens: HANDOVER_MAX_TOKENS,
			reasoning: HANDOVER_REASONING,
			effort: HANDOVER_REASONING,
			thinkingEnabled: true,
			thinkingBudgetTokens: HANDOVER_THINKING_BUDGET_TOKENS,
			onPayload: lowerAnthropicHandoverEffort,
			signal,
		},
	);
	const stopReason = typeof reply?.stopReason === "string" ? reply.stopReason : "unknown";
	const text = Array.isArray(reply?.content)
		? (reply.content as { type?: string; text?: string }[])
				.filter((p) => p?.type === "text")
				.map((p) => p.text)
				.join("\n")
				.trim()
		: "";
	if (!text) throw new HandoverSummaryError("no summary came back", stopReason);
	if (reply.stopReason === "error" || reply.stopReason === "aborted" || reply.stopReason === "length") {
		throw new HandoverSummaryError("summary stopped before completion", stopReason);
	}
	return handoverSummary(text, messages);
}

function saveHandover(summary: string, ctx: Ctx): void {
	try {
		const dir = join(process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent"), "handovers");
		mkdirSync(dir, { recursive: true });
		const id = ctx.sessionManager?.getSessionId?.() ?? "session";
		writeFileSync(
			join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${id.replace(/[^\w.-]/g, "_")}.md`),
			`${summary}\n`,
		);
	} catch {
		// The handover is in the session either way; the file is a convenience.
	}
}

export default function sitraSharpen(pi: Pi): void {
	pi.on("context", (event: { messages?: unknown }) => {
		try {
			if (!on() || !Array.isArray(event?.messages)) return undefined;
			const messages = (event.messages as unknown[]).filter(
				(m): m is Msg => !!m && typeof m === "object" && typeof (m as Msg).role === "string",
			);
			const { messages: sharpened, stubbed } = stubToolResults(messages);
			return stubbed === 0 ? undefined : { messages: sharpened };
		} catch {
			return undefined;
		}
	});

	pi.on("tool_call", (event: { toolName?: string; input?: Record<string, unknown> | null }, ctx) => {
		try {
			if (!on() || isHelper() || event?.toolName !== "subagent" || !event.input || typeof event.input !== "object")
				return undefined;
			const brief = helperBrief(branchMessages(ctx));
			if (!brief) return undefined;
			const input = event.input;
			addBriefToChild(input, brief);
			if (Array.isArray(input.children)) {
				for (const child of input.children as Record<string, unknown>[]) {
					if (child && typeof child === "object") addBriefToChild(child, brief);
				}
			}
		} catch {
			// A hand-off goes out as written.
		}
		return undefined;
	});

	const handOver = (ctx: Ctx, why: string) => {
		ctx.ui?.notify(`${why} Handing over to a fresh context: goal, decisions and progress carry over.`, "info");
		ctx.compact?.({ customInstructions: HANDOVER_INSTRUCTIONS });
	};

	/**
	 * One automatic handover per crossing: after one, the context must fall back below the line before another, so a
	 * handover that can't get under it (a small window, little to summarise) never repeats every turn.
	 */
	let armed = true;
	let piCompactionFailureNoticeArmed = true;
	pi.on("session_start", (_event: unknown, ctx) => {
		armed = true;
		piCompactionFailureNoticeArmed = true;
		try {
			validateConfiguredThreshold(ctx);
		} catch (error) {
			failLoudlyOnHandoverConfig(error, ctx);
		}
	});

	pi.on("model_select", (event: { model?: unknown }, ctx) => {
		try {
			validateConfiguredThreshold(ctx, event?.model);
		} catch (error) {
			failLoudlyOnHandoverConfig(error, ctx);
		}
	});

	// After Pi has finished its own retries, recovery and follow-ups: compacting earlier (at agent_end) would abort them.
	pi.on("agent_settled", (event: { aborted?: boolean }, ctx) => {
		try {
			// `aborted` arrived in Pi 1.1.0; without it there is no proof the run finished cleanly, so no automatic handover.
			if (!on() || isHelper() || event?.aborted !== false) return;
			const usage = ctx.getContextUsage?.();
			if (!usage?.tokens || !usage.contextWindow) return;
			// A single huge turn has nothing earlier to summarise; Pi would only report "nothing to compact".
			const turns = branchMessages(ctx).filter((m) => m.role === "user").length;
			const over = usage.tokens >= currentHandoverThreshold(usage.contextWindow);
			if (!over) {
				armed = true;
				piCompactionFailureNoticeArmed = true;
			}
			if (over && armed && turns >= 2) {
				armed = false;
				handOver(ctx, `The conversation reached ${Math.round(usage.tokens / 1000)}k tokens.`);
			}
		} catch (error) {
			failLoudlyOnHandoverConfig(error, ctx);
			// The session carries on; Pi's own compaction still applies near the limit.
		}
	});

	pi.on("session_compact", (event: { compactionEntry?: { summary?: string }; fromExtension?: boolean }, ctx) => {
		const summary = event?.compactionEntry?.summary;
		if (on() && event?.fromExtension === true && summary) saveHandover(summary, ctx);
	});

	/**
	 * Mid-run: a turn that ends with tool calls past the line is followed by a handover compaction, and the run carries
	 * on from it. This is what keeps a long autonomous run (a loop step) sharp: the run-end handover never fires there,
	 * and Pi's own compaction waits until the window is nearly full. The latest call and its results stay whole.
	 */
	pi.on("turn_end", async (event: TurnEnd, ctx) => {
		try {
			if (!on() || event?.outcome !== "completed" || !event.messageEntryId || !event.message) return undefined;
			const working =
				Array.isArray(event.message.content) &&
				event.message.content.some((p: { type?: string }) => p?.type === "toolCall");
			if (!working) return undefined;
			const usage = ctx.getContextUsage?.();
			if (!usage?.tokens || !usage.contextWindow) return undefined;
			const over = usage.tokens >= currentHandoverThreshold(usage.contextWindow);
			if (!over) {
				armed = true;
				piCompactionFailureNoticeArmed = true;
			}
			if (!over || !armed || !ctx.model || !ctx.modelRegistry) return undefined;
			const messages = event.context?.contextMessages ?? [];
			const cut = messages.lastIndexOf(event.message);
			const earlier = cut >= 0 ? messages.slice(0, cut) : messages.slice(0, -1);
			if (earlier.length < 4) return undefined;
			armed = false;
			ctx.ui?.notify(
				`The run reached ${Math.round(usage.tokens / 1000)}k tokens. Handing over to a fresh context and carrying on.`,
				"info",
			);
			let summary: string;
			try {
				summary = await writeHandover(ctx, earlier, ctx.signal);
			} catch (error) {
				ctx.ui?.notify(`sitra couldn't hand over (${handoverFailureDetails(error)}); carrying on as is.`, "warning");
				return undefined;
			}
			saveHandover(summary, ctx);
			return { entries: [{ type: "compaction", summary, firstKeptEntryId: event.messageEntryId }] };
		} catch (error) {
			failLoudlyOnHandoverConfig(error, ctx);
			return undefined;
		}
	});

	/**
	 * Pi's compaction path is a backstop only for overflow. Threshold handovers and `/handover` use sitra's format or
	 * cancel compaction visibly; after one threshold failure, cancel without another model call until the context drops
	 * below the line. Overflow may fall back to Pi's default summary, but that default is never saved as a handover file.
	 */
	pi.on(
		"session_before_compact",
		async (
			event: {
				reason?: string;
				customInstructions?: string;
				signal?: AbortSignal;
				preparation?: {
					firstKeptEntryId?: string;
					tokensBefore?: number;
					previousSummary?: string;
					messagesToSummarize?: Msg[];
					turnPrefixMessages?: Msg[];
				};
			},
			ctx,
		) => {
			try {
				const prep = event?.preparation;
				const ours =
					event?.reason === "threshold" ||
					event?.reason === "overflow" ||
					event?.customInstructions === HANDOVER_INSTRUCTIONS;
				if (!on() || !ours || !prep?.firstKeptEntryId) return undefined;
				if (event?.reason === "threshold" && !piCompactionFailureNoticeArmed) return { cancel: true };
				const messages: Msg[] = [
					...(prep.previousSummary ? [{ role: "compactionSummary", summary: prep.previousSummary }] : []),
					...(prep.messagesToSummarize ?? []),
					...(prep.turnPrefixMessages ?? []),
				];
				const summary = await writeHandover(ctx, messages, event.signal);
				return {
					compaction: { summary, firstKeptEntryId: prep.firstKeptEntryId, tokensBefore: prep.tokensBefore ?? 0 },
				};
			} catch (error) {
				const reason = event?.reason;
				const detail = handoverFailureDetails(error);
				if (reason === "overflow") {
					ctx.ui?.notify(
						`sitra couldn't hand over (${detail}); Pi's default summary was used and no handover was saved.`,
						"warning",
					);
					return undefined;
				}
				if (reason !== "threshold" || piCompactionFailureNoticeArmed) {
					ctx.ui?.notify(`sitra couldn't hand over (${detail}); compaction was cancelled.`, "warning");
					if (reason === "threshold") piCompactionFailureNoticeArmed = false;
				}
				return { cancel: true };
			}
		},
	);

	pi.registerCommand("handover", {
		description: "Hand over to a fresh context now: a structured summary of goal, decisions and progress",
		handler: async (_args, ctx) => handOver(ctx, "Handover requested."),
	});
}
