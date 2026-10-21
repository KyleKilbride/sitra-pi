import { afterEach, describe, expect, test, vi } from "vitest";
import replyCheck from "../extensions/replycheck-pi.ts";
import type { Msg } from "../extensions/sharpen.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
function setup(states: Record<string, string>) {
	const handlers = new Map<string, Handler>();
	const lookups: string[] = [];
	replyCheck({ on: (n: string, h: Handler) => handlers.set(n, h) } as never, {
		lookup: async (url: string) => {
			lookups.push(url);
			const state = states[url];
			if (!state) throw new Error("not found");
			return { url, state, mergedAt: state === "MERGED" ? "2026-01-02T00:00:00Z" : undefined };
		},
	});
	return { handlers, lookups };
}
const user = (text: string): Msg => ({ role: "user", content: [{ type: "text", text }] });
const say = (text: string): Msg => ({ role: "assistant", content: [{ type: "text", text }] });
const settle = (messages: Msg[], extra: Record<string, unknown> = {}) => ({
	type: "agent_before_settle",
	outcome: "completed",
	entries: [],
	continue: false,
	context: { contextMessages: messages, canContinue: true },
	...extra,
});
const A = "https://github.com/acme/app/pull/1";
const B = "https://github.com/acme/app/pull/2";
type Result = { continue?: boolean; entries?: { type: string; content: string; display: boolean }[] };

afterEach(() => vi.unstubAllEnvs());

describe("the end-of-reply PR check", () => {
	test("a reply naming a merged PR it didn't check gets one note and one more turn to fix it", async () => {
		const { handlers, lookups } = setup({ [A]: "OPEN", [B]: "MERGED" });
		const r = (await handlers.get("agent_before_settle")?.(
			settle([user("status?"), say(`Waiting on you: ${A} and ${B}`)]),
			{},
		)) as Result;
		expect(lookups.sort()).toEqual([A, B]);
		expect(r.continue).toBe(true);
		expect(r.entries?.[0]?.type).toBe("custom_message");
		expect(r.entries?.[0]?.content).toContain(`${B} is merged`);
	});

	test("only once per run, so the corrected reply always goes through", async () => {
		const { handlers } = setup({ [B]: "MERGED" });
		const h = handlers.get("agent_before_settle") as Handler;
		expect(((await h(settle([user("s"), say(B)]), {})) as Result).continue).toBe(true);
		expect(await h(settle([user("s"), say(B), say(`still ${B}`)]), {})).toBeUndefined();
		await handlers.get("before_agent_start")?.({}, {});
		expect(((await h(settle([user("s2"), say(B)]), {})) as Result).continue).toBe(true);
	});

	test("silent when every PR is open, already checked this turn, the lookup fails, or the run errored", async () => {
		const bashCheck: Msg = {
			role: "assistant",
			content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command: `gh pr view ${B} --json state` } }],
		};
		const cases: [Record<string, string>, unknown][] = [
			[{ [A]: "OPEN" }, settle([user("s"), say(A)])],
			[{ [B]: "MERGED" }, settle([user("s"), bashCheck, say(B)])],
			[{}, settle([user("s"), say(B)])],
			[{ [B]: "MERGED" }, settle([user("s"), say(B)], { outcome: "error" })],
		];
		for (const [states, event] of cases) {
			const { handlers } = setup(states);
			expect(await handlers.get("agent_before_settle")?.(event, {})).toBeUndefined();
		}
	});

	test("SITRA_REPLY_CHECK=0 turns it off without any lookup", async () => {
		vi.stubEnv("SITRA_REPLY_CHECK", "0");
		const { handlers, lookups } = setup({ [B]: "MERGED" });
		expect(await handlers.get("agent_before_settle")?.(settle([user("s"), say(B)]), {})).toBeUndefined();
		expect(lookups).toHaveLength(0);
	});
});
