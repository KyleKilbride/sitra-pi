/**
 * sitra's Pi wiring for keeping long conversations sharp (see `sharpen.ts` for the why). Before every model call, old
 * tool output is stubbed; a lead's tasks for helpers carry the person's latest request; when a run ends with the context past the handover threshold, Pi compacts it into a structured handover
 * (also `/handover`), saved under `<profile>/handovers/`. The handover waits for `agent_settled`, after Pi's own retries. Nothing here may stop a turn: every handler fails open.
 * `SITRA_SHARPEN=0` turns it all off.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HANDOVER_INSTRUCTIONS, handoverThreshold, helperBrief, type Msg, stubToolResults } from "./sharpen.ts";

interface Ctx {
	hasUI?: boolean;
	ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
	getContextUsage?(): { tokens: number | null; contextWindow: number } | undefined;
	compact?(options?: { customInstructions?: string }): void;
	sessionManager?: { getBranch?(): { type?: string; message?: Msg }[]; getSessionId?(): string };
}

interface Pi {
	on(event: string, handler: (event: never, ctx: Ctx) => unknown): void;
	registerCommand(name: string, command: { description: string; handler(args: string, ctx: Ctx): Promise<void> }): void;
}

const on = () => process.env.SITRA_SHARPEN !== "0";
const isHelper = () => Boolean(process.env.PI_SUBAGENT_NAME);
const BRIEF_MARK = "## Context from the lead's conversation";

function branchMessages(ctx: Ctx): Msg[] {
	return (ctx.sessionManager?.getBranch?.() ?? []).flatMap((e) =>
		e?.type === "message" && e.message ? [e.message] : [],
	);
}

function withBrief(task: unknown, brief: string): unknown {
	if (typeof task !== "string" || task.includes(BRIEF_MARK)) return task;
	return `${task}\n\n${brief}`;
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
			if (typeof input.task === "string") input.task = withBrief(input.task, brief);
			if (Array.isArray(input.children)) {
				for (const child of input.children as Record<string, unknown>[]) {
					if (child && typeof child === "object") child.task = withBrief(child.task, brief);
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

	// After Pi has finished its own retries, recovery and follow-ups: compacting earlier (at agent_end) would abort them.
	pi.on("agent_settled", (event: { aborted?: boolean }, ctx) => {
		try {
			// `aborted` arrived in Pi 1.1.0; without it there is no proof the run finished cleanly, so no automatic handover.
			if (!on() || isHelper() || event?.aborted !== false) return;
			const usage = ctx.getContextUsage?.();
			if (!usage?.tokens || !usage.contextWindow) return;
			// A single huge turn has nothing earlier to summarise; Pi would only report "nothing to compact".
			const turns = branchMessages(ctx).filter((m) => m.role === "user").length;
			if (usage.tokens >= handoverThreshold(usage.contextWindow) && turns >= 2) {
				handOver(ctx, `The conversation reached ${Math.round(usage.tokens / 1000)}k tokens.`);
			}
		} catch {
			// The session carries on; Pi's own compaction still applies near the limit.
		}
	});

	pi.on("session_compact", (event: { compactionEntry?: { summary?: string } }, ctx) => {
		try {
			const summary = event?.compactionEntry?.summary;
			if (!on() || !summary) return;
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
	});

	pi.registerCommand("handover", {
		description: "Hand over to a fresh context now: a structured summary of goal, decisions and progress",
		handler: async (_args, ctx) => handOver(ctx, "Handover requested."),
	});
}
