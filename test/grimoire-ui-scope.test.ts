import { execFileSync } from "node:child_process";
import {
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
import vm from "node:vm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CLAUDE_CONTEXT_MAX, CODEX_CONTEXT_CHARS } from "../cli/grimoire.ts";
import {
	catalogueOverflowFile,
	type Entry,
	grimoireSection,
	LIMITS,
	listEntries,
	loadRoot,
	readEntry,
	renderEntry,
	writeProposal,
} from "../extensions/grimoire.ts";
import { type GrimoireServer, renderPage, snapshot, startGrimoireServer } from "../extensions/grimoire-ui.ts";
import { type Project, readProjects, type SessionProject } from "../extensions/project.ts";

vi.setConfig({ testTimeout: 30_000 });

const tmp = (prefix = "sitra-ui-scope-") => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

const APP: Project = { id: "app", label: "App", remotes: ["github.com/example/app"], paths: [] };
const TOOLS: Project = { id: "tools", label: "Tools", remotes: ["github.com/example/tools"], paths: [] };
const inApp: SessionProject = { state: "matched", project: APP, via: "origin", warnings: [] };

function put(dir: string, file: string, entry: Omit<Entry, "file">): void {
	mkdirSync(join(dir, file, ".."), { recursive: true });
	writeFileSync(join(dir, file), renderEntry(entry));
}

function rootFile(dir: string, name: string, text: string, scope?: string[]): void {
	mkdirSync(join(dir, "root"), { recursive: true });
	writeFileSync(join(dir, "root", name), scope ? `---\nscope: ${JSON.stringify(scope)}\n---\n${text}\n` : `${text}\n`);
}

function registry(dir: string, projects: Project[] = [APP, TOOLS]): void {
	writeFileSync(join(dir, "projects.json"), `${JSON.stringify({ projects }, null, "\t")}\n`);
}

/** Global, app and tools root files and entries, and the app and tools projects. */
function store(): string {
	const g = tmp("sitra-ui-scope-grimoire-");
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
	registry(g);
	return g;
}

function repo(remotes: Record<string, string>): string {
	const dir = tmp("sitra-ui-scope-repo-");
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
		"i",
	);
	for (const [name, url] of Object.entries(remotes)) git("remote", "add", name, url);
	return dir;
}

const servers: GrimoireServer[] = [];
afterEach(async () => {
	while (servers.length > 0) await servers.pop()?.close();
});

