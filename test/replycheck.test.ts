import { describe, expect, test } from "vitest";
import { checkedInTurn, correctionNote, type PrState, prLinks } from "../extensions/replycheck.ts";
import type { Msg } from "../extensions/sharpen.ts";

const user = (text: string): Msg => ({ role: "user", content: [{ type: "text", text }] });
const bash = (command: string): Msg => ({
	role: "assistant",
	content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command } }],
});

describe("PR links in a reply", () => {
	test("finds each GitHub PR link once, with or without a trailing path", () => {
		expect(
			prLinks(
				"Open: https://github.com/acme/app/pull/12 and https://github.com/acme/app/pull/12/files, also https://github.com/acme/lib/pull/7. Not https://github.com/acme/app/issues/3",
			),
		).toEqual(["https://github.com/acme/app/pull/12", "https://github.com/acme/lib/pull/7"]);
	});
});

describe("what the agent checked this turn", () => {
	test("a gh lookup of the link or number since the person's last message counts; earlier turns and plain reads don't", () => {
		const messages = [
			user("status?"),
			bash("gh pr view https://github.com/acme/app/pull/1 --json state"),
			user("and now?"),
			bash("gh pr view 2 --repo acme/app --json state"),
			bash("cat notes.md # https://github.com/acme/app/pull/3"),
			bash("gh pr view https://github.com/acme/app/pull/4 --json state,mergedAt"),
		];
		const links = [1, 2, 3, 4].map((n) => `https://github.com/acme/app/pull/${n}`);
		expect(checkedInTurn(messages, links)).toEqual([links[1], links[3]]);
	});
	test("a gh pr list in this turn counts as checking every link in that repo", () => {
		const links = ["https://github.com/acme/app/pull/9", "https://github.com/other/x/pull/1"];
		expect(checkedInTurn([user("hi"), bash("gh pr list --repo acme/app --state all")], links)).toEqual([links[0]]);
	});
});

describe("the note back to the agent", () => {
	const s = (url: string, state: string, mergedAt?: string): PrState => ({ url, state, mergedAt });
	test("speaks only about merged or closed PRs, in facts, and stays quiet when all are open", () => {
		expect(correctionNote([s("https://github.com/acme/app/pull/1", "OPEN")])).toBeUndefined();
		const note = correctionNote([
			s("https://github.com/acme/app/pull/1", "OPEN"),
			s("https://github.com/acme/app/pull/2", "MERGED", "2026-01-02T03:04:05Z"),
			s("https://github.com/acme/app/pull/3", "CLOSED"),
		]);
		expect(note).toContain("https://github.com/acme/app/pull/2 is merged (2026-01-02)");
		expect(note).toContain("https://github.com/acme/app/pull/3 is closed");
		expect(note).not.toContain("pull/1 ");
		expect(note).toMatch(/not checked this turn/);
	});
});
