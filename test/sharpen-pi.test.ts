import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { HANDOVER_INSTRUCTIONS, type Msg } from "../extensions/sharpen.ts";
import sitraSharpen, { configuredHandoverTokens, HANDOVER_MAX_TOKENS } from "../extensions/sharpen-pi.ts";

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

	test("the verifier task starts from the runner's evidence only", () => {
		const { handlers } = fakePi();
		const ctx = ctxWith([user("Fix the date parser. Don't run the full suite.")]);
		const single = { toolName: "subagent", input: { agent: "verifier", task: "Verify the frozen brief." } };
		handlers.get("tool_call")?.(single, ctx);
		expect(single.input.task).toBe("Verify the frozen brief.");

		const parallel = {
			toolName: "subagent",
			input: {
				children: [
					{ agent: "verifier", task: "Verify the diff." },
					{ agent: "scout", task: "Find nearby tests." },
				],
			},
		};
		handlers.get("tool_call")?.(parallel, ctx);
		expect(parallel.input.children[0]?.task).toBe("Verify the diff.");
		expect(parallel.input.children[1]?.task).toContain("Don't run the full suite.");
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
	test("handover instructions put state and next steps first, with last report and scoped decisions", () => {
		const goal = HANDOVER_INSTRUCTIONS.indexOf("1. Goal:");
		const state = HANDOVER_INSTRUCTIONS.indexOf("2. State:");
		const next = HANDOVER_INSTRUCTIONS.indexOf("3. Next steps:");
		const standing = HANDOVER_INSTRUCTIONS.indexOf("4. Standing instructions:");
		const decisions = HANDOVER_INSTRUCTIONS.indexOf("5. Decisions and their reasons:");
		expect(goal).toBeGreaterThanOrEqual(0);
		expect(state).toBeGreaterThan(goal);
		expect(next).toBeGreaterThan(state);
		expect(standing).toBeGreaterThan(next);
		expect(decisions).toBeGreaterThan(standing);
		expect(HANDOVER_INSTRUCTIONS).toContain("your last report to the person");
		expect(HANDOVER_INSTRUCTIONS).toContain("what it applies to");
	});

	test("configuredHandoverTokens reads the runtime env and rejects invalid values with source, value and type", () => {
		expect(configuredHandoverTokens()).toBeUndefined();
		vi.stubEnv("SITRA_HANDOVER_TOKENS", "250000");
		expect(configuredHandoverTokens()).toBe(250_000);
		vi.stubEnv("SITRA_HANDOVER_TOKENS", "0");
		expect(() => configuredHandoverTokens()).toThrow(/SITRA_HANDOVER_TOKENS.*received "0".*type string/i);
		vi.stubEnv("SITRA_HANDOVER_TOKENS", "1.5");
		expect(() => configuredHandoverTokens()).toThrow(/SITRA_HANDOVER_TOKENS.*received "1.5".*type string/i);
	});

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
		handlers.get("agent_end")?.({}, ctx(410_000));
		expect(compacts).toHaveLength(0);
		handlers.get("agent_settled")?.({ aborted: true }, ctx(410_000));
		expect(compacts).toHaveLength(0);
		handlers.get("agent_settled")?.({}, ctx(410_000));
		expect(compacts).toHaveLength(0);
		handlers.get("agent_settled")?.({ aborted: false }, ctx(410_000, 1));
		expect(compacts).toHaveLength(0);
		handlers.get("agent_settled")?.({ aborted: false }, ctx(410_000));
		expect(compacts).toHaveLength(1);
		expect(compacts[0]?.customInstructions).toMatch(/handover/i);
		expect(notes.join(" ")).toMatch(/handing over/i);
		vi.stubEnv("PI_SUBAGENT_NAME", "builder");
		handlers.get("agent_settled")?.({ aborted: false }, ctx(410_000));
		expect(compacts).toHaveLength(1);
	});

	test("session start and model selection validate handoverTokens against the active model window", () => {
		const { handlers } = fakePi();
		const notes: string[] = [];
		vi.stubEnv("SITRA_HANDOVER_TOKENS", "200000");
		const ctx = { ui: { notify: (m: string) => notes.push(m) }, model: { contextWindow: 100_000 } };
		expect(() => handlers.get("session_start")?.({}, ctx)).toThrow(/SITRA_HANDOVER_TOKENS.*context window/i);
		expect(notes.join(" ")).toMatch(/SITRA_HANDOVER_TOKENS.*200000.*context window/i);
		notes.length = 0;
		expect(() => handlers.get("model_select")?.({ model: { contextWindow: 100_000 } }, { ui: ctx.ui })).toThrow(
			/SITRA_HANDOVER_TOKENS.*context window/i,
		);
		expect(notes.join(" ")).toMatch(/SITRA_HANDOVER_TOKENS.*200000.*context window/i);
	});

	test("agent_settled loudly rejects invalid and above-window handoverTokens", () => {
		const { handlers } = fakePi();
		const notes: string[] = [];
		const ctx = {
			sessionManager: {
				getBranch: () => [
					{ type: "message", message: user("a") },
					{ type: "message", message: user("b") },
				],
			},
			ui: { notify: (m: string) => notes.push(m) },
			getContextUsage: () => ({ tokens: 90_000, contextWindow: 100_000 }),
			compact() {},
		};
		vi.stubEnv("SITRA_HANDOVER_TOKENS", "0");
		expect(() => handlers.get("agent_settled")?.({ aborted: false }, ctx)).toThrow(
			/SITRA_HANDOVER_TOKENS.*positive integer/i,
		);
		expect(notes.join(" ")).toMatch(/SITRA_HANDOVER_TOKENS.*received "0".*type string/i);
		notes.length = 0;
		vi.stubEnv("SITRA_HANDOVER_TOKENS", "120000");
		expect(() => handlers.get("agent_settled")?.({ aborted: false }, ctx)).toThrow(
			/SITRA_HANDOVER_TOKENS.*context window/i,
		);
		expect(notes.join(" ")).toMatch(/SITRA_HANDOVER_TOKENS.*120000.*context window/i);
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
		settle(410_000);
		settle(415_000);
		settle(420_000);
		expect(compacts).toHaveLength(1);
		settle(60_000);
		settle(410_000);
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
			{ type: "session_compact", compactionEntry: { summary: "1. Goal: fix the parser" }, fromExtension: true },
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
	type FakeReply = string | Error | { text: string; stopReason?: string };
	function ctx(tokens: number, reply: FakeReply = "1. Goal: fix the parsers") {
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
						const text = typeof reply === "string" ? reply : reply.text;
						const stopReason = typeof reply === "string" ? undefined : reply.stopReason;
						return { role: "assistant", content: [{ type: "text", text }], stopReason };
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
		const c = ctx(410_000);
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

	test("a length-stopped mid-run reply is not saved as a handover checkpoint", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "sitra-midrun-length-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", dir);
		const { handlers } = fakePi();
		const stopped = ctx(410_000, { text: "1. Goal: keep going until you build the appro", stopReason: "length" });
		const r = await handlers.get("turn_end")?.(turnEnd(run(6)), stopped.ctx);
		expect(r).toBeUndefined();
		const handovers = join(dir, "handovers");
		expect(existsSync(handovers) ? readdirSync(handovers) : []).toHaveLength(0);
		expect(stopped.notes.join(" ")).toContain("couldn't hand over");
		expect(stopped.notes.join(" ")).toContain("length");
	});

	test("summary calls use the handover token budget constant", async () => {
		const { handlers } = fakePi();
		const c = ctx(410_000);
		await handlers.get("turn_end")?.(turnEnd(run(6)), c.ctx);
		expect(c.calls[0]?.options.maxTokens).toBe(HANDOVER_MAX_TOKENS);
		expect(HANDOVER_MAX_TOKENS).toBe(32_000);
	});

	test("summary calls lower the actual Anthropic adaptive-thinking request", async () => {
		const { handlers } = fakePi();
		const c = ctx(410_000);
		const requests: Record<string, unknown>[] = [];
		const anthropicModel = {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-opus-5-5",
			reasoning: true,
			contextWindow: 1_000_000,
			compat: { supportsMidConvoEffort: true },
		};
		const testCtx = c.ctx as typeof c.ctx & { model: unknown };
		testCtx.model = anthropicModel;
		testCtx.modelRegistry.complete = async (_m: unknown, _c: { messages: Msg[] }, options: Record<string, unknown>) => {
			c.calls.push({ prompt: "anthropic", options });
			const built = {
				model: "claude-opus-5-5",
				messages: [
					{ role: "user", content: [{ type: "text", text: "handover" }] },
					{ role: "system", content: [], output_config: { effort: "high" } },
				],
				max_tokens: HANDOVER_MAX_TOKENS,
				stream: true,
				thinking: { type: "adaptive", display: "summarized" },
				output_config: { effort: "high" },
			};
			const onPayload = options.onPayload as
				| ((payload: Record<string, unknown>, model: unknown) => Record<string, unknown> | undefined)
				| undefined;
			requests.push(onPayload?.(built, anthropicModel) ?? built);
			return {
				role: "assistant",
				content: [{ type: "text", text: "1. Goal: fix the parsers" }],
				stopReason: undefined,
			};
		};
		await handlers.get("turn_end")?.(turnEnd(run(6)), testCtx);
		const request = requests[0] as {
			output_config?: { effort?: string };
			messages?: { output_config?: { effort?: string } }[];
			max_tokens?: number;
			thinking?: { type?: string };
		};
		expect(request.max_tokens).toBe(HANDOVER_MAX_TOKENS);
		expect(request.thinking?.type).toBe("adaptive");
		expect(request.output_config?.effort).toBe("low");
		expect(request.messages?.at(-1)?.output_config?.effort).toBe("low");
	});

	test("helpers hand over mid-run too, since loop steps are helpers", async () => {
		vi.stubEnv("PI_CODING_AGENT_DIR", realpathSync(mkdtempSync(join(tmpdir(), "sitra-midrun-"))));
		vi.stubEnv("PI_SUBAGENT_NAME", "builder");
		const { handlers } = fakePi();
		const r = (await handlers.get("turn_end")?.(turnEnd(run(6)), ctx(410_000).ctx)) as Result;
		expect(r.entries).toHaveLength(1);
	});

	test("nothing happens below the line, on a final reply, after an error, with too little to summarise, or when off", async () => {
		const { handlers } = fakePi();
		const te = handlers.get("turn_end");
		const below = ctx(100_000);
		expect(await te?.(turnEnd(run(6)), below.ctx)).toBeUndefined();
		const final = [...run(6), { role: "assistant", content: [{ type: "text", text: "done" }] } as Msg];
		expect(await te?.(turnEnd(final), ctx(410_000).ctx)).toBeUndefined();
		expect(await te?.(turnEnd(run(6), { outcome: "error" }), ctx(410_000).ctx)).toBeUndefined();
		expect(await te?.(turnEnd(run(1)), ctx(410_000).ctx)).toBeUndefined();
		vi.stubEnv("SITRA_SHARPEN", "0");
		const off = ctx(410_000);
		expect(await te?.(turnEnd(run(6)), off.ctx)).toBeUndefined();
		expect(off.calls).toHaveLength(0);
		expect(below.calls).toHaveLength(0);
	});

	test("one handover per crossing, and a failed summary leaves the run untouched and does not retry every turn", async () => {
		vi.stubEnv("PI_CODING_AGENT_DIR", realpathSync(mkdtempSync(join(tmpdir(), "sitra-midrun-"))));
		const { handlers } = fakePi();
		const te = handlers.get("turn_end") as (event: unknown, ctx: unknown) => Promise<unknown>;
		expect(((await te(turnEnd(run(6)), ctx(410_000).ctx)) as Result).entries).toHaveLength(1);
		expect(await te(turnEnd(run(7)), ctx(415_000).ctx)).toBeUndefined();
		expect(await te(turnEnd(run(8)), ctx(60_000).ctx)).toBeUndefined();
		const failing = ctx(410_000, new Error("429"));
		expect(await te(turnEnd(run(9)), failing.ctx)).toBeUndefined();
		expect(failing.notes.join(" ")).toMatch(/couldn't hand over/i);
		const again = ctx(412_000);
		expect(await te(turnEnd(run(10)), again.ctx)).toBeUndefined();
		expect(again.calls).toHaveLength(0);
	});

	test("turn_end loudly rejects invalid and above-window handoverTokens", async () => {
		const { handlers } = fakePi();
		const notes: string[] = [];
		const base = ctx(90_000).ctx as {
			ui: { notify(m: string): void };
			getContextUsage(): { tokens: number; contextWindow: number };
		};
		base.ui = { notify: (m: string) => notes.push(m) };
		base.getContextUsage = () => ({ tokens: 90_000, contextWindow: 100_000 });
		const te = handlers.get("turn_end") as (event: unknown, ctx: unknown) => Promise<unknown>;
		vi.stubEnv("SITRA_HANDOVER_TOKENS", "1.5");
		await expect(te(turnEnd(run(6)), base)).rejects.toThrow(/SITRA_HANDOVER_TOKENS.*positive integer/i);
		expect(notes.join(" ")).toMatch(/SITRA_HANDOVER_TOKENS.*received "1.5".*type string/i);
		notes.length = 0;
		vi.stubEnv("SITRA_HANDOVER_TOKENS", "120000");
		await expect(te(turnEnd(run(6)), base)).rejects.toThrow(/SITRA_HANDOVER_TOKENS.*context window/i);
		expect(notes.join(" ")).toMatch(/SITRA_HANDOVER_TOKENS.*120000.*context window/i);
	});
});

