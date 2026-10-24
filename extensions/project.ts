/**
 * Projects: which Grimoire project a folder belongs to. The registry lives in `<grimoire>/projects.json`; a checkout
 * belongs to the project one of its git remotes is attached to, or, only when listed explicitly, to a project whose
 * `paths` names it. No Pi imports; the only process call is `git`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { type Entry, entriesFor, isProjectId, LIMITS, type SectionScope, writeClaudeRoot } from "./grimoire.ts";
import { gitCheckout } from "./sessions.ts";

export interface Project {
	id: string;
	label: string;
	remotes: string[];
	paths: string[];
}

export interface ProjectRegistry {
	projects: Project[];
}

export interface Remote {
	name: string;
	key: string;
}

export type ProjectMatch =
	| { state: "matched"; project: Project; via: string; checkout: string; remotes: Remote[]; warnings: string[] }
	| { state: "none"; checkout: string; remotes: Remote[]; reason: "no-git" | "no-remote" | "unattached" }
	| { state: "ambiguous"; checkout: string; remotes: Remote[]; candidates: { remote: Remote; project: Project }[] };

export const PROJECTS_FILE = "projects.json";

const HOSTED_SCHEMES = new Set(["https", "http", "ssh", "git"]);

/**
 * The key a remote URL is matched by: `host/owner/repo` (lowercase, without userinfo, port or a trailing `.git`) for
 * hosted remotes in URL or scp form, `file:<realpath>` for a local path. A relative path is resolved against `base`.
 */
export function normalizeRemote(url: string, base?: string): string {
	const fail = (why: string): never => {
		throw new Error(`Can't read remote URL ${JSON.stringify(url)}: ${why}`);
	};
	const hosted = (host: string, path: string): string => {
		let hostname = "";
		try {
			hostname = new URL(`https://${host}/`).hostname;
		} catch {
			fail(`${JSON.stringify(host)} isn't a host name`);
		}
		const segments = path.split("/").filter((s) => s !== "");
		const last = segments.pop() ?? "";
		const repo = last.endsWith(".git") ? last.slice(0, -".git".length) : last;
		if (hostname === "" || repo === "") fail("it names no repository");
		return [hostname, ...segments, repo].join("/").toLowerCase();
	};
	const local = (path: string): string => {
		const absolute = isAbsolute(path) ? path : base === undefined ? fail("it is a relative path") : resolve(base, path);
		try {
			return `file:${realpathSync(absolute)}`;
		} catch {
			return fail(`there is no folder at ${absolute}`);
		}
	};

	if (url.trim() === "") return fail("it is empty");
	const schemeEnd = url.indexOf("://");
	if (schemeEnd > 0) {
		const scheme = url.slice(0, schemeEnd).toLowerCase();
		let parsed: URL | undefined;
		try {
			parsed = new URL(url);
		} catch {
			return fail("it isn't a valid URL");
		}
		if (scheme === "file") return local(decodeURIComponent(parsed.pathname));
		if (!HOSTED_SCHEMES.has(scheme)) return fail(`the scheme ${scheme} isn't https, http, ssh, git or file`);
		return hosted(parsed.host.split(":")[0] ?? "", decodeURIComponent(parsed.pathname));
	}
	if (url.startsWith("/") || url.startsWith("./") || url.startsWith("../") || url === "." || url === "..")
		return local(url);
	// scp form, `[user@]host:path`: git reads it so only when the first `:` comes before any `/`.
	const colon = url.indexOf(":");
	const slash = url.indexOf("/");
	if (colon > 0 && (slash === -1 || colon < slash)) {
		const userHost = url.slice(0, colon);
		return hosted(userHost.slice(userHost.lastIndexOf("@") + 1), url.slice(colon + 1));
	}
	return fail("it isn't a URL, an scp-style host:path or a path");
}

/** Every `remote.<name>.url` of a checkout, normalized, in git's config order. */
export function checkoutRemotes(checkout: string): Remote[] {
	const result = spawnSync("git", ["config", "-z", "--get-regexp", "^remote\\..*\\.url$"], {
		cwd: checkout,
		encoding: "utf8",
	});
	// Exit 1 is git's "no such key": a repo without remotes.
	if (result.status === 1) return [];
	if (result.status !== 0)
		throw new Error(`git config failed in ${checkout}: ${result.error?.message ?? result.stderr.trim()}`);
	return result.stdout
		.split("\0")
		.filter((record) => record !== "")
		.map((record) => {
			const newline = record.indexOf("\n");
			const key = record.slice(0, newline);
			const name = key.slice("remote.".length, -".url".length);
			return { name, key: normalizeRemote(record.slice(newline + 1), checkout) };
		});
}

