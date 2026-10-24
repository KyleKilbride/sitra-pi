import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	catalogue,
	decide,
	type Entry,
	entriesFor,
	grimoireDir,
	grimoireSection,
	importKnowledge,
	LIMITS,
	linkReport,
	listEntries,
	listProposals,
	loadRoot,
	parseEntry,
	rankEntries,
	readEntry,
	renderEntry,
	searchEntries,
	setScope,
	slug,
	unreadableProposals,
	writeProposal,
} from "../extensions/grimoire.ts";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "sitra-grimoire-")));

const lesson = {
	kind: "lesson" as const,
	title: "Read the eval failures before claiming anything",
	body: "Seven eval jobs were red and nobody read which cases failed.",
	evidence: "a team postmortem, section 1",
	proposedBy: "planner",
	date: "2026-10-08T14:00:00.000Z",
	summary: "Open the failing cases before saying anything about a red eval run.",
	tags: ["evals", "debugging"],
	links: ["kinds/decisions/2026-10-01-evals-are-not-truth.md"],
	when: ["command:pnpm test", "path:evals/**"],
};

function put(dir: string, file: string, entry: Omit<Entry, "file">): void {
	mkdirSync(join(dir, file, ".."), { recursive: true });
	writeFileSync(join(dir, file), renderEntry(entry));
}

/** A small Grimoire with entries about different things, like a real one. */
function sampleGrimoire(): string {
	const dir = tmp();
	put(dir, "kinds/decisions/2026-10-01-evals-are-not-truth.md", {
		kind: "decision",
		title: "Evals are not the source of truth",
		summary: "Never change the app just to make an eval pass; check whether the eval's assertion is right first.",
		tags: ["evals", "testing"],
		body: "An eval can encode the wrong intent. When one fails, decide whether the eval or the app is wrong before editing the app. Rewrite or delete bad evals.",
		date: "2026-10-01",
	});
	put(dir, "kinds/decisions/2026-10-02-no-regex-on-ai-input.md", {
		kind: "decision",
		title: "No regex on AI output or user input",
		summary: "Don't use regular expressions or string matching to interpret model output or what a user typed.",
		tags: ["agents", "classification"],
		body: "Non-deterministic text needs a classifier or structured output, not a regex.",
		date: "2026-10-02",
	});
	put(dir, "kinds/warnings/2026-10-03-one-builder-per-pr.md", {
		kind: "warning",
		title: "One builder per pull request",
		summary: "Never have two builders pushing to the same pull request.",
		tags: ["process", "git"],
		body: "Two builders on one branch caused dual pushes and lost work.",
		date: "2026-10-03",
	});
	put(dir, "kinds/setups/2026-10-04-short-plain-replies.md", {
		kind: "setup",
		title: "Talk to the person in short, plain replies",
		summary: "Lead with the ask in one line, plain words, no file paths or IDs.",
		tags: ["communication"],
		body: "They read the first line and skim the rest.",
		date: "2026-10-04",
	});
	put(dir, "kinds/lessons/2026-10-05-flights-search-relaxes-nonstop.md", {
		kind: "lesson",
		title: "Flight search relaxes the nonstop preference when nothing matches",
		summary: "When no nonstop flights exist the search drops the nonstop filter and says so.",
		tags: ["flights", "search"],
		body: "Check the search's relaxation step before blaming the agent for showing one-stop flights.",
		date: "2026-10-05",
	});
	return dir;
}

