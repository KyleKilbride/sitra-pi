import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type Entry, listEntries, listProposals, renderEntry } from "../extensions/grimoire.ts";
import sitraKnowledge from "../extensions/knowledge.ts";
import { PROJECTS_FILE, type Project, projectFor, writeProjects } from "../extensions/project.ts";

vi.setConfig({ testTimeout: 30_000 });

const tempDir = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

function repo(remotes: Record<string, string> = {}): string {
	const dir = tempDir("sitra-scope-repo-");
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

/** A store with a global, an app and a tools entry, a tools-only rule, and app and tools projects. */
function store(): string {
	const g = tempDir("sitra-scope-grimoire-");
	put(g, "kinds/facts/global.md", { kind: "fact", title: "Global fact", body: "everywhere", date: "2026-10-01" });
	put(g, "kinds/facts/app.md", { kind: "fact", title: "App fact", body: "app", date: "2026-10-02", scope: ["app"] });
	put(g, "kinds/facts/tools.md", {
		kind: "fact",
		title: "Tools fact",
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
	writeProjects(g, {
		projects: [project("app", ["github.com/example/app"]), project("tools", ["github.com/example/tools"])],
	});
	return g;
}

const APP_REMOTE = { origin: "https://github.com/example/app.git" };
const TOOLS_REMOTE = { origin: "git@github.com:example/tools.git" };

type Handler = (event: unknown, ctx: unknown) => unknown;
interface Tool {
	execute(
		id: string,
		params: Record<string, unknown>,
		s: unknown,
		u: unknown,
		ctx: unknown,
	): Promise<{ content: { text: string }[] }>;
}

function pi(grimoire: string, resolve: typeof projectFor = projectFor, choices: string[] = []) {
	vi.stubEnv("SITRA_GRIMOIRE", grimoire);
	vi.stubEnv("SITRA_USER_NAME", "Sam");
	vi.stubEnv("PI_SUBAGENT_NAME", "");
	vi.stubEnv("SITRA_GRIMOIRE_LEARN", "0");
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, Tool>();
	const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
	sitraKnowledge(
		{
			on: (name: string, h: Handler) => handlers.set(name, h),
			registerTool: (tool: Tool & { name: string }) => tools.set(tool.name, tool),
			registerCommand: (name: string, c: { handler(args: string, ctx: unknown): Promise<void> }) =>
				commands.set(name, c),
			sendUserMessage() {},
		} as never,
		{ projectFor: resolve },
	);
	const statuses: (string | undefined)[] = [];
	const notes: string[] = [];
	const asked: { title: string; options: string[] }[] = [];
	const ctx = (cwd: string) => ({
		cwd,
		hasUI: true,
		ui: {
			setStatus: (_k: string, t: string | undefined) => statuses.push(t),
			notify: (m: string) => notes.push(m),
			select: async (title: string, options: string[]) => {
				asked.push({ title, options });
				return choices.shift();
			},
		},
	});
	const start = (cwd: string) => handlers.get("session_start")?.({}, ctx(cwd));
	const prompt = (cwd: string) => {
		const event = {
			messageType: "user",
			prompt: "hi",
			systemPromptOptions: { sections: {} as Record<string, string> },
		};
		handlers.get("before_agent_start")?.(event, ctx(cwd));
		return event.systemPromptOptions.sections.grimoire ?? "";
	};
	const call = (cwd: string, toolName: string, input: object) =>
		handlers.get("tool_call")?.({ toolName, input }, ctx(cwd)) as { block?: boolean; reason?: string } | undefined;
	const run = async (name: string, params: Record<string, unknown>, cwd: string) =>
		(await tools.get(name)?.execute("1", params, undefined, undefined, ctx(cwd)))?.content[0]?.text ?? "";
	const review = (cwd: string) => commands.get("grimoire")?.handler("", ctx(cwd));
	return { start, prompt, call, run, review, statuses, notes, asked };
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("Pi sessions see global entries plus their project's", () => {
	test("with no projects.json the prompt and status line are exactly what they were before projects existed", () => {
		const g = tempDir("sitra-scope-none-");
		mkdirSync(join(g, "root"));
		writeFileSync(join(g, "root", "README.md"), "# Root\nStart here.\n");
		put(g, "kinds/warnings/w.md", {
			kind: "warning",
			title: "Open pull requests as drafts",
			summary: "Pass --draft.",
			body: "b",
			date: "2026-10-20",
			when: ["command:gh pr create"],
		});
		put(g, "kinds/facts/f.md", { kind: "fact", title: "Staging is the base branch", body: "b", date: "2026-10-21" });
		const resolve = vi.fn(projectFor);
		const s = pi(g, resolve);
		s.start(repo(APP_REMOTE));
		expect(s.prompt(g).replaceAll(g, "<G>")).toBe(
			"# Grimoire: Sam's approved knowledge\n\n# Root\nStart here.\n\n---\n\n## Approved entries (2, in <G>)\nBefore each step, check whether an entry below touches what you are about to do; if one might, read it in full before acting. Don't guess what Sam would want: look it up (grimoire_search) or ask.\n\n- [warning] Open pull requests as drafts: Pass --draft. (kinds/warnings/w.md)\n- [fact] Staging is the base branch (kinds/facts/f.md)\n\nWhen you learn something future agents must know (a lesson from a mistake, a fact about how things really work, a decision and its reason, a warning, a change to the agent setup), propose it: use grimoire_propose. Only Sam approves entries. Never edit files in <G>/root or <G>/kinds.\n",
		);
		expect(s.statuses.at(-1)).toBe("grimoire 2");
		expect(s.call(g, "bash", { command: "gh pr create" })?.block).toBe(true);
		expect(resolve).not.toHaveBeenCalled();
		expect(s.notes).toEqual([]);
	});

	test("a session in a repo attached to app gets app and global entries, and a tools-only rule never pauses it", () => {
		const g = store();
		const app = repo(APP_REMOTE);
		const s = pi(g);
		s.start(app);
		const section = s.prompt(app);
		expect(section).toContain("Global fact");
		expect(section).toContain("App fact");
		expect(section).not.toContain("Tools fact");
		expect(section).not.toContain("Tools release rule");
		expect(s.call(app, "bash", { command: "pnpm release" })).toBeUndefined();

		const rule = join(g, "kinds/warnings/release.md");
		writeFileSync(rule, readFileSync(rule, "utf8").replace('scope: ["tools"]\n', ""));
		s.start(app);
		const paused = s.call(app, "bash", { command: "pnpm release" });
		expect(paused?.block).toBe(true);
		expect(paused?.reason).toContain("Tag the tools release first.");
	});

	test("grimoire_search from app hides tools entries, and allProjects shows them labelled by project", async () => {
		const g = store();
		const app = repo(APP_REMOTE);
		const s = pi(g);
		s.start(app);
		const found = await s.run("grimoire_search", { query: "fact" }, app);
		expect(found).toContain("Global fact");
		expect(found).toContain("App fact");
		expect(found).not.toContain("Tools fact");
		const every = await s.run("grimoire_search", { query: "fact", allProjects: true }, app);
		const line = (title: string) => every.split("\n").find((l) => l.includes(title)) ?? "";
		expect(line("Tools fact")).toContain("tools");
		expect(line("App fact")).toContain("app");
		expect(line("Global fact")).toContain("global");
	});

	test("grimoire_propose defaults to the session's project, can propose globally, and says so when there is no project", async () => {
		const g = store();
		const app = repo(APP_REMOTE);
		const s = pi(g);
		s.start(app);
		const params = { kind: "lesson", title: "Scoped lesson", summary: "s", body: "b" };
		await s.run("grimoire_propose", params, app);
		await s.run("grimoire_propose", { ...params, title: "Global lesson", scope: "global" }, app);
		const outside = tempDir("sitra-scope-nogit-");
		s.start(outside);
		const text = await s.run("grimoire_propose", { ...params, title: "Nowhere lesson" }, outside);
		expect(text).toMatch(/no project here/i);
		expect(text).toMatch(/global/i);
		const scopes = Object.fromEntries(listProposals(g).map((p) => [p.title, p.scope]));
		expect(scopes).toEqual({ "Scoped lesson": ["app"], "Global lesson": undefined, "Nowhere lesson": undefined });
	});

	test("the status line names the project, warns about other remotes, and says why there is none", () => {
		const g = store();
		const status = (cwd: string) => {
			const s = pi(g);
			s.start(cwd);
			return { line: s.statuses.at(-1) ?? "", notes: s.notes };
		};
		expect(status(repo(APP_REMOTE)).line).toContain("grimoire 1 global + 1 App");
		const warned = status(repo({ ...APP_REMOTE, upstream: "https://github.com/example/tools" })).line;
		expect(warned).toContain("1 App");
		expect(warned).toContain("upstream");
		expect(warned).toContain("Tools");
		expect(status(tempDir("sitra-scope-nogit-")).line).toContain(
			"grimoire 1 global · no project (not in a git repository)",
		);
		expect(status(repo()).line).toContain("no project (the git repository has no remote)");
		expect(status(repo({ origin: "https://github.com/example/other.git" })).line).toContain(
			"no project (remote not attached: github.com/example/other)",
		);
		const ambiguous = status(
			repo({
				origin: "https://github.com/example/other.git",
				upstream: "https://github.com/example/app",
				mirror: "https://github.com/example/tools",
			}),
		).line;
		expect(ambiguous).toContain("no project (");
		expect(ambiguous).toContain("upstream → App");
		expect(ambiguous).toContain("mirror → Tools");

		const badRemote = status(repo({ origin: "ftp://example.com/app" }));
		expect(badRemote.line).toContain("no project (");
		expect(badRemote.line).toContain("ftp://example.com/app");
		expect(badRemote.notes.join("\n")).toContain("ftp://example.com/app");
		expect(badRemote.notes.join("\n")).toMatch(/global entries only/);

		writeFileSync(join(g, PROJECTS_FILE), '{ "projects": [{ "id": "Not A Slug" }] }');
		const badRegistry = status(repo(APP_REMOTE));
		expect(badRegistry.line).toContain("no project (");
		expect(badRegistry.line).toContain(PROJECTS_FILE);
		expect(badRegistry.notes.join("\n")).toContain(PROJECTS_FILE);
		expect(badRegistry.notes.join("\n")).toMatch(/global entries only/);
	});

	test("an entry whose scope can't be read is reported in the status line, never loaded as global", () => {
		const g = store();
		writeFileSync(
			join(g, "kinds/facts/broken.md"),
			'---\nkind: "fact"\ntitle: "Broken scope"\ndate: "2026-10-05"\nscope: []\n---\n\nb\n',
		);
		const app = repo(APP_REMOTE);
		const s = pi(g);
		s.start(app);
		expect(s.prompt(app)).not.toContain("Broken scope");
		expect(s.statuses.at(-1)).toContain("1 can't be read");
	});

	test("the project is fixed at session start: a cd into another repo or a call into it doesn't switch it", () => {
		const g = store();
		const app = repo(APP_REMOTE);
		const tools = repo(TOOLS_REMOTE);
		const resolve = vi.fn(projectFor);
		const s = pi(g, resolve);
		s.start(app);
		expect(s.call(app, "bash", { command: `cd ${tools} && pnpm release` })).toBeUndefined();
		expect(s.call(app, "read", { path: join(tools, "README.md") })).toBeUndefined();
		expect(s.call(tools, "bash", { command: "pnpm release" })).toBeUndefined();
		const section = s.prompt(tools);
		expect(section).toContain("App fact");
		expect(section).not.toContain("Tools fact");
		expect(resolve).toHaveBeenCalledTimes(1);
		s.start(tools);
		expect(resolve).toHaveBeenCalledTimes(2);
		expect(s.prompt(tools)).toContain("Tools fact");
	});

	test("review shows each proposal's scope and can accept it as global or for the current project", async () => {
		const g = store();
		const app = repo(APP_REMOTE);
		const s = pi(g, projectFor, ["Accept as global", "Accept for App", "Skip"]);
		const propose = (title: string, scope?: string[]) =>
			writeFileSync(
				join(g, "proposals", `${title}.md`),
				renderEntry({ kind: "lesson", title, body: "b", date: "2026-10-06", ...(scope ? { scope } : {}) }),
			);
		mkdirSync(join(g, "proposals"), { recursive: true });
		propose("a-tools-lesson", ["tools"]);
		propose("b-global-lesson");
		writeFileSync(
			join(g, "proposals", "c-noted-lesson.md"),
			renderEntry({
				kind: "lesson",
				title: "c-noted-lesson",
				body: "b",
				date: "2026-10-06",
				scopeNote: "proposed as global: remote not attached: github.com/example/other",
			}),
		);
		s.start(app);
		await s.review(app);
		expect(s.asked[0]?.title).toContain("Scope: Tools");
		expect(s.asked[0]?.options).toEqual(
			expect.arrayContaining(["Accept", "Accept as global", "Accept for App", "Reject", "Skip"]),
		);
		expect(s.asked[1]?.title).toContain("Scope: Global");
		expect(s.asked[1]?.options).not.toContain("Accept as global");
		expect(s.asked[2]?.title).toContain(
			"Scope: Global (proposed as global: remote not attached: github.com/example/other)",
		);
		const accepted = Object.fromEntries(listEntries(g).map((e) => [e.title, e.scope]));
		expect(accepted["a-tools-lesson"]).toBeUndefined();
		expect("a-tools-lesson" in accepted).toBe(true);
		expect(accepted["b-global-lesson"]).toEqual(["app"]);
	});
});