describe("Pi's own compaction near the limit", () => {
	type FakeReply = string | Error | { text: string; stopReason?: string };
	const ctxWith = (reply: FakeReply) => {
		const prompts: string[] = [];
		const calls: { prompt: string; options: Record<string, unknown> }[] = [];
		const notes: string[] = [];
		return {
			prompts,
			calls,
			notes,
			ctx: {
				ui: { notify: (m: string) => notes.push(m) },
				model: { provider: "p", id: "m" },
				modelRegistry: {
					complete: async (_m: unknown, c: { messages: Msg[] }, options: Record<string, unknown>) => {
						prompts.push(JSON.stringify(c.messages));
						calls.push({ prompt: JSON.stringify(c.messages), options });
						if (reply instanceof Error) throw reply;
						const text = typeof reply === "string" ? reply : reply.text;
						const stopReason = typeof reply === "string" ? undefined : reply.stopReason;
						return { role: "assistant", content: [{ type: "text", text }], stopReason };
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

	test("uses the handover format with carried requests; plain /compact stays with Pi and threshold failures cancel", async () => {
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
		expect(await handlers.get("session_before_compact")?.(event("threshold"), ctxWith(new Error("429")).ctx)).toEqual({
			cancel: true,
		});
		const ours = ctxWith("1. Goal: run-end");
		const r2 = (await handlers.get("session_before_compact")?.(
			{ ...event("manual"), customInstructions: HANDOVER_INSTRUCTIONS },
			ours.ctx,
		)) as { compaction: { summary: string } };
		expect(r2.compaction.summary).toContain("Don't run the full suite.");
	});

	test("a Pi-path failure at the threshold cancels and saves nothing", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "sitra-pi-threshold-length-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", dir);
		const { handlers } = fakePi();
		const stopped = ctxWith({ text: "1. Goal: keep going until you build the appro", stopReason: "length" });
		const r = await handlers.get("session_before_compact")?.(event("threshold"), stopped.ctx);
		expect(r).toEqual({ cancel: true });
		const handovers = join(dir, "handovers");
		expect(existsSync(handovers) ? readdirSync(handovers) : []).toHaveLength(0);
		expect(stopped.notes.join(" ")).toContain("couldn't hand over");
		expect(stopped.notes.join(" ")).toContain("length");
		expect(stopped.notes.join(" ")).toContain("compaction was cancelled");
	});

	test("after a threshold failure, the next threshold compaction makes no model call", async () => {
		const { handlers } = fakePi();
		const stopped = ctxWith({ text: "1. Goal: keep going until you build the appro", stopReason: "length" });
		expect(await handlers.get("session_before_compact")?.(event("threshold"), stopped.ctx)).toEqual({ cancel: true });
		expect(stopped.calls).toHaveLength(1);

		const skipped = ctxWith("1. Goal: this would only appear if the model was called");
		expect(await handlers.get("session_before_compact")?.(event("threshold"), skipped.ctx)).toEqual({ cancel: true });
		expect(skipped.calls).toHaveLength(0);
		expect(skipped.notes).toHaveLength(0);
	});

	test("an overflow fallback summary is not saved to handovers", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "sitra-pi-overflow-length-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", dir);
		const { handlers } = fakePi();
		const stopped = ctxWith({ text: "1. Goal: keep going until you build the appro", stopReason: "length" });
		const r = await handlers.get("session_before_compact")?.(event("overflow"), stopped.ctx);
		expect(r).toBeUndefined();
		expect(stopped.notes.join(" ")).toContain("couldn't hand over");
		expect(stopped.notes.join(" ")).toContain("length");
		expect(stopped.notes.join(" ")).toContain("Pi's default summary was used");
		expect(stopped.notes.join(" ")).toContain("no handover was saved");
		handlers.get("session_compact")?.(
			{ type: "session_compact", reason: "overflow", fromExtension: false, compactionEntry: { summary: "pi default" } },
			{ sessionManager: { getSessionId: () => "s1" } },
		);
		const handovers = join(dir, "handovers");
		expect(existsSync(handovers) ? readdirSync(handovers) : []).toHaveLength(0);
	});
});