async function serve(dir: string, extra: { cwd?: string; project?: SessionProject } = {}) {
	const srv = await startGrimoireServer({ dir, env: { HOME: dir, SITRA_USER_NAME: "Sam" }, ...extra });
	servers.push(srv);
	const api = async <T = Record<string, unknown>>(path: string, method = "GET", body?: unknown) => {
		const sep = path.includes("?") ? "&" : "?";
		const res = await fetch(`http://127.0.0.1:${srv.port}${path}${sep}token=${srv.token}`, {
			method,
			headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		return { status: res.status, data: (await res.json()) as T };
	};
	return { srv, api };
}

/**
 * Runs the page's own script against the server with a minimal stand-in for the DOM and returns each tab's rendered
 * HTML, so assertions are about what the page shows, not about the snapshot alone.
 */
async function renderTabs(srv: GrimoireServer): Promise<Record<string, string>> {
	const elements = new Map<string, Record<string, unknown>>();
	const element = (id: string) => {
		let found = elements.get(id);
		if (!found) {
			found = {
				id,
				innerHTML: "",
				textContent: "",
				value: "",
				checked: false,
				style: {},
				dataset: {},
				classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
				addEventListener() {},
				focus() {},
				setSelectionRange() {},
			};
			elements.set(id, found);
		}
		return found;
	};
	const sandbox: Record<string, unknown> = {
		document: { getElementById: element, querySelectorAll: () => [], querySelector: () => null, activeElement: null },
		fetch: (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${srv.port}${path}`, init),
		setTimeout,
		clearTimeout,
		console,
	};
	const html = renderPage(srv.token);
	const script = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
	vm.createContext(sandbox);
	vm.runInContext(script, sandbox);
	await (sandbox.refresh as () => Promise<void>)();
	return Object.fromEntries(
		["tab-agents", "tab-entries", "tab-proposals", "tab-projects"].map((id) => [id, String(element(id).innerHTML)]),
	);
}

describe("/grimoire-ui with projects: previews for a chosen project", () => {
	test("37. snapshot(dir, env, app) builds the Pi section and both hook previews from global + app only, with per-part sizes", () => {
		const dir = store();
		const w = snapshot(dir, { HOME: dir }, inApp).whatAgentsGet;
		for (const text of [w.everyPrompt.text, w.claudeCode.hookText, w.claudeCode.importText, w.codex.hookText]) {
			expect(text).not.toContain("TOOLS-ROOT-TEXT");
			expect(text).not.toContain("Tools fact");
		}
		for (const text of [w.everyPrompt.text, w.codex.hookText]) {
			for (const part of ["GLOBAL-ROOT-TEXT", "APP-ROOT-TEXT", "Global fact", "App fact"]) expect(text).toContain(part);
		}
		expect(w.claudeCode.hookText).toContain("APP-ROOT-TEXT");
		expect(w.claudeCode.hookText).toContain("App fact");
		expect(w.claudeCode.hookText).not.toContain("GLOBAL-ROOT-TEXT");
		expect(w.claudeCode.importText).toContain("GLOBAL-ROOT-TEXT");
		expect(w.claudeCode.importText).toContain("Global fact");
		expect(w.claudeCode.importText).not.toContain("App fact");

		const root = loadRoot(dir, "app");
		expect(w.pi.globalRoot).toMatchObject({ chars: root.global.chars, limit: LIMITS.globalRootChars, cut: 0 });
		expect(w.pi.projectRoot).toMatchObject({ chars: root.project.chars, limit: LIMITS.projectRootChars, cut: 0 });
		expect(w.pi.catalogue).toMatchObject({ total: 2, shown: 2, titlesOnly: false, limit: LIMITS.catalogueChars });
		expect(w.claudeCode).toMatchObject({
			hookChars: w.claudeCode.hookText.length,
			hookLimit: CLAUDE_CONTEXT_MAX,
			importChars: w.claudeCode.importText.length,
			importLimit: LIMITS.globalRootChars + LIMITS.catalogueChars,
		});
		expect(w.claudeCode.projectRoot).toMatchObject({ chars: root.project.chars, limit: LIMITS.projectRootChars });
		expect(w.claudeCode.catalogue).toMatchObject({ total: 1, shown: 1, titlesOnly: false });
		expect(w.claudeCode.importCatalogue).toMatchObject({ total: 1, shown: 1 });
		expect(w.codex).toMatchObject({ hookChars: w.codex.hookText.length, hookLimit: CODEX_CONTEXT_CHARS });
		expect(w.codex.catalogue).toMatchObject({ total: 2, shown: 2, titlesOnly: false });
		expect(w.codex.projectRoot).toMatchObject({ chars: root.project.chars, cut: 0 });

		// "No project: global only" says why everywhere, and loads nothing of app's.
		const g = snapshot(dir, { HOME: dir }, { state: "global", why: "chosen in the picker" });
		expect(g.preview.text).toContain("chosen in the picker");
		for (const text of [
			g.whatAgentsGet.everyPrompt.text,
			g.whatAgentsGet.claudeCode.hookText,
			g.whatAgentsGet.codex.hookText,
		]) {
			expect(text).toContain("chosen in the picker");
			expect(text).not.toContain("App fact");
			expect(text).not.toContain("APP-ROOT-TEXT");
		}
		expect(g.whatAgentsGet.pi.projectRoot).toBeUndefined();

		// A root part over its cap reports how many characters were cut.
		rootFile(dir, "app-long.md", "a line of app root text\n".repeat(400), ["app"]);
		const long = snapshot(dir, { HOME: dir }, inApp).whatAgentsGet;
		for (const part of [long.pi.projectRoot, long.claudeCode.projectRoot, long.codex.projectRoot]) {
			expect(part?.truncated).toBe(true);
			expect(part?.cut).toBeGreaterThan(0);
			expect((part?.chars ?? 0) - (part?.cut ?? 0)).toBeLessThanOrEqual(LIMITS.projectRootChars);
		}
	});

	test("37b. with 60 app entries the Claude preview is titles only, counts the overflow, and the page says where they went", async () => {
		const dir = store();
		for (let i = 0; i < 60; i++) {
			put(dir, `kinds/lessons/app-${String(i).padStart(2, "0")}.md`, {
				kind: "lesson",
				title: `App lesson number ${i} about the example deploy pipeline, its staging checks, its rollback plan and who signs off on it`,
				summary: "A long summary sentence that takes room in the hook text and pushes the catalogue over budget.",
				body: "b",
				date: "2026-10-10",
				scope: ["app"],
			});
		}
		const c = snapshot(dir, { HOME: dir }, inApp).whatAgentsGet.claudeCode;
		const file = catalogueOverflowFile(dir, "app");
		expect(c.catalogue?.titlesOnly).toBe(true);
		expect(c.catalogue?.total).toBe(61);
		const listed = listEntries(dir).filter((e) => e.scope?.includes("app") && c.hookText.includes(`(${e.file})`));
		expect(c.catalogue?.shown).toBe(listed.length);
		expect(c.catalogue?.overflow).toEqual({ count: 61 - listed.length, file });
		expect(c.catalogue?.note).toContain(`${61 - listed.length} entries moved to ${file}`);

		const { srv } = await serve(dir, { project: inApp });
		const tabs = await renderTabs(srv);
		expect(tabs["tab-agents"]).toContain(`${61 - listed.length} entries moved to ${file}`);
	});
});

describe("/grimoire-ui with projects: scope on entries, proposals and in bulk", () => {
	test("38. PUT /api/entries with scope [app] writes it; unknown ids and [] are 400; null makes it global", async () => {
		const dir = store();
		const { srv, api } = await serve(dir);
		const file = "kinds/facts/global.md";
		const read = () => readEntry(readFileSync(join(dir, file), "utf8"), file).entry;

		expect((await api("/api/entries", "PUT", { file, scope: ["app"] })).status).toBe(200);
		expect(read()?.scope).toEqual(["app"]);
		// Editing another field keeps the scope.
		expect((await api("/api/entries", "PUT", { file, title: "Global fact renamed" })).status).toBe(200);
		expect(read()).toMatchObject({ title: "Global fact renamed", scope: ["app"] });

		const before = readFileSync(join(dir, file), "utf8");
		for (const scope of [["nope"], [], ["global"], "app", [1]]) {
			const res = await api<{ error: string }>("/api/entries", "PUT", { file, scope });
			expect(res.status).toBe(400);
			expect(res.data.error).toBeTruthy();
		}
		expect(readFileSync(join(dir, file), "utf8")).toBe(before);

		expect((await api("/api/entries", "PUT", { file, scope: null })).status).toBe(200);
		expect(read()?.scope).toBeUndefined();

		const added = await api<{ entry: Entry }>("/api/entries", "POST", {
			kind: "lesson",
			title: "New app lesson",
			body: "b",
			date: "2026-10-20",
			scope: ["app", "tools"],
		});
		expect(added.status).toBe(200);
		expect(
			readEntry(readFileSync(join(dir, added.data.entry.file), "utf8"), added.data.entry.file).entry?.scope,
		).toEqual(["app", "tools"]);
		const lessons = readdirSync(join(dir, "kinds", "lessons")).length;
		const refused = await api("/api/entries", "POST", { kind: "lesson", title: "No", body: "b", scope: ["nope"] });
		expect(refused.status).toBe(400);
		expect(readdirSync(join(dir, "kinds", "lessons"))).toHaveLength(lessons);

		// The entries table has a Scope column naming each entry's projects, a scope filter and the bulk action.
		const tabs = await renderTabs(srv);
		expect(tabs["tab-entries"]).toContain("<th>Scope</th>");
		expect(tabs["tab-entries"]).toContain("App, Tools");
		expect(tabs["tab-entries"]).toContain('id="scope-filter"');
		expect(tabs["tab-entries"]).toContain("Select all filtered");
		expect(tabs["tab-entries"]).toContain("Set scope");
	});

	test("39. POST /api/scope changes exactly the listed files and keeps unknown keys", async () => {
		const dir = store();
		const { api } = await serve(dir);
		const odd = "kinds/lessons/odd.md";
		mkdirSync(join(dir, "kinds", "lessons"), { recursive: true });
		writeFileSync(
			join(dir, odd),
			'---\nkind: "lesson"\ntitle: "Odd"\ndate: "2026-10-01"\nowner: someone\nstatus: "x"\n---\n\nBody.\n',
		);
		const untouched = "kinds/facts/tools.md";
		const untouchedBefore = readFileSync(join(dir, untouched), "utf8");

		const set = await api<{ files: string[] }>("/api/scope", "POST", {
			files: [odd, "kinds/facts/global.md"],
			scope: ["tools"],
		});
		expect(set.status).toBe(200);
		expect(set.data.files).toEqual([odd, "kinds/facts/global.md"]);
		const oddText = readFileSync(join(dir, odd), "utf8");
		expect(oddText).toContain("owner: someone");
		expect(oddText).toContain('status: "x"');
		expect(readEntry(oddText, odd).entry?.scope).toEqual(["tools"]);
		expect(readEntry(readFileSync(join(dir, "kinds/facts/global.md"), "utf8"), "x").entry?.scope).toEqual(["tools"]);
		expect(readFileSync(join(dir, untouched), "utf8")).toBe(untouchedBefore);

		expect((await api("/api/scope", "POST", { files: [odd], scope: null })).status).toBe(200);
		expect(readEntry(readFileSync(join(dir, odd), "utf8"), odd).entry?.scope).toBeUndefined();

		const snapshotBefore = readFileSync(join(dir, "kinds/facts/global.md"), "utf8");
		for (const body of [
			{ files: ["kinds/facts/global.md"], scope: [] },
			{ files: ["kinds/facts/global.md"], scope: ["nope"] },
			{ files: ["kinds/facts/global.md"] },
			{ files: ["kinds/facts/global.md", "../outside.md"], scope: ["app"] },
			{ files: [], scope: ["app"] },
		]) {
			expect((await api("/api/scope", "POST", body)).status).toBe(400);
		}
		expect(readFileSync(join(dir, "kinds/facts/global.md"), "utf8")).toBe(snapshotBefore);
	});

	test("40. POST /api/accept with a scope accepts the proposal and sets it; the proposal card shows its scope and note", async () => {
		const dir = store();
		const { srv, api } = await serve(dir);
		const noted = writeProposal(dir, {
			kind: "lesson",
			title: "Proposed as global",
			body: "b",
			date: "2026-10-20",
			scopeNote: "proposed as global: remote not attached: github.com/example/other",
		});
		const tabs = await renderTabs(srv);
		expect(tabs["tab-proposals"]).toContain("Scope: Global");
		expect(tabs["tab-proposals"]).toContain("proposed as global: remote not attached: github.com/example/other");

		const accepted = await api<{ entry: Entry }>("/api/accept", "POST", {
			file: noted,
			kind: "decision",
			scope: ["app"],
		});
		expect(accepted.status).toBe(200);
		expect(accepted.data.entry.file).toMatch(/^kinds\/decisions\//);
		const written = readEntry(
			readFileSync(join(dir, accepted.data.entry.file), "utf8"),
			accepted.data.entry.file,
		).entry;
		expect(written?.scope).toEqual(["app"]);
		expect(written?.scopeNote).toBeUndefined();

		const scoped = writeProposal(dir, { kind: "fact", title: "Scoped", body: "b", date: "2026-10-20", scope: ["app"] });
		const global = await api<{ entry: Entry }>("/api/accept", "POST", { file: scoped, scope: null });
		expect(global.status).toBe(200);
		expect(global.data.entry.scope).toBeUndefined();

		const kept = writeProposal(dir, { kind: "fact", title: "Kept", body: "b", date: "2026-10-20" });
		expect((await api("/api/accept", "POST", { file: kept, scope: ["nope"] })).status).toBe(400);
		expect((await api("/api/accept", "POST", { file: kept, scope: [] })).status).toBe(400);
		expect(readdirSync(join(dir, "proposals"))).toContain(kept.slice("proposals/".length));
	});
});

describe("/grimoire-ui with projects: the registry and the link report", () => {
	test("41. PUT /api/projects refuses a remote on two projects; a good save round-trips, with paths stored as real paths", async () => {
		const dir = store();
		const checkout = repo({ origin: "git@github.com:example/demo-app.git" });
		const { srv, api } = await serve(dir, { cwd: checkout });

		const got = await api<{ projects: Project[]; session: { remotes: { name: string; key: string }[] } }>(
			"/api/projects",
		);
		expect(got.status).toBe(200);
		expect(got.data.projects).toEqual([APP, TOOLS]);
		expect(got.data.session.remotes).toEqual([{ name: "origin", key: "github.com/example/demo-app" }]);

		const key = await api<{ key: string }>("/api/projects/remote-key", "POST", {
			url: "https://github.com/Example/Demo-App.git",
		});
		expect(key).toEqual({ status: 200, data: { key: "github.com/example/demo-app" } });
		expect((await api("/api/projects/remote-key", "POST", { url: "not a remote" })).status).toBe(400);

		const before = readFileSync(join(dir, "projects.json"), "utf8");
		const clash = await api<{ error: string }>("/api/projects", "PUT", {
			projects: [APP, { ...TOOLS, remotes: [...TOOLS.remotes, "github.com/example/app"] }],
		});
		expect(clash.status).toBe(400);
		expect(clash.data.error).toContain('is on both project "app" and project "tools"');
		expect(readFileSync(join(dir, "projects.json"), "utf8")).toBe(before);

		const real = tmp("sitra-ui-scope-folder-");
		const link = join(tmp("sitra-ui-scope-link-"), "demo");
		symlinkSync(real, link);
		const demo: Project = {
			id: "demo-app",
			label: "Demo app",
			remotes: ["github.com/example/demo-app"],
			paths: [link],
		};
		const saved = await api<{ projects: Project[] }>("/api/projects", "PUT", { projects: [APP, TOOLS, demo] });
		expect(saved.status).toBe(200);
		const stored = { ...demo, paths: [real] };
		expect(saved.data.projects).toEqual([APP, TOOLS, stored]);
		expect(readProjects(dir).projects).toEqual([APP, TOOLS, stored]);
		expect((await api<{ projects: Project[] }>("/api/projects")).data.projects).toEqual([APP, TOOLS, stored]);
		expect(
			(await api("/api/projects", "PUT", { projects: [{ ...demo, paths: [join(real, "missing")] }] })).status,
		).toBe(400);

		// The Projects tab lists each project and offers this checkout's remotes.
		const tabs = await renderTabs(srv);
		for (const text of ["demo-app", "Demo app", "github.com/example/demo-app", real, "Attach this checkout"]) {
			expect(tabs["tab-projects"]).toContain(text);
		}
	});

	test("41 (no registry). Without projects.json the snapshot and page behave as before, and the Projects tab offers to create one", async () => {
		const dir = store();
		rmSync(join(dir, "projects.json"));
		const s = snapshot(dir, { HOME: dir, SITRA_USER_NAME: "Sam" });
		expect(s.projects).toMatchObject({ inUse: false, list: [] });
		expect(s.preview.state).toBe("off");
		expect(s.whatAgentsGet.everyPrompt.text).toBe(
			grimoireSection(
				dir,
				loadRoot(dir),
				listEntries(dir).filter((e) => !e.scope),
				{ who: "Sam" },
			),
		);
		const { srv } = await serve(dir);
		const tabs = await renderTabs(srv);
		expect(tabs["tab-projects"]).toContain("No projects yet");
		expect(tabs["tab-projects"]).toContain("Create projects.json");
		expect(tabs["tab-entries"]).not.toContain("<th>Scope</th>");
		expect(tabs["tab-agents"]).not.toContain('id="preview-project"');
	});

	test("42. the snapshot's link report lists a cross-scope link and a missing one, and the Links panel shows them", async () => {
		const dir = store();
		put(dir, "kinds/facts/linker.md", {
			kind: "fact",
			title: "Linker",
			body: "See the tools fact.",
			date: "2026-10-05",
			links: ["kinds/facts/tools.md", "kinds/facts/gone.md"],
		});
		const s = snapshot(dir, { HOME: dir }, inApp);
		expect(s.links).toEqual(
			expect.arrayContaining([
				{ from: "kinds/facts/linker.md", target: "kinds/facts/tools.md", problem: "out-of-scope" },
				{ from: "kinds/facts/linker.md", target: "kinds/facts/gone.md", problem: "missing" },
			]),
		);
		const { srv } = await serve(dir, { project: inApp });
		const tabs = await renderTabs(srv);
		expect(tabs["tab-agents"]).toContain("Links");
		expect(tabs["tab-agents"]).toContain("kinds/facts/gone.md");
		expect(tabs["tab-agents"]).toContain("out of scope");
		expect(tabs["tab-agents"]).toContain("missing");
	});

	test("37 (picker). GET /api/snapshot?project= previews any project or global only, and defaults to the session's", async () => {
		const dir = store();
		const { srv, api } = await serve(dir, { project: inApp });
		type Snap = ReturnType<typeof snapshot>;
		const fallback = await api<Snap>("/api/snapshot");
		expect(fallback.data.preview).toMatchObject({ state: "matched", project: { id: "app" } });
		expect(fallback.data.session.project).toMatchObject({ state: "matched", project: { id: "app" } });
		const tools = await api<Snap>("/api/snapshot?project=tools");
		expect(tools.data.preview).toMatchObject({ state: "matched", project: { id: "tools" } });
		expect(tools.data.whatAgentsGet.everyPrompt.text).toContain("Tools fact");
		expect(tools.data.whatAgentsGet.everyPrompt.text).not.toContain("App fact");
		const global = await api<Snap>("/api/snapshot?project=global");
		expect(global.data.preview.state).toBe("global");
		expect(global.data.whatAgentsGet.everyPrompt.text).not.toContain("App fact");
		expect((await api("/api/snapshot?project=nope")).status).toBe(400);
		const tabs = await renderTabs(srv);
		expect(tabs["tab-agents"]).toContain('id="preview-project"');
		expect(tabs["tab-agents"]).toContain("No project: global only");
	});
});
