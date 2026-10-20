import { describe, expect, test } from "vitest";
import {
	HANDOVER_INSTRUCTIONS,
	handoverThreshold,
	helperBrief,
	type Msg,
	personRequests,
	stubToolResults,
} from "../extensions/sharpen.ts";

const user = (text: string): Msg => ({ role: "user", content: [{ type: "text", text }] });
const call = (id: string, name: string, args: Record<string, unknown>): Msg => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name, arguments: args }],
});
const result = (id: string, name: string, text: string, isError = false): Msg => ({
	role: "toolResult",
	toolCallId: id,
	toolName: name,
	content: [{ type: "text", text }],
	isError,
});

/** A session with `n` read calls, each returning `size` characters. */
function session(n: number, size = 2_000): Msg[] {
	const out: Msg[] = [user("Fix the date parser")];
	for (let i = 0; i < n; i++) {
		out.push(call(`c${i}`, "read", { path: `src/file${i}.ts` }));
		out.push(result(`c${i}`, "read", `line\n`.repeat(size / 5)));
	}
	return out;
}

describe("clearing old tool output", () => {
	test("old, large results become a one-line stub naming the call; recent ones stay whole; nothing else changes", () => {
		const msgs = session(30);
		const { messages, stubbed, savedChars } = stubToolResults(msgs, { keepRecent: 8, batch: 10, minChars: 600 });
		expect(messages).toHaveLength(msgs.length);
		expect(stubbed).toBe(20);
		expect(savedChars).toBeGreaterThan(30_000);
		const first = messages[2] as Msg;
		expect(first.role).toBe("toolResult");
		expect(first.toolCallId).toBe("c0");
		const text = (first.content as { text: string }[])[0]?.text ?? "";
		expect(text).toContain("read(src/file0.ts)");
		expect(text).toMatch(/run it again/i);
		expect(text.length).toBeLessThan(300);
		const last = messages.at(-1) as Msg;
		expect((last.content as { text: string }[])[0]?.text.length).toBe(2_000);
		expect(msgs[2]?.content).not.toBe(first.content);
		expect(((msgs[2] as Msg).content as { text: string }[])[0]?.text.length).toBe(2_000);
	});

	test("the boundary moves in batches, so the earlier context stays identical between most steps", () => {
		const a = stubToolResults(session(25), { keepRecent: 8, batch: 10, minChars: 600 });
		const b = stubToolResults(session(26), { keepRecent: 8, batch: 10, minChars: 600 });
		expect(a.stubbed).toBe(10);
		expect(b.stubbed).toBe(10);
		expect(JSON.stringify(b.messages.slice(0, 51))).toBe(JSON.stringify(a.messages.slice(0, 51)));
		expect(stubToolResults(session(28), { keepRecent: 8, batch: 10, minChars: 600 }).stubbed).toBe(20);
	});

	test("results of the latest batch of calls are never stubbed, however many there are", () => {
		const msgs: Msg[] = [user("go read everything")];
		const calls = Array.from({ length: 30 }, (_, i) => ({
			type: "toolCall",
			id: `b${i}`,
			name: "read",
			arguments: { path: `f${i}` },
		}));
		msgs.push({ role: "assistant", content: calls });
		for (let i = 0; i < 30; i++) msgs.push(result(`b${i}`, "read", "y".repeat(3_000)));
		expect(stubToolResults(msgs).stubbed).toBe(0);
		msgs.push(call("next", "read", { path: "g" }), result("next", "read", "z".repeat(3_000)));
		expect(stubToolResults(msgs).stubbed).toBeGreaterThan(0);
	});

	test("small results, short sessions and images are handled sensibly", () => {
		const small = session(30, 100);
		expect(stubToolResults(small, { keepRecent: 8, batch: 10, minChars: 600 }).stubbed).toBe(0);
		expect(stubToolResults(session(5), { keepRecent: 8, batch: 10, minChars: 600 }).stubbed).toBe(0);
		const withImage = session(30);
		withImage[2] = {
			...(withImage[2] as Msg),
			content: [{ type: "image", data: "x".repeat(50_000), mimeType: "image/png" }],
		};
		const r = stubToolResults(withImage, { keepRecent: 8, batch: 10, minChars: 600 });
		expect(JSON.stringify(r.messages[2])).not.toContain("x".repeat(100));
	});
});

describe("what the person asked for", () => {
	test("keeps the person's own messages, skips approvals, sitra's own texts and one-word replies, and caps them", () => {
		const msgs: Msg[] = [
			user("Read AGENTS.md, CLAUDE.md, any project steering index, and Grimoire so you are grounded"),
			user("Fix the flights date bug. Don't run the full suite."),
			user("go"),
			{ role: "custom", customType: "sitra-run", content: "The run finished" } as Msg,
			user("ok"),
			user("also make the PR a draft"),
		];
		expect(personRequests(msgs)).toEqual([
			"Fix the flights date bug. Don't run the full suite.",
			"also make the PR a draft",
		]);
		const many = Array.from({ length: 30 }, (_, i) => user(`request number ${i} with some words`));
		const capped = personRequests(many, { max: 6 });
		expect(capped).toHaveLength(6);
		expect(capped[0]).toBe("request number 0 with some words");
		expect(capped.at(-1)).toBe("request number 29 with some words");
	});
});

describe("helper briefs", () => {
	const pause = result(
		"p",
		"bash",
		"Paused once so these approved Grimoire rules are in front of you before this action.\n\n## [warning] No full suites unless asked\nbody\nFull entry: /g/x.md",
		true,
	);

	test("a helper's brief carries the person's latest request and rules, briefly", () => {
		const msgs: Msg[] = [
			user("Fix the flights date bug. Don't run the full suite."),
			call("p", "bash", { command: "pnpm test" }),
			pause,
		];
		const h = helperBrief(msgs) ?? "";
		expect(h).toContain("Don't run the full suite");
		expect(h).toContain("No full suites unless asked");
		expect(h.length).toBeLessThan(2_500);
		expect(helperBrief([user("go")])).toBeUndefined();
	});
});

describe("handing over", () => {
	test("hands over well before the window is full, scaled to the model", () => {
		expect(handoverThreshold(1_000_000)).toBe(160_000);
		expect(handoverThreshold(200_000)).toBe(80_000);
		expect(handoverThreshold(32_000)).toBe(16_000); // half the window for small windows, so there's room to work
		expect(HANDOVER_INSTRUCTIONS).toMatch(/decisions/i);
		expect(HANDOVER_INSTRUCTIONS).toMatch(/verbatim|own words/i);
	});
});
