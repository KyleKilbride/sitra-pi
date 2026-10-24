import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	CLAUDE_CONTEXT_MAX,
	CODEX_CONTEXT_CHARS,
	checkHooksFile,
	hooksWithGrimoire,
	installGrimoireHooks,
	runGrimoireCli,
} from "../cli/grimoire.ts";
import {
	catalogueOverflowFile,
	type Entry,
	LIMITS,
	listProposals,
	projectCatalogue,
	readEntry,
	renderEntry,
} from "../extensions/grimoire.ts";
import { snapshot } from "../extensions/grimoire-ui.ts";
import { learnFromMoment, type Moment, recordMoment } from "../extensions/learn.ts";
import { type Project, readProjects, writeProjects } from "../extensions/project.ts";

vi.setConfig({ testTimeout: 30_000 });

const tempDir = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

function repo(remotes: Record<string, string> = {}): string {
	const dir = tempDir("sitra-cli-scope-repo-");
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
	git("init", "-q");
	git(
		"-c",
		"user.email=t@t",
		"-c",
		"user.name=t",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		"init",
	);
	for (const [name, url] of Object.entries(remotes)) git("remote", "add", name, url);
	return dir;
}

const project = (id: string, remotes: string[]): Project => ({
	id,
	label: id[0]?.toUpperCase() + id.slice(1),
	remotes,
	paths: [],
});

function put(dir: string, file: string, entry: Omit<Entry, "file">): void {
	mkdirSync(join(dir, file, ".."), { recursive: true });
	writeFileSync(join(dir, file), renderEntry(entry));
}

function rootFile(dir: string, name: string, text: string, scope?: string[]): void {
	mkdirSync(join(dir, "root"), { recursive: true });
	writeFileSync(join(dir, "root", name), scope ? `---\nscope: ${JSON.stringify(scope)}\n---\n${text}\n` : `${text}\n`);
}

/** Global, app and tools root files and entries, a tools-only rule, a tools rejection, and app and tools projects. */
function store(): string {
	const g = tempDir("sitra-cli-scope-grimoire-");
	rootFile(g, "README.md", "# Root\nGLOBAL-ROOT-TEXT");
	rootFile(g, "app.md", "# App\nAPP-ROOT-TEXT", ["app"]);
	rootFile(g, "tools.md", "# Tools\nTOOLS-ROOT-TEXT", ["tools"]);
	put(g, "kinds/facts/global.md", {
		kind: "fact",
		title: "Global fact",
		summary: "Applies everywhere.",
		body: "everywhere",
		date: "2026-10-01",
	});
	put(g, "kinds/facts/app.md", {
		kind: "fact",
		title: "App fact",
		summary: "Only in app.",
		body: "app",
		date: "2026-10-02",
		scope: ["app"],
	});
	put(g, "kinds/facts/tools.md", {
		kind: "fact",
		title: "Tools fact",
		summary: "Only in tools.",
		body: "TOOLS-ONLY-BODY",
		date: "2026-10-03",
		scope: ["tools"],
	});
	put(g, "kinds/warnings/release.md", {
		kind: "warning",
		title: "Tools release rule",
		body: "Tag the tools release first.",
		date: "2026-10-04",
		when: ["command:pnpm release"],
		scope: ["tools"],
	});
	put(g, "rejected/tools-idea.md", {
		kind: "lesson",
		title: "Tools rejected idea",
		body: "no",
		date: "2026-10-05",
		scope: ["tools"],
	});
	writeProjects(g, {
		projects: [project("app", ["github.com/example/app"]), project("tools", ["github.com/example/tools"])],
	});
	return g;
}

const APP_REMOTE = { origin: "https://github.com/example/app.git" };
const TOOLS_REMOTE = { origin: "git@github.com:example/tools.git" };
const OTHER_REMOTE = { origin: "https://github.com/example/demo-app.git" };

