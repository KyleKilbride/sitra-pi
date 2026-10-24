import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	checkoutRemotes,
	normalizeRemote,
	type Project,
	type ProjectRegistry,
	projectFor,
	readProjects,
	validateProjects,
	writeProjects,
} from "../extensions/project.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

function tempDir(prefix: string): string {
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** A repo with one commit (so worktrees can be added) and the given remotes, at `dir` or a new temp folder. */
function makeRepo(remotes: Record<string, string> = {}, dir = tempDir("sitra-project-")): string {
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q");
	git(
		dir,
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
	for (const [name, url] of Object.entries(remotes)) git(dir, "remote", "add", name, url);
	return dir;
}

const project = (id: string, remotes: string[] = [], paths: string[] = []): Project => ({
	id,
	label: id[0]?.toUpperCase() + id.slice(1),
	remotes,
	paths,
});

const APP = "github.com/example/app";
const TOOLS = "github.com/example/tools";
const registry: ProjectRegistry = { projects: [project("app", [APP]), project("tools", [TOOLS])] };

describe("normalizeRemote", () => {
	test("https, scp and ssh forms of one repo give the same key", () => {
		for (const url of [
			"https://github.com/Example/App.git",
			"git@github.com:example/app.git",
			"ssh://git@github.com:22/example/app",
			"https://user:token@github.com/example/app/",
		])
			expect(normalizeRemote(url), url).toBe(APP);
	});

	test("a local-path remote is keyed by its real path", () => {
		const dir = tempDir("sitra-local-remote-");
		mkdirSync(join(dir, "bare.git"));
		expect(normalizeRemote(join(dir, "bare.git"))).toBe(`file:${join(dir, "bare.git")}`);
		expect(normalizeRemote(`file://${join(dir, "bare.git")}`)).toBe(`file:${join(dir, "bare.git")}`);
		expect(normalizeRemote("../bare.git", join(dir, "clone"))).toBe(`file:${join(dir, "bare.git")}`);
	});

	test("an unparseable remote URL throws an error naming it", () => {
		for (const url of ["", "not a remote", "ftp://example.com/example/app", "https://github.com/"])
			expect(() => normalizeRemote(url), url).toThrow(url === "" ? /remote URL ""/ : url);
	});
});

describe("checkoutRemotes", () => {
	test("lists every remote by name with its normalized key", () => {
		const repo = makeRepo({ origin: "git@github.com:Example/App.git", upstream: "https://github.com/example/tools" });
		expect(checkoutRemotes(repo)).toEqual([
			{ name: "origin", key: APP },
			{ name: "upstream", key: TOOLS },
		]);
	});
});

describe("projectFor", () => {
	test("repos whose names share a prefix are different keys and different projects", () => {
		const reg: ProjectRegistry = {
			projects: [project("sitra", ["github.com/owner/sitra"]), project("sitra-pi", ["github.com/owner/sitra-pi"])],
		};
		expect(normalizeRemote("https://github.com/owner/sitra.git")).not.toBe(
			normalizeRemote("https://github.com/owner/sitra-pi.git"),
		);
		const a = projectFor(makeRepo({ origin: "https://github.com/owner/sitra.git" }), reg);
		const b = projectFor(makeRepo({ origin: "git@github.com:owner/sitra-pi.git" }), reg);
		expect(a.state === "matched" && a.project.id).toBe("sitra");
		expect(b.state === "matched" && b.project.id).toBe("sitra-pi");
	});

	test("a linked worktree, a subfolder and a second clone with the same remote all match the same project", () => {
		const repo = makeRepo({ origin: "https://github.com/example/app.git" });
		const wt = join(repo, ".worktrees", "feature");
		git(repo, "worktree", "add", "-q", "-b", "feature", wt);
		mkdirSync(join(repo, "sub"));
		const clone = makeRepo({ origin: "git@github.com:example/app.git" });
		for (const cwd of [repo, wt, join(repo, "sub"), clone]) {
			const match = projectFor(cwd, registry);
			expect(match.state, cwd).toBe("matched");
			if (match.state === "matched") expect(match.project.id).toBe("app");
		}
	});

	test("no git, no remote and an unattached remote each give no project, never a path-based one", () => {
		const plain = tempDir("sitra-nogit-");
		expect(projectFor(plain, registry)).toEqual({ state: "none", checkout: plain, remotes: [], reason: "no-git" });

		const bare = makeRepo();
		expect(projectFor(bare, registry)).toEqual({ state: "none", checkout: bare, remotes: [], reason: "no-remote" });

		const other = makeRepo({ origin: "https://github.com/example/other" });
		expect(projectFor(other, registry)).toEqual({
			state: "none",
			checkout: other,
			remotes: [{ name: "origin", key: "github.com/example/other" }],
			reason: "unattached",
		});
	});

	test("a folder listed in a project's paths matches it; the same folder unlisted doesn't", () => {
		const plain = tempDir("sitra-notes-");
		const repo = makeRepo();
		const listed: ProjectRegistry = { projects: [project("app", [APP], [plain, repo])] };
		for (const dir of [plain, repo]) {
			const match = projectFor(dir, listed);
			expect(match.state, dir).toBe("matched");
			if (match.state === "matched") expect([match.project.id, match.via]).toEqual(["app", "path"]);
		}
		expect(projectFor(plain, registry).state).toBe("none");
		expect(projectFor(tempDir("sitra-notes-"), listed).state).toBe("none");
	});

	test("origin wins over another remote attached to a different project, with a warning naming it", () => {
		const repo = makeRepo({ origin: "https://github.com/example/app", upstream: "https://github.com/example/tools" });
		const match = projectFor(repo, registry);
		expect(match.state).toBe("matched");
		if (match.state !== "matched") return;
		expect([match.project.id, match.via]).toEqual(["app", "origin"]);
		expect(match.warnings).toHaveLength(1);
		expect(match.warnings[0]).toContain("upstream");
		expect(match.warnings[0]).toContain("tools");
	});

	test("ambiguous only when origin matches nothing and other remotes match different projects", () => {
		const origins: Record<string, string>[] = [{ origin: "https://github.com/example/other" }, {}];
		for (const origin of origins) {
			const repo = makeRepo({
				...origin,
				upstream: "https://github.com/example/app",
				mirror: "https://github.com/example/tools",
			});
			const match = projectFor(repo, registry);
			expect(match.state).toBe("ambiguous");
			if (match.state !== "ambiguous") return;
			expect(match.candidates.map((c) => [c.remote.name, c.project.id])).toEqual([
				["upstream", "app"],
				["mirror", "tools"],
			]);
		}

		const one = makeRepo({ origin: "https://github.com/example/other", upstream: "https://github.com/example/app" });
		const match = projectFor(one, registry);
		expect(match.state).toBe("matched");
		if (match.state !== "matched") return;
		expect([match.project.id, match.via, match.warnings]).toEqual(["app", "upstream", []]);
	});

	test("a linked worktree whose folder name shares nothing with the main checkout still finds it", () => {
		const root = tempDir("sitra-loop-");
		const main = makeRepo({ origin: "git@github.com:example/app.git" }, join(root, "app-main"));
		const wt = join(root, "elsewhere", "feature-x-7f3");
		git(main, "worktree", "add", "-q", "-b", "feature-x", wt);
		const match = projectFor(wt, registry);
		expect(match.state).toBe("matched");
		if (match.state !== "matched") return;
		expect([match.checkout, match.project.id]).toEqual([main, "app"]);
	});
});

describe("the project registry", () => {
	test("validateProjects refuses a remote on two projects, a bad id and an unnormalized remote", () => {
		expect(validateProjects(registry)).toEqual([]);

		const clash = validateProjects({ projects: [project("app", [APP]), project("tools", [APP])] });
		expect(clash).toHaveLength(1);
		expect(clash[0]).toContain(APP);
		expect(clash[0]).toContain("app");
		expect(clash[0]).toContain("tools");

		const badId = validateProjects({ projects: [project("My App", [APP])] });
		expect(badId).toHaveLength(1);
		expect(badId[0]).toContain("My App");

		const raw = "https://github.com/Example/App.git";
		const unnormalized = validateProjects({ projects: [project("app", [raw])] });
		expect(unnormalized).toHaveLength(1);
		expect(unnormalized[0]).toContain(raw);
		expect(unnormalized[0]).toContain(APP);

		const path = "/work/demo-app";
		const pathClash = validateProjects({ projects: [project("app", [], [path]), project("tools", [], [path])] });
		expect(pathClash).toHaveLength(1);
		expect(pathClash[0]).toContain(path);
	});

	test("writeProjects and readProjects round-trip, a missing file is an empty registry, and bad files throw", () => {
		const dir = tempDir("sitra-grimoire-");
		expect(readProjects(dir)).toEqual({ projects: [] });
		writeProjects(dir, registry);
		expect(readProjects(dir)).toEqual(registry);
		expect(() => writeProjects(dir, { projects: [project("app", [APP]), project("tools", [APP])] })).toThrow(APP);
		expect(readProjects(dir)).toEqual(registry);

		writeFileSync(join(dir, "projects.json"), "{ not json");
		expect(() => readProjects(dir)).toThrow("projects.json");
		writeFileSync(
			join(dir, "projects.json"),
			JSON.stringify({ projects: [project("app", [APP]), project("app", [TOOLS])] }),
		);
		expect(() => readProjects(dir)).toThrow(/app/);
		expect(readFileSync(join(dir, "projects.json"), "utf8")).toContain(TOOLS);
	});
});
