import { mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { HANDOVER_INSTRUCTIONS, type Msg } from "../extensions/sharpen.ts";
import sitraSharpen from "../extensions/sharpen-pi.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	sitraSharpen({
		on: (n: string, h: Handler) => handlers.set(n, h),
		registerCommand: (n: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(n, c),
	} as never);
	return { handlers, commands };
}

const user = (text: string): Msg => ({ role: "user", content: [{ type: "text", text }] });
function longSession(): Msg[] {
	const out: Msg[] = [user("Fix the date parser. Don't run the full suite.")];
	for (let i = 0; i < 50; i++) {
		out.push({
			role: "assistant",
			content: [{ type: "toolCall", id: `c${i}`, name: "read", arguments: { path: `f${i}.ts` } }],
		});
		out.push({
			role: "toolResult",
			toolCallId: `c${i}`,
			toolName: "read",
			content: [{ type: "text", text: "x\n".repeat(2_000) }],
		});
	}
	return out;
}

afterEach(() => vi.unstubAllEnvs());

describe("every model call", () => {
	test("old tool output is stubbed, without touching the saved transcript", () => {
		const { handlers } = fakePi();
		const messages = longSession();
		const before = JSON.stringify(messages);
		const r = handlers.get("context")?.({ type: "context", messages }, {}) as { messages: Msg[] };
		expect(JSON.stringify(messages)).toBe(before);
		expect(r.messages.length).toBe(messages.length);
		expect(JSON.stringify(r.messages[2])).toContain("cleared to keep the context sharp");
	});

	test("short conversations pass through untouched, it can be switched off, and odd input never throws", () => {
		const { handlers } = fakePi();
		const short = [user("hi")];
		expect(handlers.get("context")?.({ type: "context", messages: short }, {})).toBeUndefined();
		vi.stubEnv("SITRA_SHARPEN", "0");
		expect(handlers.get("context")?.({ type: "context", messages: longSession() }, {})).toBeUndefined();
		vi.unstubAllEnvs();
		expect(() => handlers.get("context")?.({ type: "context", messages: [null, 3, { role: 5 }] }, {})).not.toThrow();
		expect(() => handlers.get("context")?.({}, {})).not.toThrow();
	});
});