async function cli(
	g: string,
	args: string[],
	options: { cwd?: string; stdin?: unknown; home?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; out: string }> {
	const out: string[] = [];
	const code = await runGrimoireCli([...args, "--dir", g], {
		home: options.home ?? tempDir("sitra-cli-scope-home-"),
		env: { SITRA_USER_NAME: "Sam", SITRA_LEARN_SPAWN: "0", ...options.env },
		repoRoot: "/opt/sitra",
		cwd: options.cwd ?? tmpdir(),
		readStdin: () =>
			options.stdin === undefined
				? ""
				: typeof options.stdin === "string"
					? options.stdin
					: JSON.stringify(options.stdin),
		log: (l) => out.push(l),
	});
	return { code, out: out.join("\n") };
}

async function sessionHook(g: string, tool: "claude" | "codex", payload: Record<string, unknown>): Promise<string> {
	const { out } = await cli(g, ["hook", tool], { stdin: { hook_event_name: "SessionStart", ...payload } });
	return JSON.parse(out).hookSpecificOutput.additionalContext as string;
}

const sources = (matcher: string | undefined) => new Set((matcher ?? "").split("|"));

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("with no projects.json, hooks and commands are exactly what they were before projects", () => {
	function plainStore(): string {
		const g = tempDir("sitra-cli-scope-plain-");
		rootFile(g, "README.md", "# Root\nStart here.");
		put(g, "kinds/warnings/w.md", {
			kind: "warning",
			title: "Open pull requests as drafts",
			summary: "Pass --draft.",
			body: "Always pass --draft.",
			date: "2026-10-20",
			when: ["command:gh pr create"],
		});
		put(g, "kinds/facts/f.md", { kind: "fact", title: "Staging is the base branch", body: "b", date: "2026-10-21" });
		return g;
	}
	const SEARCH = "(`sitra grimoire search --dir '<G>' \"<words>\"` in the shell)";
	const PROPOSE =
		"When you learn something future agents must know (a lesson from a mistake, a fact about how things really work, a decision and its reason, a warning, a change to the agent setup), propose it: add a file to <G>/proposals named YYYY-MM-DD-short-title.md: frontmatter between --- lines with one JSON-style value per line (kind: lesson, fact, decision, warning or setup; title; date; proposedBy; evidence; summary, one sentence; tags; links, paths of related entries), then a short body. Only Sam approves entries. Never edit files in <G>/root or <G>/kinds.\n";
	const ENTRIES = `## Approved entries (2, in <G>)\nBefore each step, check whether an entry below touches what you are about to do; if one might, read it in full before acting. Don't guess what Sam would want: look it up ${SEARCH} or ask.\n\n- [warning] Open pull requests as drafts: Pass --draft. (kinds/warnings/w.md)\n- [fact] Staging is the base branch (kinds/facts/f.md)\n\n`;

	test("session hooks, search, eval and status print the same bytes, and the hooks write no session notes", async () => {
		const g = plainStore();
		const app = repo(APP_REMOTE);
		const payload = { session_id: "s1", cwd: app, source: "startup" };
		const claude = await sessionHook(g, "claude", payload);
		const codex = await sessionHook(g, "codex", payload);
		expect(claude.replaceAll(g, "<G>")).toBe(`# Grimoire: Sam's approved knowledge\n\n${ENTRIES}${PROPOSE}`);
		expect(codex.replaceAll(g, "<G>")).toBe(
			`# Grimoire: Sam's approved knowledge\n\n# Root\nStart here.\n\n---\n\n${ENTRIES}${PROPOSE}`,
		);
		expect(existsSync(join(g, ".sitra", "shown"))).toBe(false);
		expect((await cli(g, ["search", "drafts"], { cwd: app })).out.replaceAll(g, "<G>")).toBe(
			"Paths are in <G>.\n- [warning] Open pull requests as drafts: Pass --draft. (kinds/warnings/w.md)",
		);
		expect((await cli(g, ["eval"], { cwd: app })).out).toBe(
			"Caught 0 of 0 corrections (0 have an expected entry with triggers). 0 cases paused only on other rules; 0 pauses showing 0 rules in total.",
		);
		expect((await cli(g, ["status"], { cwd: app })).out.replaceAll(g, "<G>")).toBe(
			"Grimoire: <G>\n  root: 1 files, 18 characters\n  approved: 2, waiting for review: 0",
		);
		expect(readFileSync(join(g, ".sitra", "root.md"), "utf8")).toBe("# Root\nStart here.\n");
	});

	test("the tool hook pauses as before, and a recorded moment has no project", async () => {
		const g = plainStore();
		const app = repo(APP_REMOTE);
		const paused = await cli(g, ["hook", "claude", "tool"], {
			stdin: { session_id: "s1", cwd: app, tool_name: "Bash", tool_input: { command: "gh pr create" } },
		});
		expect(JSON.parse(paused.out).hookSpecificOutput.permissionDecision).toBe("deny");
		await cli(g, ["hook", "claude", "prompt"], { stdin: { session_id: "s1", cwd: app, prompt: "use a draft" } });
		const [file] = readdirSync(join(g, ".sitra", "moments"));
		const moment = JSON.parse(readFileSync(join(g, ".sitra", "moments", file ?? ""), "utf8"));
		expect("project" in moment).toBe(false);
		expect("scopeNote" in moment).toBe(false);
	});

	test("install writes the same CLAUDE.md block as before", async () => {
		const g = plainStore();
		const home = tempDir("sitra-cli-scope-home-");
		mkdirSync(join(home, ".claude"));
		await cli(g, ["install"], { home });
		expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).toContain(
			"Grimoire root: the approved, always-loaded knowledge for every agent.",
		);
	});
});

