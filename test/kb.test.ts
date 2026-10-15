import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	decide,
	knowledgeIndex,
	listEntries,
	listProposals,
	parseEntry,
	renderEntry,
	slug,
	writeProposal,
} from "../extensions/kb.ts";

const lesson = {
	kind: "lesson" as const,
	title: "Read the eval failures before claiming anything",
	body: "Seven eval jobs were red and nobody read which cases failed.",
	evidence: "a team postmortem, section 1",
	proposedBy: "planner",
	date: "2026-10-08T14:00:00.000Z",
};

describe("knowledge entries", () => {
	test("render and parse round-trip", () => {
		const text = renderEntry(lesson);
		expect(text.startsWith("---\n")).toBe(true);
		expect(parseEntry(text, "lessons/x.md")).toEqual({ ...lesson, file: "lessons/x.md" });
	});

	test("an entry without frontmatter or with an unknown kind is not an entry", () => {
		expect(parseEntry("# just notes", "x.md")).toBeUndefined();
		expect(parseEntry("---\nkind: rumor\ntitle: t\ndate: d\n---\nbody", "x.md")).toBeUndefined();
	});

	test("slugs are short and safe", () => {
		expect(slug("Read the eval failures — before claiming anything!")).toBe(
			"read-the-eval-failures-before-claiming-anything",
		);
		expect(slug("x".repeat(100))).toHaveLength(60);
	});
});

describe("proposals and your decision", () => {
	test("agents propose; only an accepted proposal becomes knowledge", () => {
		const root = mkdtempSync(join(tmpdir(), "sitra-kb-"));
		const file = writeProposal(root, lesson);
		expect(file).toBe("proposals/2026-10-08-read-the-eval-failures-before-claiming-anything.md");
		expect(listProposals(root)).toHaveLength(1);
		expect(listEntries(root)).toHaveLength(0);
		const accepted = decide(root, file, "accept");
		expect(accepted).toBe("lessons/2026-10-08-read-the-eval-failures-before-claiming-anything.md");
		expect(listProposals(root)).toHaveLength(0);
		expect(listEntries(root).map((e) => e.title)).toEqual([lesson.title]);
	});

	test("a rejected proposal is kept for the record but never shown to agents", () => {
		const root = mkdtempSync(join(tmpdir(), "sitra-kb-"));
		const file = writeProposal(root, { ...lesson, kind: "setup", title: "Install a new extension" });
		const rejected = decide(root, file, "reject");
		expect(rejected.startsWith("rejected/")).toBe(true);
		expect(listEntries(root)).toEqual([]);
		expect(readFileSync(join(root, rejected), "utf8")).toContain("Install a new extension");
	});

	test("two proposals with the same title on the same day don't overwrite each other", () => {
		const root = mkdtempSync(join(tmpdir(), "sitra-kb-"));
		expect(writeProposal(root, lesson)).not.toBe(writeProposal(root, lesson));
	});
});

describe("the index agents see", () => {
	test("lists every entry by kind with where to read it, warnings first", () => {
		const root = "/repo/.pi/knowledge";
		const index = knowledgeIndex(
			[
				{ ...lesson, file: "lessons/a.md" },
				{ ...lesson, kind: "warning", title: "Never force-push a colleague's branch", file: "warnings/b.md" },
			],
			root,
		);
		expect(index.indexOf("Never force-push")).toBeLessThan(index.indexOf("Read the eval failures"));
		expect(index).toContain("/repo/.pi/knowledge/warnings/b.md");
		expect(index).toMatch(/kb_propose/);
	});

	test("an empty knowledge base still tells agents how to add to it", () => {
		expect(knowledgeIndex([], "/r")).toMatch(/kb_propose/);
	});
});

describe("bugs the reviewer found", () => {
	test("accepting never overwrites an entry that's already there", () => {
		const root = mkdtempSync(join(tmpdir(), "sitra-kb-"));
		decide(root, writeProposal(root, lesson), "accept");
		const second = decide(root, writeProposal(root, { ...lesson, body: "different" }), "accept");
		expect(second).not.toBe("lessons/2026-10-08-read-the-eval-failures-before-claiming-anything.md");
		expect(listEntries(root)).toHaveLength(2);
	});

	test("an entry saved with Windows line endings still parses", () => {
		const text = renderEntry(lesson).replaceAll("\n", "\r\n");
		expect(parseEntry(text, "x.md")?.title).toBe(lesson.title);
	});

	test("one unreadable file doesn't break the listing", () => {
		const root = mkdtempSync(join(tmpdir(), "sitra-kb-"));
		decide(root, writeProposal(root, lesson), "accept");
		mkdirSync(join(root, "lessons", "not-a-file.md"));
		expect(listEntries(root).map((e) => e.title)).toEqual([lesson.title]);
	});
});