describe("hand-offs to helpers", () => {
	const ctxWith = (messages: Msg[]) => ({
		cwd: "/w",
		sessionManager: { getBranch: () => messages.map((message) => ({ type: "message", message })) },
	});

	test("a lead's subagent task gets the person's requests appended, single and parallel", () => {
		const { handlers } = fakePi();
		const ctx = ctxWith([user("Fix the date parser. Don't run the full suite.")]);
		const single = { toolName: "subagent", input: { agent: "scout", task: "Find the parser" } };
		handlers.get("tool_call")?.(single, ctx);
		expect(single.input.task).toContain("Find the parser");
		expect(single.input.task).toContain("Don't run the full suite.");
		const parallel = {
			toolName: "subagent",
			input: {
				children: [
					{ agent: "scout", task: "A" },
					{ agent: "scout", task: "B" },
				],
			},
		};
		handlers.get("tool_call")?.(parallel, ctx);
		for (const c of parallel.input.children) expect(c.task).toContain("Don't run the full suite.");
		const again = { toolName: "subagent", input: { agent: "scout", task: single.input.task } };
		handlers.get("tool_call")?.(again, ctx);
		expect(again.input.task.match(/Context from the lead's conversation/g)).toHaveLength(1);
	});

	test("helpers don't forward, other tools are untouched, and nothing throws", () => {
		const { handlers } = fakePi();
		const ctx = ctxWith([user("Fix the date parser. Don't run the full suite.")]);
		vi.stubEnv("PI_SUBAGENT_NAME", "scout");
		const fromHelper = { toolName: "subagent", input: { task: "x" } };
		handlers.get("tool_call")?.(fromHelper, ctx);
		expect(fromHelper.input.task).toBe("x");
		vi.unstubAllEnvs();
		const bash = { toolName: "bash", input: { command: "ls" } };
		handlers.get("tool_call")?.(bash, ctx);
		expect(bash.input).toEqual({ command: "ls" });
		expect(() => handlers.get("tool_call")?.({ toolName: "subagent", input: null }, {})).not.toThrow();
	});
});

describe("handing over", () => {
	test("when a run ends past the threshold, it says so and compacts with the handover instructions; below it, nothing", () => {
		const { handlers } = fakePi();
		const notes: string[] = [];
		const compacts: { customInstructions?: string }[] = [];
		const ctx = (tokens: number, turns = 2) => ({
			sessionManager: {
				getBranch: () => Array.from({ length: turns }, () => ({ type: "message", message: user("a request") })),
			},
			hasUI: true,
			ui: { notify: (m: string) => notes.push(m) },
			getContextUsage: () => ({ tokens, contextWindow: 1_000_000, percent: tokens / 10_000 }),
			compact: (o: { customInstructions?: string }) => compacts.push(o),
		});
		handlers.get("agent_settled")?.({ aborted: false }, ctx(100_000));
		expect(compacts).toHaveLength(0);
		handlers.get("agent_end")?.({}, ctx(170_000));
		expect(compacts).toHaveLength(0);
		handlers.get("agent_settled")?.({ aborted: true }, ctx(170_000));
		expect(compacts).toHaveLength(0);
		handlers.get("agent_settled")?.({}, ctx(170_000));
		expect(compacts).toHaveLength(0);
		handlers.get("agent_settled")?.({ aborted: false }, ctx(170_000, 1));
		expect(compacts).toHaveLength(0);
		handlers.get("agent_settled")?.({ aborted: false }, ctx(170_000));
		expect(compacts).toHaveLength(1);
		expect(compacts[0]?.customInstructions).toMatch(/handover/i);
		expect(notes.join(" ")).toMatch(/handing over/i);
		vi.stubEnv("PI_SUBAGENT_NAME", "builder");
		handlers.get("agent_settled")?.({ aborted: false }, ctx(170_000));
		expect(compacts).toHaveLength(1);
	});

	test("after a handover, it waits until the context has dropped below the line before it can hand over again", () => {
		const { handlers } = fakePi();
		const compacts: unknown[] = [];
		const ctx = (tokens: number) => ({
			sessionManager: {
				getBranch: () => [
					{ type: "message", message: user("a") },
					{ type: "message", message: user("b") },
				],
			},
			ui: { notify() {} },
			getContextUsage: () => ({ tokens, contextWindow: 1_000_000 }),
			compact: (o: unknown) => compacts.push(o),
		});
		const settle = (tokens: number) => handlers.get("agent_settled")?.({ aborted: false }, ctx(tokens));
		settle(170_000);
		settle(175_000);
		settle(180_000);
		expect(compacts).toHaveLength(1);
		settle(60_000);
		settle(170_000);
		expect(compacts).toHaveLength(2);
	});

	test("/handover compacts now, and each handover is saved as a readable file", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "sitra-handover-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", dir);
		const { handlers, commands } = fakePi();
		const compacts: unknown[] = [];
		await commands.get("handover")?.handler("", {
			hasUI: true,
			ui: { notify() {} },
			compact: (o: unknown) => compacts.push(o),
			getContextUsage: () => undefined,
		});
		expect(compacts).toHaveLength(1);
		handlers.get("session_compact")?.(
			{ type: "session_compact", compactionEntry: { summary: "1. Goal: fix the parser" } },
			{ sessionManager: { getSessionId: () => "s1" } },
		);
		const files = readdirSync(join(dir, "handovers"));
		expect(files).toHaveLength(1);
		expect(readFileSync(join(dir, "handovers", files[0] ?? ""), "utf8")).toContain("fix the parser");
		vi.stubEnv("SITRA_SHARPEN", "0");
		handlers.get("session_compact")?.(
			{ type: "session_compact", compactionEntry: { summary: "second" } },
			{ sessionManager: { getSessionId: () => "s1" } },
		);
		expect(readdirSync(join(dir, "handovers"))).toHaveLength(1);
	});
});