describe("SessionStart coverage", () => {
	test("25b: Claude Code's session hook runs on startup, resume, clear and compact; Codex's also on fork", async () => {
		const home = tempDir("sitra-cli-scope-home-");
		mkdirSync(join(home, ".claude"));
		mkdirSync(join(home, ".codex"));
		installGrimoireHooks({ home, repoRoot: "/opt/sitra", log() {} }, store());
		const ours = (file: string) =>
			(
				JSON.parse(readFileSync(file, "utf8")).hooks.SessionStart as {
					matcher?: string;
					hooks: { command: string }[];
				}[]
			).find((g) => g.hooks.some((h) => h.command.includes("grimoire hook")));
		expect(sources(ours(join(home, ".claude", "settings.json"))?.matcher)).toEqual(
			new Set(["startup", "resume", "clear", "compact"]),
		);
		expect(sources(ours(join(home, ".codex", "hooks.json"))?.matcher)).toEqual(
			new Set(["startup", "resume", "clear", "compact", "fork"]),
		);
	});

	function narrowInstall(home: string, tool: "claude" | "codex", matcher: string): string {
		const hook = `'/opt/sitra/bin/sitra.ts' grimoire hook ${tool}`;
		const settings = hooksWithGrimoire(
			{},
			{ session: hook, prompt: `${hook} prompt`, tool: `${hook} tool`, toolMatcher: "Bash" },
		);
		const group = settings.hooks.SessionStart?.[0];
		if (group) group.matcher = matcher;
		const file = join(home, tool === "claude" ? ".claude/settings.json" : ".codex/hooks.json");
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, JSON.stringify(settings));
		return file;
	}

	test("25c: an install whose session hook misses sources says which, in the check, the status and /grimoire-ui", async () => {
		const home = tempDir("sitra-cli-scope-home-");
		const claude = narrowInstall(home, "claude", "startup");
		const codex = narrowInstall(home, "codex", "startup|resume|clear|compact");
		writeFileSync(
			join(home, ".claude", "CLAUDE.md"),
			"<!-- sitra grimoire: start (managed by `sitra grimoire install`) -->\n@/x\n<!-- sitra grimoire: end -->\n",
		);
		const missing = "installed (session hook misses: resume, clear, compact; run sitra grimoire install)";
		expect(checkHooksFile(claude, "claude")).toMatchObject({
			missing: ["resume", "clear", "compact"],
			status: missing,
		});
		expect(checkHooksFile(codex, "codex").status).toBe(
			"installed (session hook misses: fork; run sitra grimoire install)",
		);
		const status = (await cli(store(), ["status"], { home, cwd: repo(APP_REMOTE) })).out;
		expect(status).toContain(`Claude Code hooks: ${missing}`);
		expect(status).toContain("Codex hooks: installed (session hook misses: fork; run sitra grimoire install)");
		const ui = snapshot(store(), { HOME: home, SITRA_HOME: join(home, ".sitra") });
		expect(ui.whatAgentsGet.hooks.claudeCode.status).toBe(missing);
		expect(ui.whatAgentsGet.hooks.codex.status).toBe(
			"installed (session hook misses: fork; run sitra grimoire install)",
		);
	});

	test("25d: compact and resume re-inject the same project part as startup, and a later cwd doesn't switch it", async () => {
		const g = store();
		const app = repo(APP_REMOTE);
		const startup = await sessionHook(g, "claude", { session_id: "s1", cwd: app, source: "startup" });
		expect(startup).toContain("APP-ROOT-TEXT");
		expect(await sessionHook(g, "claude", { session_id: "s1", cwd: app, source: "compact" })).toBe(startup);
		expect(await sessionHook(g, "claude", { session_id: "s1", cwd: app, source: "resume" })).toBe(startup);
		expect(await sessionHook(g, "claude", { session_id: "s2", cwd: app, source: "compact" })).toBe(startup);
		const tools = repo(TOOLS_REMOTE);
		expect(await sessionHook(g, "claude", { session_id: "s1", cwd: tools, source: "compact" })).toBe(startup);
	});
});

