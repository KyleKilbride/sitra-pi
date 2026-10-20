import { mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Msg } from "../extensions/sharpen.ts";
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