function remoteKeyProblem(remote: string): string | undefined {
	if (remote.startsWith("file:")) {
		const path = remote.slice("file:".length);
		return isAbsolute(path) && resolve(path) === path ? undefined : "isn't file:<absolute path>";
	}
	const attempt = (url: string): string | undefined => {
		try {
			return normalizeRemote(url);
		} catch {
			return undefined;
		}
	};
	const key = attempt(remote) ?? attempt(`https://${remote}`);
	if (key === remote) return undefined;
	return key === undefined ? "isn't a remote" : `isn't normalized; write it as ${JSON.stringify(key)}`;
}

/** Everything wrong with a registry, one message per problem, each naming what clashes. Empty means valid. */
export function validateProjects(registry: unknown): string[] {
	const projects = (registry as { projects?: unknown } | null)?.projects;
	if (typeof registry !== "object" || !Array.isArray(projects)) return ['must be { "projects": [ ... ] }'];
	const problems: string[] = [];
	const ids = new Map<string, number>();
	const owners = { remote: new Map<string, string>(), path: new Map<string, string>() };
	const claim = (kind: "remote" | "path", value: string, id: string) => {
		const owner = owners[kind].get(value);
		if (owner === undefined) owners[kind].set(value, id);
		else if (owner === id) problems.push(`${kind} ${JSON.stringify(value)} is listed twice on project "${id}"`);
		else problems.push(`${kind} ${JSON.stringify(value)} is on both project "${owner}" and project "${id}"`);
	};
	for (const [index, entry] of (projects as unknown[]).entries()) {
		const where = `project ${index + 1}`;
		if (typeof entry !== "object" || entry === null) {
			problems.push(`${where} isn't an object`);
			continue;
		}
		const { id, label, remotes, paths } = entry as Record<string, unknown>;
		if (!isProjectId(id)) {
			problems.push(
				`${where}: id ${JSON.stringify(id)} isn't a lowercase slug (a-z, 0-9 and single dashes) other than "global"`,
			);
			continue;
		}
		ids.set(id, (ids.get(id) ?? 0) + 1);
		if (ids.get(id) === 2) problems.push(`id "${id}" is used by more than one project`);
		if (typeof label !== "string" || label.trim() === "") problems.push(`project "${id}" has no label`);
		for (const [kind, list] of [
			["remote", remotes],
			["path", paths],
		] as const) {
			if (!Array.isArray(list) || list.some((item) => typeof item !== "string")) {
				problems.push(`project "${id}": ${kind}s must be a list of strings`);
				continue;
			}
			for (const value of list as string[]) {
				const problem =
					kind === "remote"
						? remoteKeyProblem(value)
						: isAbsolute(value) && resolve(value) === value
							? undefined
							: "isn't an absolute path";
				if (problem) problems.push(`project "${id}": ${kind} ${JSON.stringify(value)} ${problem}`);
				else claim(kind, value, id);
			}
		}
	}
	return problems;
}

/** `<dir>/projects.json`; no file is an empty registry. An unreadable or invalid file throws, naming the problems. */
export function readProjects(dir: string): ProjectRegistry {
	const file = join(dir, PROJECTS_FILE);
	if (!existsSync(file)) return { projects: [] };
	let registry: unknown;
	try {
		registry = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`Can't read ${file}: ${(error as Error).message}`);
	}
	const problems = validateProjects(registry);
	if (problems.length > 0) throw new Error(`${file}: ${problems.join("; ")}`);
	return registry as ProjectRegistry;
}