describe("the session hooks load global plus the session's project", () => {
	test("26: Claude Code's hook carries app's root and entries only, within 9,500, with an over-cap root cut and named", async () => {
		const g = store();
		const app = repo(APP_REMOTE);
		const text = await sessionHook(g, "claude", { session_id: "s1", cwd: app, source: "startup" });
		expect(text).toContain("APP-ROOT-TEXT");
		expect(text).toContain("App fact");
		expect(text).not.toContain("GLOBAL-ROOT-TEXT");
		expect(text).not.toContain("Global fact");
		expect(text).not.toContain("Tools");
		expect(text).toContain(join(g, ".sitra", "root.md"));
		expect(text.length).toBeLessThanOrEqual(CLAUDE_CONTEXT_MAX);

		rootFile(g, "app.md", `# App\n${"long app rule line\n".repeat(400)}`, ["app"]);
		const cut = await sessionHook(g, "claude", { session_id: "s2", cwd: app, source: "startup" });
		expect(cut).toContain("The root for project app is cut off here");
		expect(cut).toContain(`Read the rest in ${join(g, "root")}`);
		expect(cut.length).toBeLessThanOrEqual(CLAUDE_CONTEXT_MAX);
	});

	function manyAppEntries(g: string, n: number, title: (i: number) => string, summary: string): void {
		for (let i = 0; i < n; i++) {
			put(g, `kinds/lessons/app-${String(i).padStart(2, "0")}.md`, {
				kind: "lesson",
				title: title(i),
				summary,
				body: "b",
				date: "2026-10-10",
				scope: ["app"],
			});
		}
	}

	test("26b: the project catalogue steps down to titles only, then to an overflow file it names, never cutting silently", async () => {
		expect(CLAUDE_CONTEXT_MAX).toBe(9_500);
		expect(CODEX_CONTEXT_CHARS).toBe(46_000);
		expect(LIMITS).toEqual({
			rootChars: 32_000,
			globalRootChars: 26_000,
			projectRootChars: 6_000,
			catalogueChars: 12_000,
			queryChars: 4_000,
		});
		const app = repo(APP_REMOTE);

		const few = store();
		manyAppEntries(few, 5, (i) => `Small rule ${i}`, "A short summary.");
		const fewText = await sessionHook(few, "claude", { session_id: "s", cwd: app, source: "startup" });
		expect(fewText).toContain("- [lesson] Small rule 0: A short summary. (kinds/lessons/app-00.md)");
		expect(existsSync(catalogueOverflowFile(few, "app"))).toBe(false);

		const bigAppRoot = `# App\n${"an app rule that takes room\n".repeat(180)}`;
		const medium = store();
		rootFile(medium, "app.md", bigAppRoot, ["app"]);
		manyAppEntries(medium, 30, (i) => `Medium rule ${i}`, "x".repeat(150));
		const mediumText = await sessionHook(medium, "claude", { session_id: "s", cwd: app, source: "startup" });
		expect(mediumText).toContain("- [lesson] Medium rule 0 (kinds/lessons/app-00.md)");
		expect(mediumText).not.toContain("x".repeat(150));
		expect(mediumText).not.toContain("more App entries");
		expect(existsSync(catalogueOverflowFile(medium, "app"))).toBe(false);

		const many = store();
		rootFile(many, "app.md", bigAppRoot, ["app"]);
		rmSync(join(many, "kinds/facts/app.md"));
		manyAppEntries(many, 60, (i) => `A rather long rule title for the app project, number ${i}`, "y".repeat(120));
		const text = await sessionHook(many, "claude", { session_id: "s", cwd: app, source: "startup" });
		expect(text.length).toBeLessThanOrEqual(CLAUDE_CONTEXT_MAX);
		expect(text).not.toContain("y".repeat(120));
		const file = catalogueOverflowFile(many, "app");
		const more = /- …and (\d+) more App entries \(showing (\d+) of (\d+)\): full list in (\S+);/.exec(text);
		expect(more?.[4]).toBe(file);
		const [n, x, y] = [Number(more?.[1]), Number(more?.[2]), Number(more?.[3])];
		expect(y).toBe(60);
		expect(x + n).toBe(60);
		expect(x).toBeGreaterThan(0);
		expect(text.match(/^- \[\w+\] .* \(kinds\/.*\.md\)$/gm)).toHaveLength(x);
		const full = readFileSync(file, "utf8");
		expect(
			full.match(/^- \[lesson\] A rather long rule title .*: y+ \(kinds\/lessons\/app-\d\d\.md\)$/gm),
		).toHaveLength(60);
	});

	test("26b: projectCatalogue says what it did, so no caller has to infer it", () => {
		const entries: Entry[] = Array.from({ length: 60 }, (_, i) => ({
			kind: "lesson",
			title: `Rule number ${i} with a fairly long title`,
			summary: "z".repeat(100),
			body: "b",
			date: "2026-10-10",
			file: `kinds/lessons/r-${i}.md`,
		}));
		const dir = tempDir("sitra-cli-scope-cat-");
		const file = catalogueOverflowFile(dir, "app");
		const opts = { label: "App", search: "`sitra grimoire search --project app`" };
		const full = projectCatalogue(entries.slice(0, 3), 10_000, file, opts);
		expect(full).toMatchObject({ shown: 3, titlesOnly: false });
		expect(full.overflow).toBeUndefined();
		const titles = projectCatalogue(entries, 5_000, file, opts);
		expect(titles).toMatchObject({ shown: 60, titlesOnly: true });
		expect(titles.text.length).toBeLessThanOrEqual(5_000);
		const cut = projectCatalogue(entries, 1_500, file, opts);
		expect(cut.titlesOnly).toBe(true);
		expect(cut.overflow).toEqual({ count: 60 - cut.shown, file });
		expect(cut.text.length).toBeLessThanOrEqual(1_500);
		expect(cut.text).toContain(`…and ${60 - cut.shown} more App entries (showing ${cut.shown} of 60)`);
	});

	test("27: Codex's hook carries global and app root and entries, within 46,000, and nothing of tools", async () => {
		const g = store();
		const text = await sessionHook(g, "codex", { session_id: "s1", cwd: repo(APP_REMOTE), source: "startup" });
		for (const want of ["GLOBAL-ROOT-TEXT", "APP-ROOT-TEXT", "Global fact", "App fact", "--project app"])
			expect(text).toContain(want);
		expect(text).not.toContain("Tools");
		expect(text.length).toBeLessThanOrEqual(CODEX_CONTEXT_CHARS);
	});

	test("28: no cwd, or a folder with no project, loads global only and says why", async () => {
		const g = store();
		for (const tool of ["claude", "codex"] as const) {
			const noCwd = await sessionHook(g, tool, { session_id: `n-${tool}`, source: "startup" });
			expect(noCwd).toContain("global only");
			expect(noCwd).toContain("no cwd");
			expect(noCwd).not.toContain("App fact");
			const other = await sessionHook(g, tool, { session_id: `o-${tool}`, cwd: repo(OTHER_REMOTE), source: "startup" });
			expect(other).toContain("global only");
			expect(other).toContain("remote not attached: github.com/example/demo-app");
			expect(other).not.toContain("App fact");
			expect(other).not.toContain("Tools");
		}
	});

	test("29: Claude Code's imported root file holds the global root and global entries, nothing scoped", async () => {
		const g = store();
		await sessionHook(g, "claude", { session_id: "s1", cwd: repo(APP_REMOTE), source: "startup" });
		const root = readFileSync(join(g, ".sitra", "root.md"), "utf8");
		expect(root).toContain("GLOBAL-ROOT-TEXT");
		expect(root).toContain("- [fact] Global fact: Applies everywhere. (kinds/facts/global.md)");
		for (const scoped of ["APP-ROOT-TEXT", "TOOLS-ROOT-TEXT", "App fact", "Tools fact", "Tools release rule"])
			expect(root).not.toContain(scoped);
	});
});