describe("handing over mid-run", () => {
	const assistantCall = (i: number): Msg => ({
		role: "assistant",
		content: [{ type: "toolCall", id: `c${i}`, name: "read", arguments: { path: `f${i}.ts` } }],
	});
	const result = (i: number): Msg => ({
		role: "toolResult",
		toolCallId: `c${i}`,
		toolName: "read",
		content: [{ type: "text", text: `contents of f${i}` }],
	});
	function run(steps: number): Msg[] {
		const out: Msg[] = [user("Fix every parser in the repo. Don't run the full suite.")];
		for (let i = 0; i < steps; i++) out.push(assistantCall(i), result(i));
		return out;
	}
	function turnEnd(messages: Msg[], extra: Record<string, unknown> = {}) {
		const last = messages.findLastIndex((m) => m.role === "assistant");
		return {
			type: "turn_end",
			message: messages[last],
			toolResults: messages.slice(last + 1).filter((m) => m.role === "toolResult"),
			messageEntryId: "entry-last",
			toolResultEntryIds: ["entry-result"],
			outcome: "completed",
			entries: [],
			continue: false,
			context: { contextMessages: messages, canContinue: true },
			...extra,
		};
	}
	function ctx(tokens: number, reply: string | Error = "1. Goal: fix the parsers") {
		const calls: { prompt: string; options: Record<string, unknown> }[] = [];
		const notes: string[] = [];
		return {
			calls,
			notes,
			ctx: {
				hasUI: true,
				ui: { notify: (m: string) => notes.push(m) },
				model: { provider: "p", id: "m", contextWindow: 1_000_000 },
				signal: undefined,
				getContextUsage: () => ({ tokens, contextWindow: 1_000_000 }),
				sessionManager: { getSessionId: () => "s1" },
				modelRegistry: {
					complete: async (_m: unknown, c: { messages: Msg[] }, options: Record<string, unknown>) => {
						calls.push({ prompt: JSON.stringify(c.messages), options });
						if (reply instanceof Error) throw reply;
						return { role: "assistant", content: [{ type: "text", text: reply }] };
					},
				},
			},
		};
	}
	type Result = { entries?: { type: string; summary: string; firstKeptEntryId: string | null }[]; continue?: boolean };

	test("past the line while still working, the turn ends with a handover compaction and the run carries on", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "sitra-midrun-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", dir);
		const { handlers } = fakePi();
		const c = ctx(170_000);
		const r = (await handlers.get("turn_end")?.(turnEnd(run(6)), c.ctx)) as Result;
		expect(r.entries).toHaveLength(1);
		const entry = r.entries?.[0];
		expect(entry?.type).toBe("compaction");
		expect(entry?.firstKeptEntryId).toBe("entry-last");
		expect(entry?.summary).toContain("1. Goal: fix the parsers");
		expect(entry?.summary).toContain("Don't run the full suite.");
		expect(r.continue).toBeUndefined();
		expect(c.calls).toHaveLength(1);
		expect(c.calls[0]?.prompt).toMatch(/handover/i);
		expect(c.calls[0]?.prompt).toContain("f2.ts");
		expect(c.calls[0]?.prompt).not.toContain("f5.ts");
		expect(c.notes.join(" ")).toMatch(/handing over/i);
		expect(readdirSync(join(dir, "handovers"))).toHaveLength(1);
	});

	test("helpers hand over mid-run too, since loop steps are helpers", async () => {
		vi.stubEnv("PI_CODING_AGENT_DIR", realpathSync(mkdtempSync(join(tmpdir(), "sitra-midrun-"))));
		vi.stubEnv("PI_SUBAGENT_NAME", "builder");
		const { handlers } = fakePi();
		const r = (await handlers.get("turn_end")?.(turnEnd(run(6)), ctx(170_000).ctx)) as Result;
		expect(r.entries).toHaveLength(1);
	});

	test("nothing happens below the line, on a final reply, after an error, with too little to summarise, or when off", async () => {
		const { handlers } = fakePi();
		const te = handlers.get("turn_end");
		const below = ctx(100_000);
		expect(await te?.(turnEnd(run(6)), below.ctx)).toBeUndefined();
		const final = [...run(6), { role: "assistant", content: [{ type: "text", text: "done" }] } as Msg];
		expect(await te?.(turnEnd(final), ctx(170_000).ctx)).toBeUndefined();
		expect(await te?.(turnEnd(run(6), { outcome: "error" }), ctx(170_000).ctx)).toBeUndefined();
		expect(await te?.(turnEnd(run(1)), ctx(170_000).ctx)).toBeUndefined();
		vi.stubEnv("SITRA_SHARPEN", "0");
		const off = ctx(170_000);
		expect(await te?.(turnEnd(run(6)), off.ctx)).toBeUndefined();
		expect(off.calls).toHaveLength(0);
		expect(below.calls).toHaveLength(0);
	});

	test("one handover per crossing, and a failed summary leaves the run untouched and does not retry every turn", async () => {
		vi.stubEnv("PI_CODING_AGENT_DIR", realpathSync(mkdtempSync(join(tmpdir(), "sitra-midrun-"))));
		const { handlers } = fakePi();
		const te = handlers.get("turn_end") as (event: unknown, ctx: unknown) => Promise<unknown>;
		expect(((await te(turnEnd(run(6)), ctx(170_000).ctx)) as Result).entries).toHaveLength(1);
		expect(await te(turnEnd(run(7)), ctx(175_000).ctx)).toBeUndefined();
		expect(await te(turnEnd(run(8)), ctx(60_000).ctx)).toBeUndefined();
		const failing = ctx(170_000, new Error("429"));
		expect(await te(turnEnd(run(9)), failing.ctx)).toBeUndefined();
		expect(failing.notes.join(" ")).toMatch(/couldn't hand over/i);
		const again = ctx(172_000);
		expect(await te(turnEnd(run(10)), again.ctx)).toBeUndefined();
		expect(again.calls).toHaveLength(0);
	});
});