/** Validates, then replaces `<dir>/projects.json` in one rename. An invalid registry throws and writes nothing. */
export function writeProjects(dir: string, registry: ProjectRegistry): void {
	const file = join(dir, PROJECTS_FILE);
	const problems = validateProjects(registry);
	if (problems.length > 0) throw new Error(`Not saving ${file}: ${problems.join("; ")}`);
	mkdirSync(dir, { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(registry, null, "\t")}\n`);
	renameSync(temp, file);
}

/**
 * The project a session works in, decided once when it starts. `off`: no projects are registered, so nothing is
 * scoped and everything works as before projects. `global`: projects exist but none applies here, or the registry or
 * a remote can't be read (`error`), with why, so the person can see it.
 */
export type SessionProject =
	| { state: "off" }
	| { state: "matched"; project: Project; via: string; warnings: string[] }
	| { state: "global"; why: string; error?: boolean };

/** The registry, or why it can't be read; never throws. */
function readRegistry(dir: string): { registry: ProjectRegistry; error?: string } {
	try {
		return { registry: readProjects(dir) };
	} catch (error) {
		return { registry: { projects: [] }, error: message(error) };
	}
}

/** Whether projects are in use: a registry with projects, or one that can't be read (which loads global only). */
export function projectsOn(dir: string): boolean {
	const { registry, error } = readRegistry(dir);
	return error !== undefined || registry.projects.length > 0;
}

/** Reads the registry and finds the folder's project, turning every failure into a `global` answer that says why. */
export function sessionProject(
	cwd: string,
	dir: string,
	resolve: typeof projectFor = projectFor,
): { project: SessionProject; registry: ProjectRegistry } {
	const { registry, error } = readRegistry(dir);
	if (error !== undefined) return { project: { state: "global", why: error, error: true }, registry };
	if (registry.projects.length === 0) return { project: { state: "off" }, registry };
	let match: ProjectMatch;
	try {
		match = resolve(cwd, registry);
	} catch (error) {
		return { project: { state: "global", why: message(error), error: true }, registry };
	}
	if (match.state === "matched")
		return {
			project: { state: "matched", project: match.project, via: match.via, warnings: match.warnings },
			registry,
		};
	if (match.state === "ambiguous") {
		const which = match.candidates.map((c) => `${c.remote.name} → ${c.project.label}`).join(", ");
		return { project: { state: "global", why: `remotes point at different projects: ${which}` }, registry };
	}
	const keys = match.remotes.map((r) => r.key);
	const why =
		match.reason === "no-git"
			? "not in a git repository"
			: match.reason === "no-remote"
				? "the git repository has no remote"
				: `${keys.length === 1 ? "remote" : "remotes"} not attached: ${keys.join(", ")}`;
	return { project: { state: "global", why }, registry };
}

/**
 * The scope a new proposal gets from the session's project: the project's id, or, when projects exist but none
 * applies here, no scope and a note saying why, so the review shows it. With no projects registered, neither.
 */
export function proposalScope(project: SessionProject): { scope?: string[]; scopeNote?: string } {
	if (project.state === "matched") return { scope: [project.project.id] };
	if (project.state === "global") return { scopeNote: `proposed as global: ${project.why}` };
	return {};
}

/** How a prompt names the session's project (`grimoireSection`): the project, or why there is none; nothing when off. */
export function sectionScopeOf(project: SessionProject): SectionScope | undefined {
	if (project.state === "matched") return { project: { id: project.project.id, label: project.project.label } };
	return project.state === "global" ? { why: project.why } : undefined;
}

/** The session's project id, if it has one. */
export function projectIdOf(project: SessionProject): string | undefined {
	return project.state === "matched" ? project.project.id : undefined;
}

/**
 * The entries a session in `projectId` sees. With projects not in use, all of them, exactly as before projects;
 * otherwise global plus the project's (`entriesFor`).
 */
export function visibleEntries(entries: readonly Entry[], projectId: string | undefined, inUse: boolean): Entry[] {
	return inUse ? entriesFor(entries, projectId) : [...entries];
}

/**
 * Rewrites Claude Code's imported root file for the store: with projects in use it holds the global root and the
 * global catalogue (the session hook adds the project's part); without, the root alone, as before projects.
 */
export function refreshClaudeRoot(dir: string): string {
	return writeClaudeRoot(dir, LIMITS.rootChars, projectsOn(dir));
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The project a folder is in. In order: the project `origin` is attached to (warning about other remotes attached
 * elsewhere); else the one project the other remotes are attached to; else `ambiguous` if they point at several; else
 * a project listing the checkout in `paths`; else none.
 */
export function projectFor(cwd: string, registry: ProjectRegistry): ProjectMatch {
	const git = gitCheckout(cwd);
	const checkout = git ?? realpathSync(cwd);
	const remotes = git === undefined ? [] : checkoutRemotes(git);
	const attached = remotes.flatMap((remote) => {
		const project = registry.projects.find((p) => p.remotes.includes(remote.key));
		return project ? [{ remote, project }] : [];
	});
	const projectsOf = (list: typeof attached) => [...new Set(list.map((m) => m.project))];
	const fromOrigin = attached.filter((m) => m.remote.name === "origin");
	const fromOthers = attached.filter((m) => m.remote.name !== "origin");
	const matched = (project: Project, via: string, warnings: string[] = []): ProjectMatch => ({
		state: "matched",
		project,
		via,
		checkout,
		remotes,
		warnings,
	});

	const [originProject, ...moreOrigin] = projectsOf(fromOrigin);
	if (originProject && moreOrigin.length === 0) {
		const warnings = fromOthers
			.filter((m) => m.project !== originProject)
			.map(
				(m) =>
					`remote ${m.remote.name} (${m.remote.key}) is attached to ${m.project.label} (${m.project.id}); ` +
					`using ${originProject.label} (${originProject.id}) from origin`,
			);
		return matched(originProject, "origin", warnings);
	}
	if (originProject) return { state: "ambiguous", checkout, remotes, candidates: attached };
	const others = projectsOf(fromOthers);
	const [first] = fromOthers;
	if (first && others.length === 1) return matched(first.project, first.remote.name);
	if (others.length > 1) return { state: "ambiguous", checkout, remotes, candidates: fromOthers };
	const listed = registry.projects.find((p) => p.paths.includes(checkout));
	if (listed) return matched(listed, "path");
	const reason = git === undefined ? "no-git" : remotes.length === 0 ? "no-remote" : "unattached";
	return { state: "none", checkout, remotes, reason };
}