describe("the tool and prompt hooks use the session's project", () => {
	test("30: a tools-scoped rule never pauses a session started in app, even after a cd into tools", async () => {
		const g = store();
		const app = repo(APP_REMOTE);
		const tools = repo(TOOLS_REMOTE);
		const call = (session: string, cwd: string) =>
			cli(g, ["hook", "claude", "tool"], {
				stdin: { session_id: session, cwd, tool_name: "Bash", tool_input: { command: "pnpm release" } },
			});
		await sessionHook(g, "claude", { session_id: "s1", cwd: app, source: "startup" });
		expect((await call("s1", app)).out).toBe("");
		expect((await call("s1", tools)).out).toBe("");
		await sessionHook(g, "claude", { session_id: "s2", cwd: tools, source: "startup" });
		expect(JSON.parse((await call("s2", tools)).out).hookSpecificOutput.permissionDecisionReason).toContain(
			"Tag the tools release first.",
		);
	});

	test("31: the UserPromptSubmit hook records the session's project in the moment", async () => {
		const g = store();
		const app = repo(APP_REMOTE);
		await sessionHook(g, "claude", { session_id: "s1", cwd: app, source: "startup" });
		await cli(g, ["hook", "claude", "prompt"], { stdin: { session_id: "s1", cwd: app, prompt: "no, use a draft" } });
		await cli(g, ["hook", "codex", "prompt"], {
			stdin: { session_id: "s9", cwd: repo(OTHER_REMOTE), prompt: "stop that" },
		});
		const moments = readdirSync(join(g, ".sitra", "moments")).map(
			(f) => JSON.parse(readFileSync(join(g, ".sitra", "moments", f), "utf8")) as Moment,
		);
		expect(moments.find((m) => m.message === "no, use a draft")?.project).toBe("app");
		const other = moments.find((m) => m.message === "stop that");
		expect(other?.project).toBeUndefined();
		expect(other?.scopeNote).toContain("remote not attached");
	});
});