describe("Grimoire entries", () => {
	test("render and parse round-trip, including summary, tags and links", () => {
		const text = renderEntry(lesson);
		expect(text.startsWith("---\n")).toBe(true);
		expect(text).toContain('tags: ["evals","debugging"]');
		expect(parseEntry(text, "kinds/lessons/x.md")).toEqual({ ...lesson, file: "kinds/lessons/x.md" });
	});

	test("keys it doesn't know survive parse and render, in order, even when the value isn't valid JSON", () => {
		const raw = [
			"---",
			'kind: "fact"',
			'title: "Keeps extras"',
			'date: "2026-10-01"',
			'rejectedReason: "dup"',
			"rejectedBy: demo-reviewer",
			"status: [not json",
			'rejectedOn: "2026-10-02"',
			"---",
			"",
			"Body.",
			"",
		].join("\n");
		const entry = parseEntry(raw, "x.md");
		expect(entry?.extra?.map((e) => e.key)).toEqual(["rejectedReason", "rejectedBy", "status", "rejectedOn"]);
		expect(entry?.extra?.[2]?.raw).toBe("status: [not json");
		const { file: _file, ...rest } = entry as Entry;
		expect(renderEntry(rest)).toBe(raw);
		expect(parseEntry(renderEntry(rest), "x.md")).toEqual(entry);
	});

	test("old /kb entries still parse, and plain comma lists are read as tags", () => {
		const old = "---\nkind: warning\ntitle: Don't force push\ndate: 2026-10-01\n---\nBody.";
		expect(parseEntry(old, "x.md")).toEqual({
			kind: "warning",
			title: "Don't force push",
			date: "2026-10-01",
			body: "Body.",
			file: "x.md",
		});
		const plain = "---\nkind: fact\ntitle: T\ndate: 2026-10-01\ntags: flights, hotels\n---\nB";
		expect(parseEntry(plain, "x.md")?.tags).toEqual(["flights", "hotels"]);
	});

	test("an entry without frontmatter or with an unknown kind is not an entry", () => {
		expect(parseEntry("# just notes", "x.md")).toBeUndefined();
		expect(parseEntry("---\nkind: rumor\ntitle: t\ndate: d\n---\nbody", "x.md")).toBeUndefined();
	});

	test("slugs are short and safe", () => {
		expect(slug("Don't force-push a colleague's branch!")).toBe("don-t-force-push-a-colleague-s-branch");
		expect(slug("x".repeat(100)).length).toBeLessThanOrEqual(60);
		expect(slug("!!!")).toBe("entry");
	});
});