describe("Pi's own compaction near the limit", () => {
	const ctxWith = (reply: string | Error) => {
		const prompts: string[] = [];
		return {
			prompts,
			ctx: {
				model: { provider: "p", id: "m" },
				modelRegistry: {
					complete: async (_m: unknown, c: { messages: Msg[] }) => {
						prompts.push(JSON.stringify(c.messages));
						if (reply instanceof Error) throw reply;
						return { role: "assistant", content: [{ type: "text", text: reply }] };
					},
				},
			},
		};
	};
	const event = (reason: string) => ({
		type: "session_before_compact",
		reason,
		signal: new AbortController().signal,
		preparation: {
			firstKeptEntryId: "keep-1",
			tokensBefore: 980_000,
			previousSummary: "old",
			messagesToSummarize: [user("Fix every parser. Don't run the full suite.")],
			turnPrefixMessages: [],
		},
	});

	test("uses the handover format with the requests carried verbatim, as does sitra's own handover; plain /compact and failures are left to Pi", async () => {
		const { handlers } = fakePi();
		const ok = ctxWith("1. Goal: parsers");
		const r = (await handlers.get("session_before_compact")?.(event("threshold"), ok.ctx)) as {
			compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number };
		};
		expect(ok.prompts[0]).toMatch(/handover/i);
		expect(r.compaction.firstKeptEntryId).toBe("keep-1");
		expect(r.compaction.tokensBefore).toBe(980_000);
		expect(r.compaction.summary).toContain("1. Goal: parsers");
		expect(r.compaction.summary).toContain("Don't run the full suite.");
		expect(await handlers.get("session_before_compact")?.(event("overflow"), ok.ctx)).toBeDefined();
		const manual = ctxWith("x");
		expect(await handlers.get("session_before_compact")?.(event("manual"), manual.ctx)).toBeUndefined();
		expect(manual.prompts).toHaveLength(0);
		expect(
			await handlers.get("session_before_compact")?.(event("threshold"), ctxWith(new Error("429")).ctx),
		).toBeUndefined();
		const ours = ctxWith("1. Goal: run-end");
		const r2 = (await handlers.get("session_before_compact")?.(
			{ ...event("manual"), customInstructions: HANDOVER_INSTRUCTIONS },
			ours.ctx,
		)) as { compaction: { summary: string } };
		expect(r2.compaction.summary).toContain("Don't run the full suite.");
	});
});