describe("the learner", () => {
	const moment = (id: string, extra: Partial<Moment> = {}): Moment => ({
		id,
		at: "2026-10-22T10:00:00.000Z",
		harness: "claude",
		cwd: "/work/demo-app",
		message: "No, always open it as a draft",
		agentReply: "I opened the PR.",
		calls: [{ tool: "Bash", input: { command: "gh pr create" } }],
		...extra,
	});
	const draft = JSON.stringify({
		kind: "lesson",
		title: "Open drafts",
		summary: "Pass --draft.",
		body: "The person wants drafts.",
	});

	test("32: proposals take the moment's project, old moments stay global, and dedupe sees global, app and every rejection", async () => {
		const g = store();
		put(g, "proposals/tools-pending.md", {
			kind: "fact",
			title: "Tools pending proposal",
			body: "p",
			date: "2026-10-06",
			scope: ["tools"],
		});
		recordMoment(g, moment("m-app", { project: "app" }));
		recordMoment(g, moment("m-old"));
		recordMoment(
			g,
			moment("m-none", { scopeNote: "proposed as global: remote not attached: github.com/example/demo-app" }),
		);
		const asked: string[] = [];
		const ask = async (_system: string, user: string) => {
			asked.push(user);
			return asked.length % 2 === 1 ? "YES" : draft;
		};
		const app = await learnFromMoment(g, "m-app", ask);
		const appEntry = readEntry(readFileSync(join(g, app.proposal ?? ""), "utf8"), app.proposal ?? "").entry;
		expect(appEntry?.scope).toEqual(["app"]);
		const user = asked[1] ?? "";
		for (const want of ["App fact", "Global fact", "APP-ROOT-TEXT", "Tools rejected idea"])
			expect(user).toContain(want);
		for (const hidden of ["Tools fact", "Tools release rule", "Tools pending proposal", "TOOLS-ROOT-TEXT"])
			expect(user).not.toContain(hidden);

		const old = await learnFromMoment(g, "m-old", ask);
		const oldEntry = readEntry(readFileSync(join(g, old.proposal ?? ""), "utf8"), old.proposal ?? "").entry;
		expect(oldEntry?.scope).toBeUndefined();
		expect(oldEntry?.scopeNote).toBeUndefined();
		expect(asked[3]).not.toContain("App fact");
		expect(asked[3]).toContain("Tools rejected idea");

		const none = await learnFromMoment(g, "m-none", ask);
		const noneEntry = readEntry(readFileSync(join(g, none.proposal ?? ""), "utf8"), none.proposal ?? "").entry;
		expect(noneEntry?.scope).toBeUndefined();
		expect(noneEntry?.scopeNote).toContain("remote not attached");
	});

	test("33: eval doesn't count a tools rule as catching an app case, and cases without a project use global rules only", async () => {
		const g = store();
		put(g, "kinds/warnings/deploy.md", {
			kind: "warning",
			title: "App deploy rule",
			body: "Deploy app from main.",
			date: "2026-10-07",
			when: ["command:pnpm deploy"],
			scope: ["app"],
		});
		const bash = (command: string) => [{ tool: "Bash", input: { command } }];
		const cases = [
			{
				id: "c-app",
				harness: "claude",
				cwd: "/work",
				calls: bash("pnpm release"),
				expect: ["kinds/warnings/release.md"],
				project: "app",
			},
			{
				id: "c-tools",
				harness: "claude",
				cwd: "/work",
				calls: bash("pnpm release"),
				expect: ["kinds/warnings/release.md"],
				project: "tools",
			},
			{
				id: "c-none",
				harness: "claude",
				cwd: "/work",
				calls: bash("pnpm deploy"),
				expect: ["kinds/warnings/deploy.md"],
			},
		];
		const file = join(g, "cases.jsonl");
		writeFileSync(file, cases.map((c) => JSON.stringify(c)).join("\n"));
		const { out } = await cli(g, ["eval", file, "--all"], { cwd: repo(APP_REMOTE) });
		expect(out).toContain("Caught 1 of 3 corrections");
		expect(out).toContain("caught c-tools");
		expect(out).not.toContain("c-app");
		expect(out).not.toContain("c-none");
		expect(out).toContain("1 case had no project and ran against global rules only");
	});
});