describe("Grimoire store", () => {
	test("agents propose into proposals/, the person accepts into kinds/ or rejects into rejected/", () => {
		const dir = tmp();
		const a = writeProposal(dir, lesson);
		const b = writeProposal(dir, lesson);
		expect(a).toBe("proposals/2026-10-08-read-the-eval-failures-before-claiming-anything.md");
		expect(b).toBe("proposals/2026-10-08-read-the-eval-failures-before-claiming-anything-2.md");
		expect(listProposals(dir).map((p) => p.title)).toEqual([lesson.title, lesson.title]);
		expect(listEntries(dir)).toEqual([]);

		expect(decide(dir, a, "accept")).toBe(
			"kinds/lessons/2026-10-08-read-the-eval-failures-before-claiming-anything.md",
		);
		expect(decide(dir, b, "reject")).toBe("rejected/2026-10-08-read-the-eval-failures-before-claiming-anything-2.md");
		expect(listProposals(dir)).toEqual([]);
		expect(listEntries(dir).map((e) => e.file)).toEqual([
			"kinds/lessons/2026-10-08-read-the-eval-failures-before-claiming-anything.md",
		]);
		const accepted = listEntries(dir)[0];
		expect(accepted?.tags).toEqual(["evals", "debugging"]);
	});

	test("accepting can change the kind, and a proposal that can't be read is reported, not hidden", () => {
		const dir = tmp();
		const file = writeProposal(dir, lesson);
		const accepted = decide(dir, file, "accept", { kind: "warning" });
		expect(accepted).toMatch(/^kinds\/warnings\//);
		expect(listEntries(dir).find((e) => e.file === accepted)?.kind).toBe("warning");
		writeFileSync(join(dir, "proposals", "2026-10-09-odd.md"), "---\nkind: direction\ntitle: t\ndate: d\n---\nb");
		expect(listProposals(dir)).toEqual([]);
		expect(unreadableProposals(dir)).toEqual(["proposals/2026-10-09-odd.md"]);
	});

	test("the folder is $SITRA_GRIMOIRE, else grimoire/ in the Pi profile, else in ~/.sitra/profile", () => {
		expect(grimoireDir({ SITRA_GRIMOIRE: "/g", PI_CODING_AGENT_DIR: "/p" }, "/home/x")).toBe("/g");
		expect(grimoireDir({ PI_CODING_AGENT_DIR: "/p" }, "/home/x")).toBe("/p/grimoire");
		expect(grimoireDir({}, "/home/x")).toBe("/home/x/.sitra/profile/grimoire");
	});
});

describe("the always-loaded root", () => {
	test("loads every root file, README first, without frontmatter, and caps the size", () => {
		const dir = tmp();
		mkdirSync(join(dir, "root"));
		writeFileSync(
			join(dir, "root", "company.md"),
			`---\nkind: fact\ntitle: c\n---\n\n# Company\nWe make travel software.\n${"More about the company.\n".repeat(30)}`,
		);
		writeFileSync(join(dir, "root", "README.md"), "# Start here\nThree layers.\n");
		writeFileSync(join(dir, "root", "notes.txt"), "not markdown");
		const root = loadRoot(dir);
		expect(root.files).toEqual(["root/README.md", "root/company.md"]);
		expect(root.text.indexOf("Start here")).toBeLessThan(root.text.indexOf("We make travel software"));
		expect(root.text).not.toContain("kind: fact");
		expect(root.truncated).toBe(false);

		const capped = loadRoot(dir, undefined, 300);
		expect(capped.truncated).toBe(true);
		expect(capped.text.length).toBeLessThanOrEqual(300);
		expect(capped.text).toContain("Start here");
		expect(capped.text).toContain(join(dir, "root"));
		expect(loadRoot(tmp())).toMatchObject({ text: "", files: [], chars: 0, truncated: false });
	});

	test("the system prompt section holds the root, a one-line catalogue of approved entries, and how to propose", () => {
		const dir = sampleGrimoire();
		mkdirSync(join(dir, "root"));
		writeFileSync(join(dir, "root", "README.md"), "# Start here\n");
		const section = grimoireSection(dir, loadRoot(dir), listEntries(dir), { who: "Sam" });
		expect(section).toContain("# Start here");
		expect(section).toContain("Approved entries (5,");
		expect(section).toContain(
			"- [decision] Evals are not the source of truth: Never change the app just to make an eval pass; check whether the eval's assertion is right first. (kinds/decisions/2026-10-01-evals-are-not-truth.md)",
		);
		expect(section).not.toContain("An eval can encode the wrong intent");
		expect(section).toContain("grimoire_search");
		expect(section).toContain("grimoire_propose");
		expect(section).toContain("Only Sam approves");
		const shell = grimoireSection(dir, undefined, listEntries(dir), { shell: true });
		expect(shell).toContain(`sitra grimoire search --dir '${dir}' "<words>"`);
		expect(shell).toContain(join(dir, "proposals"));
		expect(shell).not.toContain("grimoire_propose");
		expect(shell).not.toContain("# Start here");
		expect(grimoireSection(dir, loadRoot(dir), listEntries(dir))).toBe(
			grimoireSection(dir, loadRoot(dir), listEntries(dir)),
		);
	});
});

describe("the catalogue and search", () => {
	test("the catalogue puts warnings first, newest first within a kind, and counts what doesn't fit", () => {
		const entries = listEntries(sampleGrimoire());
		const lines = catalogue(entries).split("\n");
		expect(lines[0]).toMatch(/^- \[warning\] One builder per pull request/);
		expect(lines[1]).toMatch(/^- \[decision\] No regex/);
		expect(lines[2]).toMatch(/^- \[decision\] Evals are not/);
		expect(lines).toHaveLength(5);
		const shortText = catalogue(entries, 300);
		expect(shortText.length).toBeLessThanOrEqual(300);
		const short = shortText.split("\n");
		expect(short.length).toBeLessThan(5);
		expect(short.at(-1)).toMatch(/^- …and \d+ more\. Find them with grimoire_search\.$/);
	});

	test("search ranks the entry that matches the query first", () => {
		const entries = listEntries(sampleGrimoire());
		const ranked = rankEntries(entries, "the evals keep failing, should I change the app so they pass?");
		expect(ranked[0]?.entry.title).toBe("Evals are not the source of truth");
		const flights = rankEntries(entries, "why are we showing one-stop flights when I asked for nonstop?");
		expect(flights[0]?.entry.title).toBe("Flight search relaxes the nonstop preference when nothing matches");
		expect(rankEntries(entries, "ok sounds good, thanks")).toEqual([]);
		expect(searchEntries(entries, "regex user input").split("\n")[0]).toContain("No regex on AI output or user input");
		expect(searchEntries(entries, "kubernetes")).toBe('Nothing in Grimoire matches "kubernetes".');
	});
});

describe("moving a repo's old /kb into Grimoire", () => {
	test("copies approved and proposed entries into proposals, skipping titles Grimoire already has", () => {
		const repoKb = tmp();
		put(repoKb, "lessons/2026-10-01-read-evals.md", { ...lesson, date: "2026-10-01" });
		put(repoKb, "warnings/2026-10-02-dup.md", {
			kind: "warning",
			title: "One builder per pull request",
			body: "b",
			date: "2026-10-02",
		});
		put(repoKb, "proposals/2026-10-03-new.md", {
			kind: "fact",
			title: "Staging is the base",
			body: "b",
			date: "2026-10-03",
		});
		const dir = sampleGrimoire();

		const first = importKnowledge(repoKb, dir, "/work/app");
		expect(first.imported.sort()).toEqual([
			"proposals/2026-10-01-read-the-eval-failures-before-claiming-anything.md",
			"proposals/2026-10-03-staging-is-the-base.md",
		]);
		expect(first.skipped).toEqual(["warnings/2026-10-02-dup.md"]);
		const imported = readFileSync(join(dir, first.imported.sort()[0] ?? ""), "utf8");
		expect(imported).toContain("imported from /work/app");
		expect(existsSync(join(repoKb, "lessons/2026-10-01-read-evals.md"))).toBe(true);

		const second = importKnowledge(repoKb, dir, "/work/app");
		expect(second.imported).toEqual([]);
		expect(readdirSync(join(dir, "proposals"))).toHaveLength(2);
	});
});

describe("what an imported or proposed entry can't do", () => {
	test("a proposal always lands in proposals/, whatever its date says", () => {
		const dir = tmp();
		for (const date of ["../root/x", "../../etc", "2026-10-19/../../root", "not a date"]) {
			const file = writeProposal(dir, { kind: "lesson", title: "Unapproved instruction", body: "obey me", date });
			expect(file).toMatch(/^proposals\/\d{4}-\d{2}-\d{2}-unapproved-instruction(-\d+)?\.md$/);
		}
		expect(existsSync(join(dir, "root"))).toBe(false);
		expect(loadRoot(dir).text).toBe("");
		expect(listProposals(dir)).toHaveLength(4);
	});

	test("import never skips a rule just because it shares words with another, like its opposite", () => {
		const repoKb = tmp();
		put(repoKb, "decisions/a.md", { kind: "decision", title: "Use production", body: "a", date: "2026-10-01" });
		put(repoKb, "decisions/b.md", { kind: "decision", title: "Do not use production", body: "b", date: "2026-10-01" });
		put(repoKb, "decisions/c.md", { kind: "decision", title: "  use   PRODUCTION ", body: "c", date: "2026-10-01" });
		const result = importKnowledge(repoKb, tmp(), "/work/app");
		expect(result.imported).toHaveLength(2);
		expect(result.skipped).toEqual(["decisions/c.md"]);
	});
});

describe("project scope", () => {
	const head = '---\nkind: "fact"\ntitle: "T"\ndate: "2026-10-01"\n';
	const scoped = (scope: string) => `${head}scope: ${scope}\n---\n\nB\n`;

	/** A store with one global entry, one for app, one for tools and one for both. */
	function scopedGrimoire(): string {
		const dir = tmp();
		put(dir, "kinds/facts/global.md", { kind: "fact", title: "Global fact", body: "everywhere", date: "2026-10-01" });
		put(dir, "kinds/facts/app.md", {
			kind: "fact",
			title: "App fact",
			body: "app only",
			date: "2026-10-02",
			scope: ["app"],
		});
		put(dir, "kinds/facts/tools.md", {
			kind: "fact",
			title: "Tools fact",
			body: "TOOLS-ONLY-BODY",
			date: "2026-10-03",
			scope: ["tools"],
		});
		put(dir, "kinds/facts/both.md", {
			kind: "fact",
			title: "Shared fact",
			body: "app and tools",
			date: "2026-10-04",
			scope: ["app", "tools"],
		});
		return dir;
	}

	test("scope names project ids, no scope is global, and an empty list or a magic value is refused with a reason", () => {
		const entry = parseEntry(scoped('["app"]'), "x.md");
		expect(entry?.scope).toEqual(["app"]);
		expect(entry?.extra).toBeUndefined();
		const { file: _f, ...rest } = entry as Entry;
		expect(renderEntry(rest)).toContain('scope: ["app"]');
		const global = parseEntry(`${head}---\n\nB\n`, "x.md");
		expect(global).toBeDefined();
		expect(global?.scope).toBeUndefined();
		for (const [value, why] of [
			["[]", /empty/],
			['["global"]', /global/],
			['["app", 3]', /project id/],
			['[" App "]', /project id/],
			['"app"', /list/],
			["app", /list/],
		] as const) {
			expect(parseEntry(scoped(value), "x.md"), value).toBeUndefined();
			const read = readEntry(scoped(value), "x.md");
			expect(read.problem, value).toMatch(/scope/);
			expect(read.problem, value).toMatch(why);
		}
	});

	test("entriesFor gives global entries plus the project's, never another project's", () => {
		const entries = listEntries(scopedGrimoire());
		const titles = (id: string | undefined) => entriesFor(entries, id).map((e) => e.title);
		expect(titles("app").sort()).toEqual(["App fact", "Global fact", "Shared fact"]);
		expect(titles("tools").sort()).toEqual(["Global fact", "Shared fact", "Tools fact"]);
		expect(titles(undefined)).toEqual(["Global fact"]);
	});

	test("loadRoot gives the global root plus the project's, each within its own cap and the combined cap", () => {
		const dir = tmp();
		mkdirSync(join(dir, "root"));
		writeFileSync(join(dir, "root", "README.md"), "# Global start\nEveryone reads this.\n");
		writeFileSync(join(dir, "root", "app.md"), '---\nscope: ["app"]\n---\n# App root\nApp only.\n');
		writeFileSync(join(dir, "root", "tools.md"), '---\nscope: ["tools"]\n---\n# Tools root\nTools only.\n');
		writeFileSync(join(dir, "root", "broken.md"), "---\nscope: []\n---\n# Broken\n");
		const app = loadRoot(dir, "app");
		expect(app.global.files).toEqual(["root/README.md"]);
		expect(app.project.files).toEqual(["root/app.md"]);
		expect(app.text).toContain("Everyone reads this.");
		expect(app.text).toContain("App only.");
		expect(app.text).not.toContain("Tools only.");
		expect(app.text).not.toContain("# Broken");
		expect(app.problems).toEqual([{ file: "root/broken.md", problem: expect.stringMatching(/scope/) }]);
		expect(loadRoot(dir).text).not.toContain("App only.");

		expect(LIMITS).toMatchObject({ rootChars: 32_000, globalRootChars: 26_000, projectRootChars: 6_000 });
		writeFileSync(join(dir, "root", "README.md"), `# Global start\n${"Global line.\n".repeat(2_500)}`);
		writeFileSync(join(dir, "root", "app.md"), `---\nscope: ["app"]\n---\n# App root\n${"App line.\n".repeat(800)}`);
		const big = loadRoot(dir, "app");
		expect(big.global.truncated).toBe(true);
		expect(big.global.text.length).toBeLessThanOrEqual(LIMITS.globalRootChars);
		expect(big.global.text).toContain(join(dir, "root"));
		expect(big.project.truncated).toBe(true);
		expect(big.project.text.length).toBeLessThanOrEqual(LIMITS.projectRootChars);
		expect(big.project.text).toContain(join(dir, "root"));
		expect(big.text.length).toBeLessThanOrEqual(LIMITS.rootChars);
		expect(big.truncated).toBe(true);
		const small = loadRoot(dir, "app", 10_000);
		expect(small.text.length).toBeLessThanOrEqual(10_000);
		// With no project the global root may use the whole combined cap, as before projects existed.
		const solo = tmp();
		mkdirSync(join(solo, "root"));
		writeFileSync(join(solo, "root", "README.md"), "x".repeat(30_000));
		expect(loadRoot(solo).truncated).toBe(false);
	});

	test("the section for a project lists only its entries and global ones, names it, and says why when there is none", () => {
		const dir = scopedGrimoire();
		const all = listEntries(dir);
		const app = { project: { id: "app", label: "App" } };
		const section = grimoireSection(dir, undefined, entriesFor(all, "app"), { who: "Sam", scope: app });
		expect(section).toContain("App fact");
		expect(section).toContain("Shared fact");
		expect(section).not.toContain("Tools fact");
		expect(section).toContain("1 global + 2 for App");
		const shell = grimoireSection(dir, undefined, entriesFor(all, "app"), { shell: true, scope: app });
		expect(shell).toContain("--project app");
		const why = "remote not attached: github.com/example/other";
		const none = grimoireSection(dir, undefined, entriesFor(all, undefined), { scope: { why } });
		expect(none).toContain("global only");
		expect(none).toContain(why);
		expect(none).not.toContain("App fact");
		expect(grimoireSection(dir, undefined, entriesFor(all, undefined), { shell: true, scope: { why } })).toContain(
			"--global-only",
		);
	});

	test("a link never loads its target, and the link report lists out-of-scope and missing targets", () => {
		const dir = scopedGrimoire();
		put(dir, "kinds/lessons/links.md", {
			kind: "lesson",
			title: "Global lesson with links",
			body: "See kinds/facts/tools.md for the details.",
			date: "2026-10-05",
			links: ["kinds/facts/tools.md", "kinds/facts/gone.md", "kinds/facts/global.md"],
		});
		const app = entriesFor(listEntries(dir), "app");
		const section = grimoireSection(dir, loadRoot(dir, "app"), app, {
			scope: { project: { id: "app", label: "App" } },
		});
		expect(section).not.toContain("Tools fact");
		expect(section).not.toContain("TOOLS-ONLY-BODY");
		expect(searchEntries(app, "tools only body")).not.toContain("Tools fact");
		const report = linkReport(dir, "app");
		expect(report).toContainEqual({
			from: "kinds/lessons/links.md",
			target: "kinds/facts/tools.md",
			problem: "out-of-scope",
		});
		expect(report).toContainEqual({
			from: "kinds/lessons/links.md",
			target: "kinds/facts/gone.md",
			problem: "missing",
		});
		expect(report.filter((r) => r.target === "kinds/facts/global.md")).toEqual([]);
		expect(linkReport(dir, "tools").filter((r) => r.problem === "out-of-scope")).toEqual([]);
	});

	test("decide can set or clear the scope on accept and keeps keys it doesn't know", () => {
		const dir = tmp();
		const withExtra = (title: string, scope?: string[]) => {
			const file = writeProposal(dir, {
				kind: "lesson",
				title,
				body: "b",
				date: "2026-10-06",
				...(scope ? { scope } : {}),
			});
			writeFileSync(
				join(dir, file),
				readFileSync(join(dir, file), "utf8").replace("\n---\n", '\nowner: "someone"\n---\n'),
			);
			return file;
		};
		const set = decide(dir, withExtra("Set scope"), "accept", { scope: ["app"] });
		expect(readFileSync(join(dir, set), "utf8")).toContain('scope: ["app"]');
		expect(readFileSync(join(dir, set), "utf8")).toContain('owner: "someone"');
		const cleared = decide(dir, withExtra("Clear scope", ["tools"]), "accept", { scope: null });
		expect(readFileSync(join(dir, cleared), "utf8")).not.toContain("scope:");
		expect(readFileSync(join(dir, cleared), "utf8")).toContain('owner: "someone"');
		const kept = decide(dir, withExtra("Keep scope", ["tools"]), "accept", { kind: "warning" });
		expect(kept).toMatch(/^kinds\/warnings\//);
		expect(parseEntry(readFileSync(join(dir, kept), "utf8"), kept)?.scope).toEqual(["tools"]);
		expect(() => decide(dir, withExtra("Bad scope"), "accept", { scope: [] })).toThrow(/scope/);
	});

	test("setScope rewrites only the scope of the listed entries, and writes nothing when any of them can't be changed", () => {
		const dir = scopedGrimoire();
		const tools = join(dir, "kinds/facts/tools.md");
		writeFileSync(tools, readFileSync(tools, "utf8").replace("\n---\n", '\nstatus: "kept"\n---\n'));
		const before = readFileSync(join(dir, "kinds/facts/app.md"), "utf8");
		expect(setScope(dir, ["kinds/facts/global.md", "kinds/facts/tools.md"], ["app"])).toEqual([
			"kinds/facts/global.md",
			"kinds/facts/tools.md",
		]);
		expect(listEntries(dir).find((e) => e.title === "Global fact")?.scope).toEqual(["app"]);
		expect(readFileSync(tools, "utf8")).toContain('status: "kept"');
		expect(readFileSync(tools, "utf8")).toContain('scope: ["app"]');
		expect(readFileSync(join(dir, "kinds/facts/app.md"), "utf8")).toBe(before);
		setScope(dir, ["kinds/facts/tools.md"], undefined);
		expect(readFileSync(tools, "utf8")).not.toContain("scope:");
		expect(() => setScope(dir, ["kinds/facts/app.md"], ["global"])).toThrow(/global/);
		expect(() => setScope(dir, ["kinds/facts/app.md", "kinds/facts/missing.md"], ["tools"])).toThrow(/missing\.md/);
		expect(() => setScope(dir, ["../outside.md"], ["tools"])).toThrow();
		expect(readFileSync(join(dir, "kinds/facts/app.md"), "utf8")).toBe(before);
	});

	test("a rejection in one project still blocks importing the same title for another", () => {
		const dir = tmp();
		const file = writeProposal(dir, {
			kind: "decision",
			title: "Ship on Fridays",
			body: "b",
			date: "2026-10-07",
			scope: ["tools"],
		});
		decide(dir, file, "reject");
		const repoKb = tmp();
		put(repoKb, "decisions/a.md", { kind: "decision", title: "Ship on Fridays", body: "b", date: "2026-10-07" });
		put(repoKb, "decisions/b.md", { kind: "decision", title: "Ship on Mondays", body: "b", date: "2026-10-07" });
		const result = importKnowledge(repoKb, dir, "/work/demo-app", { scope: ["app"] });
		expect(result.skipped).toEqual(["decisions/a.md"]);
		expect(result.imported).toHaveLength(1);
		expect(listProposals(dir)[0]?.scope).toEqual(["app"]);
	});
});