describe("CLI commands take the project", () => {
	test("34: search defaults to this folder's project and says so; --project, --global-only and --all choose", async () => {
		const g = store();
		const app = repo(APP_REMOTE);
		const here = await cli(g, ["search", "fact"], { cwd: app });
		expect(here.out).toContain("Project: App (app), from remote origin.");
		expect(here.out).toContain("Global fact");
		expect(here.out).toContain("App fact");
		expect(here.out).not.toContain("Tools fact");

		const tools = await cli(g, ["search", "fact", "--project", "tools"], { cwd: app });
		expect(tools.out).toContain("Project: Tools (tools), chosen with --project.");
		expect(tools.out).toContain("Tools fact");
		expect(tools.out).not.toContain("App fact");

		const all = await cli(g, ["search", "--all", "fact"], { cwd: app });
		expect(all.out).toContain("(kinds/facts/tools.md) [scope: tools]");
		expect(all.out).toContain("(kinds/facts/global.md) [global]");

		const global = await cli(g, ["search", "fact", "--global-only"], { cwd: app });
		expect(global.out).toContain("Global fact");
		expect(global.out).not.toContain("App fact");

		const none = await cli(g, ["search", "fact"], { cwd: repo(OTHER_REMOTE) });
		expect(none.out).toContain(
			"No project here (remote not attached: github.com/example/demo-app): global entries only.",
		);
		expect(none.out).not.toContain("App fact");

		const bad = await cli(g, ["search", "fact", "--project", "nope"], { cwd: app });
		expect(bad.code).toBe(1);
		expect(bad.out).toContain("app, tools");
	});

	test("34: status names the project and counts per part; --all counts every project", async () => {
		const g = store();
		const here = (await cli(g, ["status"], { cwd: repo(APP_REMOTE) })).out;
		expect(here).toContain("Project: App (app), from remote origin.");
		expect(here).toContain("approved: 1 global + 1 for App");
		const all = (await cli(g, ["status", "--all"], { cwd: repo(APP_REMOTE) })).out;
		expect(all).toContain("approved: 4 (1 global, app 1, tools 2)");
	});

	test("35: scope sets or clears the scope of exactly the listed files and keeps unknown keys", async () => {
		const g = store();
		writeFileSync(
			join(g, "kinds/facts/global.md"),
			readFileSync(join(g, "kinds/facts/global.md"), "utf8").replace("---\n\n", 'owner: "someone"\n---\n\n'),
		);
		const before = readFileSync(join(g, "kinds/facts/tools.md"), "utf8");
		const set = await cli(g, ["scope", "kinds/facts/global.md", "kinds/warnings/release.md", "--project", "app"]);
		expect(set.code).toBe(0);
		const global = readFileSync(join(g, "kinds/facts/global.md"), "utf8");
		expect(global).toContain('scope: ["app"]');
		expect(global).toContain('owner: "someone"');
		expect(readFileSync(join(g, "kinds/warnings/release.md"), "utf8")).toContain('scope: ["app"]');
		expect(readFileSync(join(g, "kinds/facts/tools.md"), "utf8")).toBe(before);

		await cli(g, ["scope", "kinds/facts/global.md", "--global"]);
		const cleared = readFileSync(join(g, "kinds/facts/global.md"), "utf8");
		expect(cleared).not.toContain("scope:");
		expect(cleared).toContain('owner: "someone"');

		const both = await cli(g, ["scope", "kinds/facts/app.md", "--project", "app", "--project", "tools"]);
		expect(both.code).toBe(0);
		expect(readFileSync(join(g, "kinds/facts/app.md"), "utf8")).toContain('scope: ["app","tools"]');
		expect((await cli(g, ["scope", "kinds/facts/app.md", "--project", "nope"])).code).toBe(1);
		expect((await cli(g, ["scope", "kinds/facts/app.md", "--global", "--project", "app"])).code).toBe(1);
	});

	test("36: projects add refuses a remote already on another project, and stores folder paths as real paths", async () => {
		const g = tempDir("sitra-cli-scope-projects-");
		expect((await cli(g, ["projects", "add", "app", "--remote", "https://github.com/Example/App.git"])).code).toBe(0);
		const clash = await cli(g, ["projects", "add", "tools", "--remote", "git@github.com:example/app.git"]);
		expect(clash.code).toBe(1);
		expect(clash.out).toContain("github.com/example/app");
		expect(readProjects(g).projects.map((p) => p.id)).toEqual(["app"]);

		const folder = tempDir("sitra-cli-scope-folder-");
		const link = join(tempDir("sitra-cli-scope-link-"), "demo-app");
		symlinkSync(folder, link);
		expect((await cli(g, ["projects", "add", "demo-app", "--path", link])).code).toBe(0);
		expect(readProjects(g).projects.find((p) => p.id === "demo-app")?.paths).toEqual([folder]);
		const list = (await cli(g, ["projects", "list"])).out;
		expect(list).toContain("github.com/example/app");
		expect(list).toContain(folder);
	});

	test("import scopes proposals to the repo's project, or says why they are global", async () => {
		const g = store();
		const withKb = (remotes: Record<string, string>) => {
			const r = repo(remotes);
			put(r, ".pi/knowledge/lessons/old.md", {
				kind: "lesson",
				title: `Old lesson ${r}`,
				body: "b",
				date: "2026-09-01",
			});
			return r;
		};
		await cli(g, ["import", withKb(APP_REMOTE)]);
		await cli(g, ["import", withKb(OTHER_REMOTE)]);
		const imported = listProposals(g).filter((p) => p.title.startsWith("Old lesson"));
		expect(imported.map((p) => p.scope)).toContainEqual(["app"]);
		expect(imported.find((p) => !p.scope)?.scopeNote).toContain("remote not attached: github.com/example/demo-app");
	});
});
