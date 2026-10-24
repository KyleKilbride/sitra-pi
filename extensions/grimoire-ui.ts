/**
 * Grimoire web UI: a local, zero-dependency HTTP server (`127.0.0.1`, random port, random URL token, strict Host check)
 * and a single self-contained HTML page for viewing and hand-editing Grimoire. Pure logic plus `node:http`; no Pi
 * imports. Reuses `grimoire.ts`, `triggers.ts`, `learn.ts`, `cli/config.ts` and `cli/grimoire.ts`.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig, sitraHome } from "../cli/config.ts";
import {
	CLAUDE_CONTEXT_MAX,
	CODEX_CONTEXT_CHARS,
	DEFAULT_LEARN_MODEL,
	hookContext,
	hooksStatus,
} from "../cli/grimoire.ts";
import {
	type CatalogueFit,
	claudeImport,
	decide,
	type Entry,
	entriesFor,
	grimoireSection,
	KINDS,
	type Kind,
	LIMITS,
	linkReport,
	listEntries,
	listProposals,
	listRejected,
	loadRoot,
	type ProjectCatalogue,
	parseEntry,
	type RootText,
	renderEntry,
	sectionCatalogue,
	setScope,
	slug,
	unreadableProposals,
} from "./grimoire.ts";
import { type Call, type Moment, pauseOutcomes, repeats, tally } from "./learn.ts";
import {
	checkoutRemotes,
	normalizeRemote,
	PROJECTS_FILE,
	type Project,
	pathWarning,
	projectIdOf,
	projectsOn,
	type Remote,
	readProjects,
	refreshClaudeRoot,
	type SessionProject,
	sectionScopeOf,
	sessionProject,
	writeProjects,
} from "./project.ts";
import { gitCheckout } from "./sessions.ts";
import { actionFromHook, actionFromPi, parseTrigger, triggerMatches } from "./triggers.ts";

export interface BrokenLink {
	file: string;
	kind: "root" | "entry" | "proposal";
	title?: string;
}

export interface EntryInput {
	kind: Kind;
	title: string;
	summary?: string;
	body: string;
	date?: string;
	evidence?: string;
	proposedBy?: string;
	tags?: string[];
	links?: string[];
	when?: string[];
	/** Project ids from `projects.json`; `null` makes the entry global. Left out, an edit keeps the entry's scope. */
	scope?: string[] | null;
}

export interface LinkActionOptions {
	onLinks?: "repoint" | "remove" | "ignore";
	repointTo?: string;
}

export interface GrimoireServer {
	url: string;
	port: number;
	token: string;
	close(): Promise<void>;
}

const ALLOWED_ROOTS = ["root", "kinds", "proposals", "rejected"] as const;
type AllowedRoot = (typeof ALLOWED_ROOTS)[number];
const KIND_FOLDERS = new Set<string>(KINDS.map((k) => `${k}s`));
const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));

const realOrResolve = (p: string) => {
	try {
		return existsSync(p) ? realpathSync(p) : resolve(p);
	} catch {
		return resolve(p);
	}
};

/**
 * Validates that `relPath` is a safe relative `.md` path under `root/`, `kinds/<plural>/`, `proposals/` or `rejected/`,
 * and that it resolves inside `dir`. Rejects `..`, absolute paths, backslashes, null bytes and non-markdown files.
 */
export function validateGrimoirePath(
	dir: string,
	relPath: string,
	allowedRoots: readonly AllowedRoot[] = ALLOWED_ROOTS,
): string {
	if (typeof relPath !== "string" || !relPath.trim()) {
		throw new Error("Path is required.");
	}
	if (relPath.includes("\0") || relPath.includes("\\") || isAbsolute(relPath) || relPath.startsWith("/")) {
		throw new Error(`Invalid path: ${relPath}`);
	}
	const parts = relPath.split("/");
	if (parts.some((p) => !p || p === "." || p === "..")) {
		throw new Error(`Invalid path segments: ${relPath}`);
	}
	if (!relPath.endsWith(".md")) {
		throw new Error(`Only .md files are allowed: ${relPath}`);
	}
	const top = parts[0] as AllowedRoot;
	if (!allowedRoots.includes(top)) {
		throw new Error(`Path must be under ${allowedRoots.join(", ")}: ${relPath}`);
	}
	if (top === "kinds") {
		if (parts.length !== 3 || !KIND_FOLDERS.has(parts[1] ?? "")) {
			throw new Error(`Entry path must be kinds/<plural>/<file>.md: ${relPath}`);
		}
	} else if (parts.length !== 2) {
		throw new Error(`Path must be ${top}/<file>.md: ${relPath}`);
	}
	if ((parts.at(-1) ?? "") === ".md") {
		throw new Error(`Invalid file name: ${relPath}`);
	}
	const base = realOrResolve(dir);
	const resolved = resolve(base, relPath);
	const rel = relative(base, resolved);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`Path escapes Grimoire folder: ${relPath}`);
	}
	const parent = dirname(resolved);
	if (existsSync(parent)) {
		const realParent = realpathSync(parent);
		const parentRel = relative(base, realParent);
		if (parentRel.startsWith("..") || isAbsolute(parentRel)) {
			throw new Error(`Path escapes Grimoire folder via symlink: ${relPath}`);
		}
	}
	if (existsSync(resolved)) {
		const realTarget = realpathSync(resolved);
		const targetRel = relative(base, realTarget);
		if (targetRel.startsWith("..") || isAbsolute(targetRel)) {
			throw new Error(`File escapes Grimoire folder via symlink: ${relPath}`);
		}
	}
	return parts.join("/");
}

// ---------------------------------------------------------------------------------------------------------------------
// Link discovery and repointing / removal
// ---------------------------------------------------------------------------------------------------------------------

function rootMarkdownFiles(dir: string): string[] {
	const rootDir = join(dir, "root");
	if (!existsSync(rootDir)) return [];
	return readdirSync(rootDir)
		.filter((f) => f.endsWith(".md"))
		.sort((a, b) => {
			const ra = a.toLowerCase() === "readme.md" ? 0 : 1;
			const rb = b.toLowerCase() === "readme.md" ? 0 : 1;
			return ra - rb || a.localeCompare(b);
		})
		.map((f) => `root/${f}`);
}

function textMentionsTarget(text: string, targetFile: string): boolean {
	return text.includes(targetFile);
}

/** Finds every root file, approved entry and proposal that links to `targetFile`. */
export function findLinks(dir: string, targetFile: string): BrokenLink[] {
	const clean = validateGrimoirePath(dir, targetFile);
	const out: BrokenLink[] = [];
	for (const rf of rootMarkdownFiles(dir)) {
		try {
			const raw = readFileSync(join(dir, rf), "utf8");
			if (textMentionsTarget(raw, clean)) out.push({ file: rf, kind: "root" });
		} catch {
			// Skip unreadable root file.
		}
	}
	for (const entry of listEntries(dir)) {
		if (entry.file === clean) continue;
		const inLinks = (entry.links ?? []).includes(clean);
		const inBody = textMentionsTarget(entry.body, clean);
		if (inLinks || inBody) out.push({ file: entry.file, kind: "entry", title: entry.title });
	}
	for (const prop of listProposals(dir)) {
		if (prop.file === clean) continue;
		const inLinks = (prop.links ?? []).includes(clean);
		const inBody = textMentionsTarget(prop.body, clean);
		if (inLinks || inBody) out.push({ file: prop.file, kind: "proposal", title: prop.title });
	}
	return out;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceTargetInText(text: string, fromFile: string, mode: "repoint" | "remove", toFile?: string): string {
	if (mode === "repoint" && toFile) {
		return text.replaceAll(`../${fromFile}`, `../${toFile}`).replaceAll(fromFile, toFile);
	}
	// Remove markdown links `[label](../fromFile)` or `[label](fromFile)` -> `label`, and strip bare occurrences.
	const mdLink = new RegExp(`\\[([^\\]]+)\\]\\((?:\\.\\.\\/)?${escapeRegExp(fromFile)}\\)`, "g");
	return text.replace(mdLink, "$1").replaceAll(`../${fromFile}`, "").replaceAll(fromFile, "");
}

function applyLinkUpdates(
	dir: string,
	broken: readonly BrokenLink[],
	fromFile: string,
	mode: "repoint" | "remove",
	toFile?: string,
): string[] {
	const updated: string[] = [];
	for (const item of broken) {
		const full = join(dir, item.file);
		if (!existsSync(full)) continue;
		if (item.kind === "root") {
			const before = readFileSync(full, "utf8");
			const after = replaceTargetInText(before, fromFile, mode, toFile);
			if (after !== before) {
				writeFileSync(full, after);
				updated.push(item.file);
			}
			continue;
		}
		const entry = parseEntry(readFileSync(full, "utf8"), item.file);
		if (!entry) continue;
		const nextLinks =
			mode === "repoint" && toFile
				? Array.from(new Set((entry.links ?? []).map((l) => (l === fromFile ? toFile : l))))
				: (entry.links ?? []).filter((l) => l !== fromFile);
		const nextBody = replaceTargetInText(entry.body, fromFile, mode, toFile);
		writeFileSync(
			full,
			renderEntry({
				...entry,
				body: nextBody,
				links: nextLinks.length > 0 ? nextLinks : undefined,
			}),
		);
		updated.push(item.file);
	}
	if (updated.some((f) => f.startsWith("root/")) && existsSync(join(dir, ".sitra", "root.md"))) {
		try {
			refreshClaudeRoot(dir);
		} catch {
			// Best effort.
		}
	}
	return updated;
}

// ---------------------------------------------------------------------------------------------------------------------
// Store operations for the UI
// ---------------------------------------------------------------------------------------------------------------------

function cleanStringList(items: unknown): string[] | undefined {
	if (!Array.isArray(items)) return undefined;
	const out = items
		.filter((x): x is string => typeof x === "string")
		.map((s) => s.trim())
		.filter(Boolean);
	return out.length > 0 ? out : undefined;
}

function cleanTriggers(items: unknown): string[] | undefined {
	const list = cleanStringList(items);
	if (!list) return undefined;
	const valid = list.filter((w) => Boolean(parseTrigger(w)));
	return valid.length > 0 ? valid : undefined;
}

function uniquePath(dir: string, folder: string, stem: string): string {
	mkdirSync(join(dir, folder), { recursive: true });
	let rel = `${folder}/${stem}.md`;
	for (let n = 2; existsSync(join(dir, rel)); n++) rel = `${folder}/${stem}-${n}.md`;
	return rel;
}

/** Keeps Claude Code's imported root file current once it exists; every Claude Code session start refreshes it too. */
function refreshImport(dir: string): void {
	if (!existsSync(join(dir, ".sitra", "root.md"))) return;
	try {
		refreshClaudeRoot(dir);
	} catch {
		// Best effort.
	}
}

export function saveRootFile(dir: string, file: string, content: string): { file: string; chars: number } {
	const clean = validateGrimoirePath(dir, file, ["root"]);
	mkdirSync(join(dir, "root"), { recursive: true });
	const normalized = `${content.replace(/\r\n/g, "\n").trimEnd()}\n`;
	writeFileSync(join(dir, clean), normalized);
	refreshImport(dir);
	return { file: clean, chars: normalized.length };
}

/**
 * A scope sent by the page: left out (`undefined`), global (`null`), or ids of projects in `projects.json`. An empty
 * list, `"global"`, an id that isn't registered or anything else throws, naming the problem.
 */
export function checkScope(dir: string, scope: unknown): string[] | null | undefined {
	if (scope === undefined || scope === null) return scope;
	if (!Array.isArray(scope) || scope.some((id) => typeof id !== "string"))
		throw new Error(`scope must be a list of project ids, or null for global, not ${JSON.stringify(scope)}`);
	if (scope.length === 0) throw new Error("scope is an empty list; send null to make it global");
	const { projects } = readProjects(dir);
	if (projects.length === 0)
		throw new Error(`There are no projects in ${join(dir, PROJECTS_FILE)}; add one in the Projects tab first.`);
	const unknown = (scope as string[]).filter((id) => !projects.some((p) => p.id === id));
	if (unknown.length > 0)
		throw new Error(
			`No project ${unknown.map((id) => JSON.stringify(id)).join(", ")} in projects.json; the projects are ${projects.map((p) => p.id).join(", ")}.`,
		);
	return [...new Set(scope as string[])];
}

export function addEntry(dir: string, input: EntryInput): Entry {
	if (!KINDS.includes(input.kind)) throw new Error(`Invalid kind: ${String(input.kind)}`);
	const title = input.title?.trim();
	const body = input.body?.trim();
	if (!title || !body) throw new Error("Title and body are required.");
	const scope = checkScope(dir, input.scope);
	const day =
		typeof input.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.date.slice(0, 10))
			? input.date.slice(0, 10)
			: new Date().toISOString().slice(0, 10);
	const file = uniquePath(dir, `kinds/${input.kind}s`, `${day}-${slug(title)}`);
	const entryData: Omit<Entry, "file"> = {
		kind: input.kind,
		title,
		body,
		date: day,
		...(input.summary?.trim() ? { summary: input.summary.trim() } : {}),
		...(input.evidence?.trim() ? { evidence: input.evidence.trim() } : {}),
		...(input.proposedBy?.trim() ? { proposedBy: input.proposedBy.trim() } : {}),
		...(cleanStringList(input.tags) ? { tags: cleanStringList(input.tags) } : {}),
		...(cleanStringList(input.links) ? { links: cleanStringList(input.links) } : {}),
		...(cleanTriggers(input.when) ? { when: cleanTriggers(input.when) } : {}),
		...(scope ? { scope } : {}),
	};
	writeFileSync(join(dir, file), renderEntry(entryData));
	refreshImport(dir);
	return { ...entryData, file };
}

export function updateEntry(dir: string, file: string, input: Partial<EntryInput>): Entry {
	const clean = validateGrimoirePath(dir, file, ["kinds", "proposals", "rejected"]);
	const full = join(dir, clean);
	if (!existsSync(full)) throw new Error(`Entry not found: ${clean}`);
	const current = parseEntry(readFileSync(full, "utf8"), clean);
	if (!current) throw new Error(`Not a valid Grimoire entry: ${clean}`);
	const kind = input.kind ?? current.kind;
	if (!KINDS.includes(kind)) throw new Error(`Invalid kind: ${String(kind)}`);
	const title = (input.title ?? current.title).trim();
	const body = (input.body ?? current.body).trim();
	if (!title || !body) throw new Error("Title and body are required.");
	const summary = input.summary !== undefined ? input.summary.trim() || undefined : current.summary;
	const evidence = input.evidence !== undefined ? input.evidence.trim() || undefined : current.evidence;
	const proposedBy = input.proposedBy !== undefined ? input.proposedBy.trim() || undefined : current.proposedBy;
	const date = input.date?.trim() || current.date;
	const tags = input.tags !== undefined ? cleanStringList(input.tags) : current.tags;
	const links = input.links !== undefined ? cleanStringList(input.links) : current.links;
	const when = input.when !== undefined ? cleanTriggers(input.when) : current.when;
	const asked = checkScope(dir, input.scope);
	const scope = asked === undefined ? current.scope : (asked ?? undefined);
	const scopeNote = asked === undefined ? current.scopeNote : undefined;

	const updated: Omit<Entry, "file"> = {
		kind,
		title,
		body,
		date,
		...(summary ? { summary } : {}),
		...(evidence ? { evidence } : {}),
		...(proposedBy ? { proposedBy } : {}),
		...(tags ? { tags } : {}),
		...(links ? { links } : {}),
		...(when ? { when } : {}),
		...(scope ? { scope } : {}),
		...(scopeNote ? { scopeNote } : {}),
		...(current.extra ? { extra: current.extra } : {}),
	};
	writeFileSync(full, renderEntry(updated));
	refreshImport(dir);
	return { ...updated, file: clean };
}

export function moveEntry(
	dir: string,
	file: string,
	kind: Kind,
	options: LinkActionOptions = {},
): { file?: string; entry?: Entry; brokenLinks?: BrokenLink[]; updatedLinks: string[] } {
	const clean = validateGrimoirePath(dir, file, ["kinds"]);
	if (!KINDS.includes(kind)) throw new Error(`Invalid kind: ${String(kind)}`);
	const full = join(dir, clean);
	if (!existsSync(full)) throw new Error(`Entry not found: ${clean}`);
	const current = parseEntry(readFileSync(full, "utf8"), clean);
	if (!current) throw new Error(`Not a valid Grimoire entry: ${clean}`);
	if (current.kind === kind && clean.startsWith(`kinds/${kind}s/`)) {
		return { file: clean, entry: current, updatedLinks: [] };
	}
	const broken = findLinks(dir, clean);
	if (broken.length > 0 && !options.onLinks) {
		return { brokenLinks: broken, updatedLinks: [] };
	}
	const to = uniquePath(dir, `kinds/${kind}s`, basename(clean, ".md"));
	const updatedEntry: Omit<Entry, "file"> = { ...current, kind };
	renameSync(full, join(dir, to));
	writeFileSync(join(dir, to), renderEntry(updatedEntry));
	let updatedLinks: string[] = [];
	if (broken.length > 0 && options.onLinks && options.onLinks !== "ignore") {
		const target = options.repointTo ? validateGrimoirePath(dir, options.repointTo, ["kinds"]) : to;
		updatedLinks = applyLinkUpdates(dir, broken, clean, options.onLinks, target);
	}
	return { file: to, entry: { ...updatedEntry, file: to }, updatedLinks };
}

/** Moves an approved entry into `rejected/` (never a hard delete), checking for broken links first. */
export function deleteEntry(
	dir: string,
	file: string,
	options: LinkActionOptions = {},
): { file?: string; brokenLinks?: BrokenLink[]; updatedLinks: string[] } {
	const clean = validateGrimoirePath(dir, file, ["kinds"]);
	const full = join(dir, clean);
	if (!existsSync(full)) throw new Error(`Entry not found: ${clean}`);
	const current = parseEntry(readFileSync(full, "utf8"), clean);
	if (!current) throw new Error(`Not a valid Grimoire entry: ${clean}`);
	const broken = findLinks(dir, clean);
	if (broken.length > 0 && !options.onLinks) {
		return { brokenLinks: broken, updatedLinks: [] };
	}
	if (broken.length > 0 && options.onLinks === "repoint" && !options.repointTo) {
		throw new Error("repointTo is required when repointing links on delete.");
	}
	let updatedLinks: string[] = [];
	if (broken.length > 0 && options.onLinks && options.onLinks !== "ignore") {
		const target = options.repointTo ? validateGrimoirePath(dir, options.repointTo, ["kinds"]) : undefined;
		updatedLinks = applyLinkUpdates(dir, broken, clean, options.onLinks, target);
	}
	const to = uniquePath(dir, "rejected", basename(clean, ".md"));
	renameSync(full, join(dir, to));
	return { file: to, updatedLinks };
}

/** Accepts a proposal, optionally as another kind and with a scope (`null`: global; left out: the proposal's own). */
export function acceptProposal(dir: string, file: string, kind?: Kind, scope?: string[] | null): Entry {
	const clean = validateGrimoirePath(dir, file, ["proposals"]);
	if (kind !== undefined && !KINDS.includes(kind)) throw new Error(`Invalid kind: ${String(kind)}`);
	const checked = checkScope(dir, scope);
	const to = decide(dir, clean, "accept", { kind, ...(checked !== undefined ? { scope: checked } : {}) });
	const entry = parseEntry(readFileSync(join(dir, to), "utf8"), to);
	if (!entry) throw new Error(`Failed to read accepted entry: ${to}`);
	refreshImport(dir);
	return entry;
}

/** Sets the scope of entries in `kinds/`, `proposals/` or `rejected/` through `setScope`; `null` makes them global. */
export function scopeEntries(dir: string, files: unknown, scope: unknown): string[] {
	if (!Array.isArray(files) || files.length === 0 || files.some((f) => typeof f !== "string"))
		throw new Error("files must be a non-empty list of entry paths");
	if (scope === undefined) throw new Error("scope is required: a list of project ids, or null for global");
	const checked = checkScope(dir, scope);
	const clean = (files as string[]).map((f) => validateGrimoirePath(dir, f, ["kinds", "proposals", "rejected"]));
	const changed = setScope(dir, clean, checked ?? undefined);
	refreshImport(dir);
	return changed;
}

/**
 * Saves the registry the page sends: every path is stored as its real path (it must be an existing folder), then
 * `writeProjects` validates and writes. Returns what was saved and warnings: paths that won't match, and entries
 * left scoped to projects no longer listed.
 */
export function saveProjects(dir: string, body: unknown): { projects: Project[]; warnings: string[] } {
	const list = (body as { projects?: unknown } | null)?.projects;
	if (!Array.isArray(list)) throw new Error('Send { "projects": [ ... ] }.');
	const projects = list.map((p: unknown) => {
		const paths = (p as { paths?: unknown } | null)?.paths;
		if (!Array.isArray(paths)) return p;
		return {
			...(p as object),
			paths: paths.map((path: unknown) => {
				if (typeof path !== "string" || !isAbsolute(path)) return path;
				if (!existsSync(path)) throw new Error(`There is no folder at ${path}.`);
				return realpathSync(path);
			}),
		};
	}) as Project[];
	writeProjects(dir, { projects });
	const saved = readProjects(dir).projects;
	const warnings = saved.flatMap((p) => p.paths.flatMap((path) => pathWarning(path) ?? []));
	const ids = new Set(saved.map((p) => p.id));
	const orphaned = [...listEntries(dir), ...listProposals(dir)].filter((e) => e.scope?.some((id) => !ids.has(id)));
	if (orphaned.length > 0) {
		const missing = [...new Set(orphaned.flatMap((e) => (e.scope ?? []).filter((id) => !ids.has(id))))];
		warnings.push(
			`${orphaned.length} ${orphaned.length === 1 ? "entry is" : "entries are"} scoped to ${missing.join(", ")}, which ${missing.length === 1 ? "isn't" : "aren't"} in projects.json; no session sees them there until their scope changes.`,
		);
	}
	refreshImport(dir);
	return { projects: saved, warnings };
}

export function rejectProposal(dir: string, file: string): { file: string } {
	const clean = validateGrimoirePath(dir, file, ["proposals"]);
	const to = decide(dir, clean, "reject");
	return { file: to };
}

export function restoreRejected(dir: string, file: string, kind?: Kind): Entry {
	const clean = validateGrimoirePath(dir, file, ["rejected"]);
	const full = join(dir, clean);
	if (!existsSync(full)) throw new Error(`Rejected entry not found: ${clean}`);
	const entry = parseEntry(readFileSync(full, "utf8"), clean);
	if (!entry) throw new Error(`${clean} is not a Grimoire entry`);
	const targetKind = kind ?? entry.kind;
	if (!KINDS.includes(targetKind)) throw new Error(`Invalid kind: ${String(targetKind)}`);
	const to = uniquePath(dir, `kinds/${targetKind}s`, basename(clean, ".md"));
	const updated: Omit<Entry, "file"> = { ...entry, kind: targetKind };
	renameSync(full, join(dir, to));
	writeFileSync(join(dir, to), renderEntry(updated));
	return { ...updated, file: to };
}

// ---------------------------------------------------------------------------------------------------------------------
// Snapshot: what agents get, hooks, settings, root, entries, proposals, rejected
// ---------------------------------------------------------------------------------------------------------------------

function installedExtensions(): string[] {
	try {
		const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { pi?: { extensions?: string[] } };
		return Array.isArray(pkg.pi?.extensions) ? pkg.pi.extensions : [];
	} catch {
		return [];
	}
}

/** One part of what a tool loads (a root part), against its budget, with how much the cap left out. */
export interface RootPart {
	files: string[];
	/** Size before the cap. */
	chars: number;
	/** Characters left out by the cap; the agent is told where to read the rest. */
	cut: number;
	limit: number;
	truncated: boolean;
}

/** A catalogue as a tool gets it: how many entries are listed, and where the rest are, said in `note`. */
export interface CatalogueView {
	chars: number;
	total: number;
	shown: number;
	titlesOnly: boolean;
	overflow?: { count: number; file: string };
	limit?: number;
	note: string;
}

export type ProjectView = SessionProject & { text: string };

/** The Pi session `/grimoire-ui` was opened from: its folder and the project it found when it started. */
export interface SnapshotSession {
	cwd?: string;
	project?: SessionProject;
}

const part = (r: RootText, limit: number): RootPart => ({
	files: r.files,
	chars: r.chars,
	cut: r.cut,
	limit,
	truncated: r.truncated,
});

const plural = (n: number) => `${n} ${n === 1 ? "entry" : "entries"}`;

function catalogueView(fit: CatalogueFit | ProjectCatalogue, limit?: number): CatalogueView {
	const extra = limit === undefined ? {} : { limit };
	if ("titlesOnly" in fit) {
		const total = fit.shown + (fit.overflow?.count ?? 0);
		const note = fit.overflow
			? `${fit.shown} of ${total} listed as titles only; ${plural(fit.overflow.count)} moved to ${fit.overflow.file}`
			: fit.titlesOnly
				? `all ${plural(total)} listed as titles only (summaries didn't fit)`
				: `all ${plural(total)} listed in full`;
		return {
			chars: fit.text.length,
			total,
			shown: fit.shown,
			titlesOnly: fit.titlesOnly,
			...(fit.overflow ? { overflow: fit.overflow } : {}),
			...extra,
			note,
		};
	}
	const note =
		fit.total === 0
			? "no entries"
			: fit.shown === fit.total
				? `all ${plural(fit.total)} listed in full`
				: `${fit.shown} of ${fit.total} listed in full; ${plural(fit.total - fit.shown)} not listed, counted in the last line for agents to search`;
	return { chars: fit.text.length, total: fit.total, shown: fit.shown, titlesOnly: false, ...extra, note };
}

/** How the page names a project choice, saying why when there is no project. */
export function projectText(project: SessionProject): string {
	if (project.state === "off") return "No projects in projects.json, so every entry is global, as before projects.";
	if (project.state === "global") return `No project: global entries only, because ${project.why}.`;
	const { id, label } = project.project;
	const from =
		project.via === "picker"
			? "chosen on this page"
			: project.via === "path"
				? "from its folder, listed in projects.json"
				: `from remote ${project.via}`;
	return [`${label} (${id}), ${from}.`, ...project.warnings.map((w) => `Warning: ${w}.`)].join(" ");
}

const view = (project: SessionProject): ProjectView => ({ ...project, text: projectText(project) });

/** The registry for the page, or why it can't be read. */
function registryView(dir: string): { file: string; inUse: boolean; list: Project[]; error?: string } {
	const file = join(dir, PROJECTS_FILE);
	try {
		const list = readProjects(dir).projects;
		return { file, inUse: list.length > 0, list };
	} catch (error) {
		return { file, inUse: true, list: [], error: error instanceof Error ? error.message : String(error) };
	}
}

/** The session's folder, its checkout and remotes (for "attach this checkout's remotes"), or why there are none. */
function sessionView(_dir: string, session: SnapshotSession) {
	const base = {
		...(session.cwd ? { cwd: session.cwd } : {}),
		...(session.project ? { project: view(session.project) } : {}),
	};
	if (!session.cwd) return { ...base, remotes: [] as Remote[], remotesWhy: "/grimoire-ui wasn't given a folder" };
	const checkout = gitCheckout(session.cwd);
	if (checkout === undefined) return { ...base, remotes: [] as Remote[], remotesWhy: "not in a git repository" };
	try {
		const remotes = checkoutRemotes(checkout);
		return {
			...base,
			checkout,
			remotes,
			...(remotes.length === 0 ? { remotesWhy: "the git repository has no remote" } : {}),
		};
	} catch (error) {
		return {
			...base,
			checkout,
			remotes: [] as Remote[],
			remotesWhy: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Everything the page shows. What agents get is built for `project` (the preview the page picked; with no projects
 * registered, `off`, as before projects): the Pi section, the Claude Code import and session hook, and the Codex
 * session hook, each part against its budget, with what the caps cut and where the rest of a catalogue went.
 */
export function snapshot(
	dir: string,
	env: Record<string, string | undefined> = process.env,
	project?: SessionProject,
	session: SnapshotSession = {},
) {
	const home = env.HOME?.trim() || homedir();
	const sitra = sitraHome(env, home);
	const config = readConfig(sitra);
	const who = env.SITRA_USER_NAME?.trim() || config.name?.trim() || "the person you work with";

	const projects = registryView(dir);
	const preview: SessionProject =
		project ?? (projects.inUse ? { state: "global", why: "no project was chosen for this preview" } : { state: "off" });
	const id = projectIdOf(preview);
	const root = loadRoot(dir, id);
	const entries = listEntries(dir);
	const proposals = listProposals(dir);
	const rejected = listRejected(dir);
	const unreadable = unreadableProposals(dir);
	const piEntries = entriesFor(entries, id);
	const piOptions = { who, scope: sectionScopeOf(preview) };
	const leadPrompt = grimoireSection(dir, root, piEntries, piOptions);
	const piCatalogue = sectionCatalogue(dir, piEntries, piOptions);
	const globalLimit = id === undefined ? LIMITS.rootChars : LIMITS.globalRootChars;

	const claudeRootPath = join(dir, ".sitra", "root.md");
	const onDisk = existsSync(claudeRootPath) ? readFileSync(claudeRootPath, "utf8") : undefined;
	const claudeImported = claudeImport(dir, LIMITS.rootChars, projectsOn(dir));
	const claudeHook = hookContext("claude", dir, who, preview);
	const codexHook = hookContext("codex", dir, who, preview);
	const codexRoot = codexHook.root ?? root;

	const claudeHooks = hooksStatus(home, "claude");
	const codexHooks = hooksStatus(home, "codex");

	const rootFiles = rootMarkdownFiles(dir).map((rf) => {
		const content = readFileSync(join(dir, rf), "utf8");
		return { file: rf, name: basename(rf), content, chars: content.length };
	});

	const outcomesByFile = new Map(pauseOutcomes(dir).map((o) => [o.file, o]));
	const learnEnabled = env.SITRA_GRIMOIRE_LEARN !== "0" && config.learn !== false;
	const learnModel = env.SITRA_LEARN_MODEL?.trim() || config.learnModel?.trim() || DEFAULT_LEARN_MODEL;

	return {
		dir,
		who,
		limits: LIMITS,
		projects,
		session: sessionView(dir, session),
		preview: view(preview),
		links: linkReport(dir, id),
		whatAgentsGet: {
			everyPrompt: {
				text: leadPrompt,
				chars: leadPrompt.length,
			},
			pi: {
				globalRoot: part(root.global, globalLimit),
				...(id !== undefined ? { projectRoot: part(root.project, LIMITS.projectRootChars) } : {}),
				catalogue: catalogueView(piCatalogue, LIMITS.catalogueChars),
				rootLimit: LIMITS.rootChars,
			},
			root: {
				text: root.text,
				files: root.files,
				chars: root.chars,
				limit: LIMITS.rootChars,
				truncated: root.truncated,
			},
			catalogue: {
				text: piCatalogue.text,
				chars: piCatalogue.text.length,
				limit: LIMITS.catalogueChars,
				totalEntries: piEntries.length,
			},
			claudeCode: {
				rootFile: claudeRootPath,
				rootText: onDisk ?? (root.text || null),
				/** What the import file holds after the next Claude Code session start (it is rewritten then). */
				importText: claudeImported.text,
				importChars: claudeImported.text.length,
				importLimit: LIMITS.globalRootChars + LIMITS.catalogueChars,
				importOnDisk: onDisk === undefined ? "missing" : onDisk === claudeImported.text ? "current" : "stale",
				importRoot: part(claudeImported.root.global, projectsOn(dir) ? LIMITS.globalRootChars : LIMITS.rootChars),
				...(claudeImported.catalogue
					? { importCatalogue: catalogueView(claudeImported.catalogue, LIMITS.catalogueChars) }
					: {}),
				hookText: claudeHook.text,
				hookChars: claudeHook.text.length,
				hookLimit: CLAUDE_CONTEXT_MAX,
				...(id !== undefined && claudeHook.root
					? { projectRoot: part(claudeHook.root.project, LIMITS.projectRootChars) }
					: {}),
				...(claudeHook.catalogue ? { catalogue: catalogueView(claudeHook.catalogue) } : {}),
			},
			codex: {
				rootText: codexRoot.text,
				hookText: codexHook.text,
				hookChars: codexHook.text.length,
				hookLimit: CODEX_CONTEXT_CHARS,
				globalRoot: part(codexRoot.global, globalLimit),
				...(id !== undefined ? { projectRoot: part(codexRoot.project, LIMITS.projectRootChars) } : {}),
				catalogue: catalogueView(codexHook.catalogue ?? { text: "", shown: 0, total: 0 }, LIMITS.catalogueChars),
			},
			hooks: {
				claudeCode: {
					path: claudeHooks.path,
					claudeMdPath: claudeHooks.claudeMd?.path,
					claudeMdImported: claudeHooks.claudeMd?.imported ?? false,
					installed: claudeHooks.installed,
					status: claudeHooks.status,
					missing: claudeHooks.missing,
					events: claudeHooks.events,
				},
				codex: {
					path: codexHooks.path,
					installed: codexHooks.installed,
					status: codexHooks.status,
					missing: codexHooks.missing,
					events: codexHooks.events,
				},
			},
			settings: {
				extensions: installedExtensions(),
				env: {
					SITRA_SHARPEN: env.SITRA_SHARPEN ?? "1 (default on)",
					SITRA_GRIMOIRE_LOOK: env.SITRA_GRIMOIRE_LOOK ?? "1 (default on)",
				},
				learn: config.learn ?? learningOnFlag(env),
				learnActive: learnEnabled,
				learnModel,
				configPath: join(sitra, "config.json"),
			},
		},
		rootFiles,
		entries: entries.map((e) => ({
			...e,
			pauseStats: outcomesByFile.get(e.file) ?? { file: e.file, pauses: 0, changed: 0, repeated: 0 },
		})),
		proposals,
		unreadableProposals: unreadable,
		rejected,
		repeatsWaiting: repeats(dir),
		todayLog: dayLog(dir),
	};
}

function learningOnFlag(env: Record<string, string | undefined>): boolean {
	return env.SITRA_GRIMOIRE_LEARN !== "0";
}

// ---------------------------------------------------------------------------------------------------------------------
// Daily log: pauses, corrections and repeats for a given date (YYYY-MM-DD)
// ---------------------------------------------------------------------------------------------------------------------

function localDateString(d = new Date()): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

interface RawPauseLine {
	at?: string;
	file?: string;
	files?: string[];
	outcome?: "changed" | "repeated";
	session?: string;
	cwd?: string;
	repo?: string;
	when?: string | string[];
	call?: Call;
	tool?: string;
	command?: string;
	path?: string;
}

function readAllMoments(dir: string): Moment[] {
	const folder = join(dir, ".sitra", "moments");
	if (!existsSync(folder)) return [];
	return readdirSync(folder)
		.filter((f) => f.endsWith(".json"))
		.sort()
		.flatMap((f) => {
			try {
				return [JSON.parse(readFileSync(join(folder, f), "utf8")) as Moment];
			} catch {
				return [];
			}
		});
}

function describeAction(
	raw: RawPauseLine,
	entries: readonly Entry[],
): {
	when: string[];
	action: { tool?: string; command?: string; path?: string; summary: string };
} {
	const call = raw.call;
	const tool = call?.tool ?? raw.tool;
	const input = (call?.input ?? {}) as Record<string, unknown>;
	const command =
		typeof raw.command === "string"
			? raw.command
			: typeof input.command === "string"
				? input.command
				: typeof input.cmd === "string"
					? input.cmd
					: undefined;
	const path =
		typeof raw.path === "string"
			? raw.path
			: typeof input.path === "string"
				? input.path
				: typeof input.file_path === "string"
					? input.file_path
					: undefined;
	const cwd = raw.cwd ?? raw.repo ?? "";
	const matchedWhen = new Set<string>();
	if (typeof raw.when === "string" && raw.when.trim()) matchedWhen.add(raw.when.trim());
	if (Array.isArray(raw.when)) {
		for (const w of raw.when) if (typeof w === "string" && w.trim()) matchedWhen.add(w.trim());
	}
	if (tool) {
		const act = tool === tool.toLowerCase() ? actionFromPi(tool, input) : actionFromHook(tool, input);
		for (const e of entries) {
			for (const w of e.when ?? []) {
				const parsed = parseTrigger(w);
				if (parsed && triggerMatches(parsed, act, cwd)) matchedWhen.add(w);
			}
		}
	}
	if (matchedWhen.size === 0) {
		for (const e of entries) for (const w of e.when ?? []) matchedWhen.add(w);
	}
	const summaryParts: string[] = [];
	if (tool) summaryParts.push(`tool: ${tool}`);
	if (command) summaryParts.push(`command: ${command}`);
	if (path) summaryParts.push(`path: ${path}`);
	return {
		when: [...matchedWhen],
		action: {
			...(tool ? { tool } : {}),
			...(command ? { command } : {}),
			...(path ? { path } : {}),
			summary: summaryParts.join(" · ") || "matching action",
		},
	};
}

export function dayLog(dir: string, date = localDateString()) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw new Error(`Invalid date (expected YYYY-MM-DD): ${date}`);
	}
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
	const endOfDay = new Date(y, m - 1, d, 23, 59, 59, 999);
	const end = endOfDay.getTime();
	const inDay = (iso: string | undefined) => {
		const t = Date.parse(iso ?? "");
		return Number.isFinite(t) && t >= start && t <= end;
	};

	const entryByFile = new Map<string, Entry>();
	for (const e of [...listEntries(dir), ...listProposals(dir), ...listRejected(dir)]) {
		entryByFile.set(e.file, e);
		entryByFile.set(basename(e.file), e);
	}

	const pauses: Array<{
		type: "pause";
		at: string;
		session: string;
		repo: string;
		entries: Array<{ file: string; title: string; kind: Kind; when: string[] }>;
		when: string[];
		action: { tool?: string; command?: string; path?: string; summary: string };
		outcome: "caught" | "repeated";
		rawOutcome: "changed" | "repeated";
	}> = [];
	const pausesFile = join(dir, ".sitra", "pauses.jsonl");
	if (existsSync(pausesFile)) {
		for (const line of readFileSync(pausesFile, "utf8").split("\n")) {
			if (!line.trim()) continue;
			let r: RawPauseLine;
			try {
				r = JSON.parse(line) as RawPauseLine;
			} catch {
				continue;
			}
			if (!inDay(r.at)) continue;
			const files = Array.isArray(r.files) ? r.files : r.file ? [r.file] : [];
			const shownEntries = files.map((f) => {
				const found = entryByFile.get(f) ?? entryByFile.get(basename(f));
				return {
					file: f,
					title: found?.title ?? basename(f, ".md"),
					kind: found?.kind ?? "lesson",
					when: found?.when ?? [],
				};
			});
			const fullEntries = files.flatMap((f) => {
				const found = entryByFile.get(f) ?? entryByFile.get(basename(f));
				return found ? [found] : [];
			});
			const { when, action } = describeAction(r, fullEntries);
			const outcome = r.outcome === "changed" ? "caught" : "repeated";
			pauses.push({
				type: "pause",
				at: r.at ?? "",
				session: r.session ?? "session",
				repo: r.cwd ?? r.repo ?? "",
				entries: shownEntries,
				when,
				action,
				outcome,
				rawOutcome: r.outcome ?? "repeated",
			});
		}
	}

	const corrections: Array<{
		type: "correction";
		id: string;
		at: string;
		harness: Moment["harness"];
		cwd: string;
		message: string;
		verdict: "correction" | "other" | "pending";
		outcome: "learned" | "repeat" | "correction" | "not-correction" | "pending";
		proposal?: string;
		proposalTitle?: string;
		covered?: string;
	}> = [];
	const repeatEvents: Array<{
		type: "repeat";
		id: string;
		at: string;
		harness: Moment["harness"];
		cwd: string;
		message: string;
		rule: string;
		covered: string;
	}> = [];
	for (const moment of readAllMoments(dir)) {
		if (!inDay(moment.at)) continue;
		const verdict: "correction" | "other" | "pending" = moment.verdict ?? "pending";
		const outcome: "learned" | "repeat" | "correction" | "not-correction" | "pending" =
			verdict !== "correction"
				? verdict === "other"
					? "not-correction"
					: "pending"
				: moment.proposal
					? "learned"
					: moment.skipped
						? "repeat"
						: "correction";
		const propEntry = moment.proposal
			? (entryByFile.get(moment.proposal) ?? entryByFile.get(basename(moment.proposal)))
			: undefined;
		corrections.push({
			type: "correction",
			id: moment.id,
			at: moment.at,
			harness: moment.harness,
			cwd: moment.cwd ?? "",
			message: moment.message ?? "(message not retained: judged not a correction)",
			verdict,
			outcome,
			...(moment.proposal ? { proposal: propEntry?.file ?? moment.proposal, proposalTitle: propEntry?.title } : {}),
			...(moment.skipped ? { covered: moment.skipped } : {}),
		});
		if (verdict === "correction" && moment.skipped) {
			repeatEvents.push({
				type: "repeat",
				id: moment.id,
				at: moment.at,
				harness: moment.harness,
				cwd: moment.cwd ?? "",
				message: moment.message ?? "",
				rule: moment.skipped,
				covered: moment.skipped,
			});
		}
	}

	const byNewest = (a: { at: string }, b: { at: string }) => b.at.localeCompare(a.at);
	pauses.sort(byNewest);
	corrections.sort(byNewest);
	repeatEvents.sort(byNewest);
	const events = [...pauses, ...corrections].sort(byNewest);

	return {
		date,
		tally: tally(dir, endOfDay),
		pauses,
		corrections,
		repeats: repeatEvents,
		events,
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// Self-contained HTML page
// ---------------------------------------------------------------------------------------------------------------------

export function renderPage(token: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grimoire — sitra</title>
<style>
	:root {
		--bg: #0f1419;
		--panel: #161d24;
		--panel-alt: #1c252e;
		--border: #2a3644;
		--text: #e6edf3;
		--muted: #8b949e;
		--accent: #58a6ff;
		--ok: #3fb950;
		--warn: #d29922;
		--danger: #f85149;
		--chip: #212c38;
		--mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		--sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
	}
	* { box-sizing: border-box; }
	body {
		margin: 0;
		background: var(--bg);
		color: var(--text);
		font-family: var(--sans);
		font-size: 14px;
		line-height: 1.5;
	}
	header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 14px 20px;
		background: var(--panel);
		border-bottom: 1px solid var(--border);
		position: sticky;
		top: 0;
		z-index: 10;
	}
	header h1 {
		margin: 0;
		font-size: 17px;
		font-weight: 600;
	}
	.tally-pill {
		font-family: var(--mono);
		font-size: 12px;
		padding: 4px 10px;
		border-radius: 999px;
		background: var(--chip);
		border: 1px solid var(--border);
		color: var(--text);
	}
	nav {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		padding: 10px 20px;
		background: var(--panel);
		border-bottom: 1px solid var(--border);
	}
	nav button {
		background: transparent;
		color: var(--muted);
		border: 1px solid transparent;
		padding: 6px 12px;
		border-radius: 6px;
		cursor: pointer;
		font-size: 13px;
		font-weight: 500;
	}
	nav button:hover { color: var(--text); background: var(--panel-alt); }
	nav button.active {
		color: var(--text);
		background: var(--chip);
		border-color: var(--border);
	}
	main { max-width: 1200px; margin: 0 auto; padding: 20px; }
	.tab { display: none; }
	.tab.active { display: block; }
	.card {
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 16px;
		margin-bottom: 16px;
	}
	.card h2, .card h3 { margin-top: 0; margin-bottom: 8px; }
	.grid-2 {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
		gap: 16px;
	}
	.meter {
		height: 8px;
		background: var(--chip);
		border-radius: 4px;
		overflow: hidden;
		margin: 6px 0 10px;
	}
	.meter > div { height: 100%; background: var(--accent); }
	.meter > div.over { background: var(--danger); }
	pre, textarea, input, select {
		font-family: var(--mono);
		font-size: 12.5px;
		background: #0b0f14;
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 8px 10px;
	}
	pre {
		max-height: 360px;
		overflow: auto;
		white-space: pre-wrap;
		word-break: break-word;
		margin: 8px 0 0;
	}
	textarea { width: 100%; min-height: 180px; resize: vertical; }
	input[type="text"], input[type="search"], input[type="date"], select {
		padding: 6px 10px;
	}
	.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
	.btn {
		background: var(--chip);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 6px 12px;
		cursor: pointer;
		font-size: 12.5px;
	}
	.btn:hover { border-color: var(--accent); }
	.btn.primary { background: #1f6feb; border-color: #388bfd; color: #fff; }
	.btn.danger { background: rgba(248, 81, 73, 0.15); border-color: var(--danger); color: #ff7b72; }
	.btn.ok { background: rgba(63, 185, 80, 0.15); border-color: var(--ok); color: #56d364; }
	.badge {
		display: inline-block;
		font-family: var(--mono);
		font-size: 11px;
		padding: 2px 7px;
		border-radius: 999px;
		background: var(--chip);
		border: 1px solid var(--border);
		margin-right: 4px;
		margin-bottom: 2px;
	}
	.badge.installed, .badge.caught, .badge.learned { color: #56d364; border-color: rgba(63,185,80,0.4); }
	.badge.not-installed, .badge.repeat, .badge.warning { color: #ff7b72; border-color: rgba(248,81,73,0.4); }
	.badge.trigger { color: #79c0ff; border-color: rgba(88,166,255,0.4); }
	table { width: 100%; border-collapse: collapse; margin-top: 8px; }
	th, td {
		text-align: left;
		padding: 8px 10px;
		border-bottom: 1px solid var(--border);
		vertical-align: top;
	}
	tr.clickable:hover { background: var(--panel-alt); cursor: pointer; }
	.muted { color: var(--muted); font-size: 12.5px; }
	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0,0,0,0.7);
		display: none;
		align-items: center;
		justify-content: center;
		padding: 20px;
		z-index: 50;
	}
	.modal-backdrop.open { display: flex; }
	.modal {
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 10px;
		max-width: 760px;
		width: 100%;
		max-height: 90vh;
		overflow: auto;
		padding: 20px;
	}
	.field { margin-bottom: 10px; }
	.field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
	.field input, .field select, .field textarea { width: 100%; }
	#toast {
		position: fixed;
		bottom: 18px;
		right: 18px;
		background: var(--panel-alt);
		border: 1px solid var(--accent);
		padding: 10px 14px;
		border-radius: 8px;
		display: none;
		z-index: 100;
	}
</style>
</head>
<body>
<header>
	<div>
		<h1>Grimoire</h1>
		<div class="muted" id="grimoire-dir"></div>
	</div>
	<div class="tally-pill" id="header-tally">today: 0 caught · 0 learned · 0 repeats</div>
</header>
<nav id="tabs">
	<button data-tab="agents" class="active">1. What agents get</button>
	<button data-tab="root">2. Root</button>
	<button data-tab="entries">3. Approved entries</button>
	<button data-tab="proposals">4. Proposals waiting</button>
	<button data-tab="rejected">5. Rejected</button>
	<button data-tab="log">6. Today's log</button>
	<button data-tab="projects">7. Projects</button>
</nav>
<main>
	<section id="tab-agents" class="tab active"></section>
	<section id="tab-root" class="tab"></section>
	<section id="tab-entries" class="tab"></section>
	<section id="tab-proposals" class="tab"></section>
	<section id="tab-rejected" class="tab"></section>
	<section id="tab-log" class="tab"></section>
	<section id="tab-projects" class="tab"></section>
</main>

<div id="modal-backdrop" class="modal-backdrop">
	<div id="modal" class="modal"></div>
</div>
<div id="toast"></div>

<script>
const TOKEN = ${JSON.stringify(token)};
let STATE = null;
let ENTRY_FILTER = "";
let LOG_DATE = "";
/** The project the "What agents get" preview is for: null (this session's), a project id, or "global". */
let PREVIEW = null;
let SCOPE_FILTER = "all";
const SELECTED = new Set();
let PROJECT_DRAFT = null;
let PROJECT_NOTES = [];

function esc(s) {
	return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function toast(msg) {
	const el = document.getElementById("toast");
	el.textContent = msg;
	el.style.display = "block";
	clearTimeout(el._t);
	el._t = setTimeout(() => { el.style.display = "none"; }, 3000);
}

async function api(path, method = "GET", body) {
	const sep = path.includes("?") ? "&" : "?";
	const res = await fetch(path + sep + "token=" + encodeURIComponent(TOKEN), {
		method,
		headers: body ? { "Content-Type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	});
	const data = await res.json().catch(() => ({}));
	return { status: res.status, data };
}

async function refresh() {
	const { status, data } = await api("/api/snapshot" + (PREVIEW === null ? "" : "?project=" + encodeURIComponent(PREVIEW)));
	if (status !== 200) {
		toast(data.error || "Failed to load Grimoire snapshot");
		if (PREVIEW !== null) {
			PREVIEW = null;
			await refresh();
		}
		return;
	}
	STATE = data;
	const files = new Set((data.entries || []).map(e => e.file));
	for (const f of [...SELECTED]) if (!files.has(f)) SELECTED.delete(f);
	if (!LOG_DATE) LOG_DATE = data.todayLog?.date || new Date().toISOString().slice(0, 10);
	document.getElementById("grimoire-dir").textContent = data.dir;
	const t = data.todayLog?.tally || { caught: 0, learned: 0, repeats: 0 };
	document.getElementById("header-tally").textContent =
		"today: " + t.caught + " caught · " + t.learned + " learned · " + t.repeats + " repeat" + (t.repeats === 1 ? "" : "s");
	renderAgentsTab();
	renderRootTab();
	renderEntriesTab();
	renderProposalsTab();
	renderRejectedTab();
	renderProjectsTab();
	await loadAndRenderLog(LOG_DATE);
}

document.getElementById("tabs").addEventListener("click", (e) => {
	const btn = e.target.closest("button[data-tab]");
	if (!btn) return;
	for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("active", b === btn);
	for (const s of document.querySelectorAll("main .tab")) s.classList.toggle("active", s.id === "tab-" + btn.dataset.tab);
});

function projectLabel(id) {
	const found = (STATE.projects.list || []).find(p => p.id === id);
	return found ? found.label : id + " (not in projects.json)";
}

function scopeText(e) {
	return e.scope ? e.scope.map(projectLabel).join(", ") : "Global";
}

/** Project ids to offer: the registered ones, then any an entry names that aren't registered. */
function scopeChoices(extra) {
	const ids = (STATE.projects.list || []).map(p => p.id);
	for (const id of extra || []) if (!ids.includes(id)) ids.push(id);
	return ids;
}

function sameSet(a, b) {
	return a.length === b.length && a.every(x => b.includes(x));
}

function partRow(name, p) {
	if (!p) return "";
	const badge = p.cut > 0
		? '<span class="badge repeat">' + p.cut.toLocaleString() + ' characters cut</span>'
		: '<span class="badge installed">fits</span>';
	return '<tr><td>' + esc(name) + '<div class="muted">' + esc(p.files.join(", ") || "(no files)") + '</div></td><td>' + p.chars.toLocaleString() + ' / ' + p.limit.toLocaleString() + '</td><td>' + badge + '</td></tr>';
}

function catalogueRow(name, c) {
	if (!c) return "";
	const badge = c.overflow ? "repeat" : c.titlesOnly ? "trigger" : "installed";
	return '<tr><td>' + esc(name) + '</td><td>' + c.chars.toLocaleString() + (c.limit ? ' / ' + c.limit.toLocaleString() : '') + '</td><td><span class="badge ' + badge + '">' + esc(c.note) + '</span></td></tr>';
}

function totalRow(name, chars, limit, soft) {
	const over = chars > limit;
	const text = over ? (soft ? "over the budget" : "over the limit") : "within " + (soft ? "the budget" : "the limit");
	return '<tr><td><strong>' + esc(name) + '</strong></td><td><strong>' + chars.toLocaleString() + '</strong> / ' + limit.toLocaleString() + '</td><td><span class="badge ' + (over ? 'repeat' : 'installed') + '">' + text + '</span></td></tr>';
}

function sizeTable(rows) {
	return '<table><thead><tr><th>Part</th><th>Characters</th><th></th></tr></thead><tbody>' + rows.join("") + '</tbody></table>';
}

function previewCard() {
	const s = STATE.session || {};
	const reg = STATE.projects;
	const own = s.project ? "This session: " + s.project.text : "Default: " + STATE.preview.text;
	const options = ['<option value=""' + (PREVIEW === null ? ' selected' : '') + '>' + esc(own) + '</option>']
		.concat((reg.list || []).map(p => '<option value="' + esc(p.id) + '"' + (PREVIEW === p.id ? ' selected' : '') + '>' + esc(p.label) + ' (' + esc(p.id) + ')</option>'))
		.concat(['<option value="global"' + (PREVIEW === "global" ? ' selected' : '') + '>No project: global only</option>']);
	const before = s.project && s.project.state === "off"
		? '<div class="muted">This Pi session started before projects.json had projects, so it sees every unscoped entry until it restarts. The preview shows what a session started in this folder gets now.</div>'
		: '';
	const broken = reg.error ? '<div><span class="badge repeat">projects.json can&#39;t be read</span> ' + esc(reg.error) + '. Sessions load global entries only until it&#39;s fixed.</div>' : '';
	return '<div class="card"><div class="row"><label for="preview-project"><strong>Preview for</strong></label>'
		+ '<select id="preview-project" onchange="PREVIEW = this.value || null; refresh();">' + options.join("") + '</select></div>'
		+ '<div class="muted">Previewing: ' + esc(STATE.preview.text) + '</div>' + before + broken + '</div>';
}

function linksCard() {
	const words = { "missing": "missing", "out-of-scope": "out of scope", "not-an-entry": "not an approved entry" };
	const who = STATE.preview.state === "matched" ? STATE.preview.project.label + " sessions" : "sessions with no project";
	const rows = (STATE.links || []).map(l => '<tr><td><code>' + esc(l.from) + '</code></td><td><code>' + esc(l.target) + '</code></td><td><span class="badge ' + (l.problem === 'out-of-scope' ? 'trigger' : 'repeat') + '">' + esc(words[l.problem] || l.problem) + '</span></td></tr>').join("");
	return '<div class="card"><h3>Links ' + esc(who) + ' won&#39;t follow</h3>'
		+ '<div class="muted">Links never load their target. These point at a file that is missing, isn&#39;t an approved entry, or is scoped to another project.</div>'
		+ (rows ? '<table><thead><tr><th>From</th><th>Links to</th><th>Problem</th></tr></thead><tbody>' + rows + '</tbody></table>' : '<div class="muted" style="margin-top:6px">None: every link goes to something these sessions see.</div>')
		+ '</div>';
}

function renderAgentsTab() {
	const w = STATE.whatAgentsGet;
	const inUse = STATE.projects.inUse;
	const claudeStatus = w.hooks.claudeCode.status;
	const codexStatus = w.hooks.codex.status;
	const importState = {
		current: "",
		stale: '<span class="badge warning">the file on disk is older; Claude Code rewrites it at its next session start</span>',
		missing: '<span class="badge warning">not written yet; run sitra grimoire install</span>',
	}[w.claudeCode.importOnDisk];

	let sizes;
	if (inUse) {
		const noProject = '<tr><td colspan="3" class="muted">No project, so no project root or project entries: ' + esc(STATE.preview.text) + '</td></tr>';
		sizes = \`
			<div class="grid-2">
				<div class="card">
					<h3>Pi: every prompt</h3>
					\${sizeTable([
						partRow("Global root", w.pi.globalRoot),
						w.pi.projectRoot ? partRow("Project root", w.pi.projectRoot) : noProject,
						catalogueRow("Catalogue (global + project entries)", w.pi.catalogue),
						totalRow("Whole section", w.everyPrompt.chars, w.pi.rootLimit + w.pi.catalogue.limit, true),
					])}
				</div>
				<div class="card">
					<h3>Claude Code</h3>
					\${sizeTable([
						partRow("Import: global root", w.claudeCode.importRoot),
						catalogueRow("Import: global entries", w.claudeCode.importCatalogue),
						totalRow("CLAUDE.md import (same for every project)", w.claudeCode.importChars, w.claudeCode.importLimit, true),
						w.claudeCode.projectRoot ? partRow("Session hook: project root", w.claudeCode.projectRoot) : noProject,
						catalogueRow("Session hook: project entries", w.claudeCode.catalogue),
						totalRow("Session hook", w.claudeCode.hookChars, w.claudeCode.hookLimit, false),
					])}
				</div>
				<div class="card">
					<h3>Codex: session hook</h3>
					\${sizeTable([
						partRow("Global root", w.codex.globalRoot),
						w.codex.projectRoot ? partRow("Project root", w.codex.projectRoot) : noProject,
						catalogueRow("Catalogue (global + project entries)", w.codex.catalogue),
						totalRow("Session hook", w.codex.hookChars, w.codex.hookLimit, false),
					])}
				</div>
			</div>
		\`;
	} else {
		const rootPct = Math.min(100, Math.round((w.root.chars / w.root.limit) * 100));
		const catPct = Math.min(100, Math.round((w.catalogue.chars / w.catalogue.limit) * 100));
		sizes = \`
			<div class="grid-2">
				<div class="card">
					<h3>Root size against limit</h3>
					<div><strong>\${w.root.chars.toLocaleString()}</strong> / \${w.root.limit.toLocaleString()} characters \${w.root.truncated ? '<span class="badge repeat">cut off over limit</span>' : '<span class="badge installed">fits in prompt</span>'}</div>
					<div class="meter"><div class="\${w.root.truncated ? 'over' : ''}" style="width:\${rootPct}%"></div></div>
					<div class="muted">Files loaded (README first): \${w.root.files.map(esc).join(", ") || "(none)"}</div>
				</div>
				<div class="card">
					<h3>Catalogue size against limit</h3>
					<div><strong>\${w.catalogue.chars.toLocaleString()}</strong> / \${w.catalogue.limit.toLocaleString()} characters (\${w.catalogue.totalEntries} approved entries)</div>
					<div class="meter"><div class="\${w.catalogue.chars >= w.catalogue.limit ? 'over' : ''}" style="width:\${catPct}%"></div></div>
					<div class="muted">\${esc(w.pi.catalogue.note)} · Query cap: \${STATE.limits.queryChars.toLocaleString()} characters</div>
				</div>
			</div>
		\`;
	}

	document.getElementById("tab-agents").innerHTML = \`
		\${inUse ? previewCard() : ""}
		\${sizes}

		<div class="card">
			<h2>Every prompt (exact text the lead agent receives)</h2>
			<div class="muted">\${w.everyPrompt.chars.toLocaleString()} characters total, rendered by grimoireSection(...)</div>
			<pre>\${esc(w.everyPrompt.text)}</pre>
		</div>

		<div class="grid-2">
			<div class="card">
				<h3>What Claude Code gets</h3>
				<div class="muted">Imported from CLAUDE.md (\${esc(w.claudeCode.rootFile)}, \${w.claudeCode.importChars.toLocaleString()} chars) \${importState}</div>
				<pre>\${esc(w.claudeCode.importText)}</pre>
				<div class="muted" style="margin-top:8px">SessionStart hook context (\${w.claudeCode.hookChars.toLocaleString()} / \${w.claudeCode.hookLimit.toLocaleString()} chars)\${w.claudeCode.catalogue ? ": " + esc(w.claudeCode.catalogue.note) : ""}</div>
				<pre>\${esc(w.claudeCode.hookText)}</pre>
			</div>
			<div class="card">
				<h3>What Codex gets</h3>
				<div class="muted">SessionStart hook (root + catalogue, \${w.codex.hookChars.toLocaleString()} / \${w.codex.hookLimit.toLocaleString()} chars)</div>
				<pre>\${esc(w.codex.hookText)}</pre>
			</div>
		</div>

		\${inUse ? linksCard() : ""}

		<div class="grid-2">
			<div class="card">
				<h3>Hooks</h3>
				<table>
					<tr>
						<td><strong>Claude Code</strong><div class="muted">\${esc(w.hooks.claudeCode.path)}</div></td>
						<td><span class="badge \${claudeStatus === 'installed' ? 'installed' : 'not-installed'}">\${esc(claudeStatus)}</span></td>
					</tr>
					<tr>
						<td><strong>Codex</strong><div class="muted">\${esc(w.hooks.codex.path)}</div></td>
						<td><span class="badge \${codexStatus === 'installed' ? 'installed' : 'not-installed'}">\${esc(codexStatus)}</span></td>
					</tr>
				</table>
			</div>
			<div class="card">
				<h3>Settings</h3>
				<div><strong>sitra extensions switched on:</strong></div>
				<div style="margin:6px 0 10px">\${w.settings.extensions.map(x => '<span class="badge">' + esc(x) + '</span>').join(" ")}</div>
				<table>
					<tr><td><code>SITRA_SHARPEN</code></td><td><code>\${esc(w.settings.env.SITRA_SHARPEN)}</code></td></tr>
					<tr><td><code>SITRA_GRIMOIRE_LOOK</code></td><td><code>\${esc(w.settings.env.SITRA_GRIMOIRE_LOOK)}</code></td></tr>
					<tr><td><code>learn</code> (config.json)</td><td><code>\${esc(String(w.settings.learn))}</code></td></tr>
					<tr><td><code>learnModel</code></td><td><code>\${esc(w.settings.learnModel)}</code></td></tr>
				</table>
			</div>
		</div>
	\`;
}

function renderRootTab() {
	const files = STATE.rootFiles || [];
	const cards = files.map((rf, i) => \`
		<div class="card">
			<div class="row" style="justify-content:space-between">
				<h3>\${esc(rf.file)} <span class="muted">(\${rf.chars.toLocaleString()} chars)</span></h3>
				<button class="btn primary" onclick="saveRoot(\${i})">Save \${esc(rf.name)}</button>
			</div>
			<textarea id="root-ta-\${i}">\${esc(rf.content)}</textarea>
		</div>
	\`).join("");

	document.getElementById("tab-root").innerHTML = \`
		<div class="card">
			<div class="row">
				<input type="text" id="new-root-name" placeholder="root/new-file.md" style="width:260px">
				<button class="btn" onclick="createRootFile()">Add root file</button>
			</div>
			<div class="muted">Every <code>root/*.md</code> file is always loaded into the system prompt (README.md first), capped at \${STATE.limits.rootChars.toLocaleString()} characters.</div>
		</div>
		\${cards || '<div class="card muted">No root/*.md files yet. Add root/README.md above.</div>'}
	\`;
}

async function saveRoot(index) {
	const rf = STATE.rootFiles[index];
	const content = document.getElementById("root-ta-" + index).value;
	const { status, data } = await api("/api/root", "PUT", { file: rf.file, content });
	if (status !== 200) return toast(data.error || "Failed to save root file");
	toast("Saved " + rf.file);
	await refresh();
}

async function createRootFile() {
	let name = document.getElementById("new-root-name").value.trim();
	if (!name) return;
	if (!name.startsWith("root/")) name = "root/" + name;
	if (!name.endsWith(".md")) name += ".md";
	const { status, data } = await api("/api/root", "PUT", { file: name, content: "# " + name.slice(5, -3) + "\\n" });
	if (status !== 200) return toast(data.error || "Failed to create root file");
	toast("Created " + name);
	await refresh();
}

function scopeMatches(e) {
	if (SCOPE_FILTER === "all") return true;
	if (SCOPE_FILTER === "global") return !e.scope;
	return (e.scope || []).includes(SCOPE_FILTER);
}

function filteredEntries() {
	const q = ENTRY_FILTER.trim().toLowerCase();
	const scoped = STATE.projects.inUse;
	return (STATE.entries || []).filter(e => {
		if (scoped && !scopeMatches(e)) return false;
		if (!q) return true;
		const hay = [e.title, e.summary, e.body, ...(e.tags || []), ...(e.when || []), e.file].join(" ").toLowerCase();
		return hay.includes(q);
	});
}

function toggleSelected(file, on) {
	if (on) SELECTED.add(file);
	else SELECTED.delete(file);
	renderEntriesTab();
}

function selectAllFiltered(on) {
	for (const e of filteredEntries()) {
		if (on) SELECTED.add(e.file);
		else SELECTED.delete(e.file);
	}
	renderEntriesTab();
}

async function bulkScope(global) {
	const files = [...SELECTED];
	if (files.length === 0) return toast("Select entries first");
	const picked = (STATE.projects.list || []).map(p => p.id).filter(id => document.getElementById("bulk-scope-" + id).checked);
	if (!global && picked.length === 0) return toast("Check at least one project, or use Make global");
	const { status, data } = await api("/api/scope", "POST", { files, scope: global ? null : picked });
	if (status !== 200) return toast(data.error || "Failed to set scope");
	SELECTED.clear();
	toast((global ? "Made global: " : "Scoped to " + picked.join(", ") + ": ") + data.files.length + " entries");
	await refresh();
}

function renderEntriesTab() {
	const kinds = ["warning", "decision", "lesson", "fact", "setup"];
	const scoped = STATE.projects.inUse;
	const filtered = filteredEntries();

	const groups = kinds.map(k => {
		const list = filtered.filter(e => e.kind === k);
		if (list.length === 0) return "";
		const rows = list.map(e => \`
			<tr class="clickable" onclick="openEditModal(\${ esc(JSON.stringify(e.file)) })">
				\${scoped ? '<td onclick="event.stopPropagation()"><input type="checkbox"' + (SELECTED.has(e.file) ? ' checked' : '') + ' onchange="toggleSelected(' + esc(JSON.stringify(e.file)) + ', this.checked)"></td>' : ''}
				<td><strong>\${esc(e.title)}</strong><div class="muted">\${esc(e.file)}</div></td>
				\${scoped ? '<td>' + esc(scopeText(e)) + '</td>' : ''}
				<td>\${esc(e.summary || "")}</td>
				<td>\${(e.tags || []).map(t => '<span class="badge">' + esc(t) + '</span>').join(" ")}</td>
				<td>\${(e.when || []).map(w => '<span class="badge trigger">' + esc(w) + '</span>').join(" ")}</td>
				<td onclick="event.stopPropagation()" style="white-space:nowrap">
					<select onchange="if(this.value) moveEntryUi(\${esc(JSON.stringify(e.file))}, this.value); this.value='';">
						<option value="">Move to…</option>
						\${kinds.filter(x => x !== e.kind).map(x => '<option value="' + x + '">' + x + '</option>').join("")}
					</select>
					<button class="btn danger" onclick="deleteEntryUi(\${esc(JSON.stringify(e.file))})">Delete</button>
				</td>
			</tr>
		\`).join("");
		return \`
			<div class="card">
				<h3>\${esc(k)}s (\${list.length})</h3>
				<table>
					<thead><tr>\${scoped ? '<th></th>' : ''}<th>Title</th>\${scoped ? '<th>Scope</th>' : ''}<th>Summary</th><th>Tags</th><th>When triggers</th><th>Actions</th></tr></thead>
					<tbody>\${rows}</tbody>
				</table>
			</div>
		\`;
	}).join("");

	const ids = scopeChoices((STATE.entries || []).flatMap(e => e.scope || []));
	const filter = scoped
		? '<select id="scope-filter" onchange="SCOPE_FILTER = this.value; renderEntriesTab();">'
			+ [["all", "All scopes"], ["global", "Global"]].concat(ids.map(id => [id, projectLabel(id)]))
				.map(([v, l]) => '<option value="' + esc(v) + '"' + (SCOPE_FILTER === v ? ' selected' : '') + '>' + esc(l) + '</option>').join("")
			+ '</select>'
		: '';
	const allSelected = filtered.length > 0 && filtered.every(e => SELECTED.has(e.file));
	const bulk = scoped
		? '<div class="card row">'
			+ '<label><input type="checkbox" id="select-all"' + (allSelected ? ' checked' : '') + ' onchange="selectAllFiltered(this.checked)"> Select all filtered (' + filtered.length + ')</label>'
			+ '<span class="muted">' + SELECTED.size + ' selected</span>'
			+ '<span>Set scope to:</span>'
			+ (STATE.projects.list || []).map(p => '<label><input type="checkbox" id="bulk-scope-' + esc(p.id) + '"> ' + esc(p.label) + '</label>').join(" ")
			+ '<button class="btn primary" onclick="bulkScope(false)">Set scope</button>'
			+ '<button class="btn" onclick="bulkScope(true)">Make global</button>'
			+ '</div>'
		: '';
	const hiddenScoped = scoped ? 0 : (STATE.entries || []).filter(e => e.scope).length;
	const hiddenNote = hiddenScoped
		? '<div class="card"><span class="badge warning">' + hiddenScoped + ' scoped entries</span> name projects, but projects.json has none, so no session sees them. Create projects in the Projects tab.</div>'
		: '';

	document.getElementById("tab-entries").innerHTML = \`
		<div class="card row" style="justify-content:space-between">
			<div class="row" style="margin:0">
				<input type="search" id="entry-search" placeholder="Filter entries by title, summary, tag or trigger…" value="\${esc(ENTRY_FILTER)}" oninput="ENTRY_FILTER=this.value; renderEntriesTab();" style="width:380px">
				\${filter}
			</div>
			<button class="btn primary" onclick="openAddModal()">+ Add approved entry</button>
		</div>
		\${hiddenNote}
		\${bulk}
		\${groups || '<div class="card muted">No matching approved entries.</div>'}
	\`;
	const searchInput = document.getElementById("entry-search");
	if (searchInput && document.activeElement?.id === "entry-search") {
		searchInput.focus();
		searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
	}
}

function closeModal() {
	document.getElementById("modal-backdrop").classList.remove("open");
}

function openEntryForm(title, entry, onSave) {
	const kinds = ["warning", "decision", "lesson", "fact", "setup"];
	const m = document.getElementById("modal");
	m.innerHTML = \`
		<h3>\${esc(title)}</h3>
		<div class="field"><label>Kind</label>
			<select id="f-kind">\${kinds.map(k => '<option value="' + k + '"' + (entry.kind === k ? ' selected' : '') + '>' + k + '</option>').join("")}</select>
		</div>
		<div class="field"><label>Title</label><input type="text" id="f-title" value="\${esc(entry.title || "")}"></div>
		<div class="field"><label>Summary (one plain sentence)</label><input type="text" id="f-summary" value="\${esc(entry.summary || "")}"></div>
		<div class="field"><label>Tags (comma-separated)</label><input type="text" id="f-tags" value="\${esc((entry.tags || []).join(", "))}"></div>
		<div class="field"><label>When triggers (one per line, e.g. command:gh pr create, path:src/**, tool:bash)</label>
			<textarea id="f-when" style="min-height:70px">\${esc((entry.when || []).join("\\n"))}</textarea>
		</div>
		<div class="field"><label>Links (comma-separated relative paths)</label><input type="text" id="f-links" value="\${esc((entry.links || []).join(", "))}"></div>
		\${STATE.projects.inUse ? '<div class="field"><label>Scope (check none for global)</label><div class="row">' + scopeChoices(entry.scope).map(id => '<label><input type="checkbox" id="f-scope-' + esc(id) + '"' + ((entry.scope || []).includes(id) ? ' checked' : '') + '> ' + esc(projectLabel(id)) + '</label>').join(" ") + '</div>' + (!entry.scope && entry.scopeNote ? '<div class="muted">' + esc(entry.scopeNote) + '</div>' : '') + '</div>' : ''}
		<div class="field"><label>Evidence</label><input type="text" id="f-evidence" value="\${esc(entry.evidence || "")}"></div>
		<div class="field"><label>Body</label><textarea id="f-body">\${esc(entry.body || "")}</textarea></div>
		<div class="row" style="justify-content:flex-end">
			<button class="btn" onclick="closeModal()">Cancel</button>
			<button class="btn primary" id="f-save">Save</button>
		</div>
	\`;
	document.getElementById("f-save").onclick = () => {
		const payload = {
			kind: document.getElementById("f-kind").value,
			title: document.getElementById("f-title").value,
			summary: document.getElementById("f-summary").value,
			tags: document.getElementById("f-tags").value.split(",").map(s => s.trim()).filter(Boolean),
			when: document.getElementById("f-when").value.split("\\n").map(s => s.trim()).filter(Boolean),
			links: document.getElementById("f-links").value.split(",").map(s => s.trim()).filter(Boolean),
			evidence: document.getElementById("f-evidence").value,
			body: document.getElementById("f-body").value,
		};
		if (STATE.projects.inUse) {
			const picked = scopeChoices(entry.scope).filter(id => document.getElementById("f-scope-" + id).checked);
			if (!sameSet(picked, entry.scope || [])) payload.scope = picked.length ? picked : null;
		}
		onSave(payload);
	};
	document.getElementById("modal-backdrop").classList.add("open");
}

function openAddModal() {
	openEntryForm("Add approved entry", { kind: "lesson" }, async (payload) => {
		const { status, data } = await api("/api/entries", "POST", payload);
		if (status !== 200) return toast(data.error || "Failed to add entry");
		closeModal();
		toast("Added " + data.entry.file);
		await refresh();
	});
}

function openEditModal(file) {
	const all = [...(STATE.entries || []), ...(STATE.proposals || []), ...(STATE.rejected || [])];
	const entry = all.find(e => e.file === file);
	if (!entry) return;
	openEntryForm("Edit " + file, entry, async (payload) => {
		const { status, data } = await api("/api/entries", "PUT", { ...payload, file });
		if (status !== 200) return toast(data.error || "Failed to save entry");
		closeModal();
		toast("Saved " + file);
		await refresh();
	});
}

function openBrokenLinksModal(actionTitle, brokenLinks, otherEntries, onResolve) {
	const m = document.getElementById("modal");
	const items = brokenLinks.map(b => '<li><code>' + esc(b.file) + '</code>' + (b.title ? ' — ' + esc(b.title) : '') + '</li>').join("");
	const repointPicker = otherEntries
		? \`<div class="field"><label>Repoint links to existing entry:</label>
			<select id="repoint-select">\${otherEntries.map(e => '<option value="' + esc(e.file) + '">' + esc(e.title) + ' (' + esc(e.file) + ')</option>').join("")}</select>
		</div>\`
		: "";
	m.innerHTML = \`
		<h3>Links point to this entry (\${esc(actionTitle)})</h3>
		<p>The following files in root or entries link to this file:</p>
		<ul>\${items}</ul>
		\${repointPicker}
		<div class="row" style="justify-content:flex-end">
			<button class="btn" onclick="closeModal()">Cancel</button>
			<button class="btn danger" id="btn-remove-links">Remove links</button>
			<button class="btn primary" id="btn-repoint-links">Repoint links</button>
		</div>
	\`;
	document.getElementById("btn-remove-links").onclick = () => onResolve({ onLinks: "remove" });
	document.getElementById("btn-repoint-links").onclick = () => {
		const sel = document.getElementById("repoint-select");
		onResolve({ onLinks: "repoint", ...(sel ? { repointTo: sel.value } : {}) });
	};
	document.getElementById("modal-backdrop").classList.add("open");
}

async function moveEntryUi(file, kind, linkOpts = {}) {
	const { status, data } = await api("/api/move", "POST", { file, kind, ...linkOpts });
	if (status === 409 && data.brokenLinks) {
		openBrokenLinksModal("Move to " + kind, data.brokenLinks, null, async (opts) => {
			closeModal();
			await moveEntryUi(file, kind, opts);
		});
		return;
	}
	if (status !== 200) return toast(data.error || "Move failed");
	toast("Moved to " + data.file);
	await refresh();
}

async function deleteEntryUi(file, linkOpts = {}) {
	const { status, data } = await api("/api/entries", "DELETE", { file, ...linkOpts });
	if (status === 409 && data.brokenLinks) {
		const others = (STATE.entries || []).filter(e => e.file !== file);
		openBrokenLinksModal("Delete to rejected/", data.brokenLinks, others, async (opts) => {
			closeModal();
			await deleteEntryUi(file, opts);
		});
		return;
	}
	if (status !== 200) return toast(data.error || "Delete failed");
	toast("Moved to " + data.file);
	await refresh();
}

function renderProposalsTab() {
	const kinds = ["warning", "decision", "lesson", "fact", "setup"];
	const list = STATE.proposals || [];
	const cards = list.map((p, i) => \`
		<div class="card">
			<div class="row" style="justify-content:space-between">
				<div>
					<span class="badge">\${esc(p.kind)}</span>
					<strong>\${esc(p.title)}</strong>
					<span class="muted">(\${esc(p.file)})</span>
				</div>
				<div class="row" style="margin:0">
					<select id="prop-kind-\${i}">
						\${kinds.map(k => '<option value="' + k + '"' + (k === p.kind ? ' selected' : '') + '>Accept as ' + k + '</option>').join("")}
					</select>
					<button class="btn ok" onclick="acceptProp(\${i}, document.getElementById('prop-kind-\${i}').value)">Accept</button>
					<button class="btn" onclick="openEditModal(\${esc(JSON.stringify(p.file))})">Edit</button>
					<button class="btn danger" onclick="rejectProp(\${esc(JSON.stringify(p.file))})">Reject</button>
				</div>
			</div>
			\${STATE.projects.inUse ? proposalScope(p, i) : ''}
			\${p.summary ? '<div>' + esc(p.summary) + '</div>' : ''}
			<div>\${(p.when || []).map(w => '<span class="badge trigger">' + esc(w) + '</span>').join(" ")}</div>
			<pre>\${esc(p.body)}</pre>
			\${p.evidence ? '<div class="muted" style="margin-top:6px">Evidence: ' + esc(p.evidence) + '</div>' : ''}
		</div>
	\`).join("");

	document.getElementById("tab-proposals").innerHTML = cards || '<div class="card muted">No proposals waiting for review.</div>';
}

function proposalScope(p, i) {
	const note = !p.scope && p.scopeNote ? ' <span class="muted">(' + esc(p.scopeNote) + ')</span>' : '';
	const boxes = scopeChoices(p.scope).map(id => '<label><input type="checkbox" id="prop-scope-' + i + '-' + esc(id) + '"' + ((p.scope || []).includes(id) ? ' checked' : '') + '> ' + esc(projectLabel(id)) + '</label>').join(" ");
	return '<div class="row" style="margin:6px 0"><span><strong>Scope: ' + esc(scopeText(p)) + '</strong>' + note + '</span><span class="muted">Accept with scope (none checked = global):</span>' + boxes + '</div>';
}

async function acceptProp(i, kind) {
	const p = STATE.proposals[i];
	const file = p.file;
	const body = { file, kind };
	if (STATE.projects.inUse) {
		const picked = scopeChoices(p.scope).filter(id => document.getElementById("prop-scope-" + i + "-" + id).checked);
		if (!sameSet(picked, p.scope || [])) body.scope = picked.length ? picked : null;
	}
	const { status, data } = await api("/api/accept", "POST", body);
	if (status !== 200) return toast(data.error || "Accept failed");
	toast("Accepted → " + data.entry.file);
	await refresh();
}

async function rejectProp(file) {
	const { status, data } = await api("/api/reject", "POST", { file });
	if (status !== 200) return toast(data.error || "Reject failed");
	toast("Rejected → " + data.file);
	await refresh();
}

function renderRejectedTab() {
	const list = STATE.rejected || [];
	const rows = list.map(r => \`
		<tr>
			<td><span class="badge">\${esc(r.kind)}</span> <strong>\${esc(r.title)}</strong><div class="muted">\${esc(r.file)}</div></td>
			<td>\${esc(r.summary || "")}</td>
			<td><button class="btn ok" onclick="restoreEntry(\${esc(JSON.stringify(r.file))})">Restore to kinds/</button></td>
		</tr>
	\`).join("");
	document.getElementById("tab-rejected").innerHTML = list.length
		? \`<div class="card"><table><thead><tr><th>Rejected entry</th><th>Summary</th><th>Action</th></tr></thead><tbody>\${rows}</tbody></table></div>\`
		: '<div class="card muted">No rejected entries.</div>';
}

async function restoreEntry(file) {
	const { status, data } = await api("/api/restore", "POST", { file });
	if (status !== 200) return toast(data.error || "Restore failed");
	toast("Restored → " + data.entry.file);
	await refresh();
}

function projectDraft() {
	if (!PROJECT_DRAFT) PROJECT_DRAFT = JSON.parse(JSON.stringify(STATE.projects.list || []));
	return PROJECT_DRAFT;
}

function removeRemote(i, j) {
	projectDraft()[i].remotes.splice(j, 1);
	renderProjectsTab();
}

function removePath(i, j) {
	projectDraft()[i].paths.splice(j, 1);
	renderProjectsTab();
}

function removeProject(i) {
	projectDraft().splice(i, 1);
	renderProjectsTab();
}

function attachRemotes(i) {
	const p = projectDraft()[i];
	for (const r of STATE.session.remotes || []) if (!p.remotes.includes(r.key)) p.remotes.push(r.key);
	renderProjectsTab();
}

async function addRemote(i) {
	const url = document.getElementById("pj-remote-" + i).value.trim();
	if (!url) return;
	const { status, data } = await api("/api/projects/remote-key", "POST", { url });
	if (status !== 200) return toast(data.error || "Not a remote URL");
	const p = projectDraft()[i];
	if (!p.remotes.includes(data.key)) p.remotes.push(data.key);
	renderProjectsTab();
}

function addPath(i) {
	const path = document.getElementById("pj-path-" + i).value.trim();
	if (!path) return;
	const p = projectDraft()[i];
	if (!p.paths.includes(path)) p.paths.push(path);
	renderProjectsTab();
}

function addProject() {
	const id = document.getElementById("new-project-id").value.trim();
	const label = document.getElementById("new-project-label").value.trim();
	if (!id) return toast("Give the project an id, like demo-app");
	projectDraft().push({ id, label: label || id, remotes: [], paths: [] });
	renderProjectsTab();
}

async function saveProjects(list) {
	const { status, data } = await api("/api/projects", "PUT", { projects: list || projectDraft() });
	if (status !== 200) return toast(data.error || "Failed to save projects.json");
	PROJECT_DRAFT = null;
	PROJECT_NOTES = data.warnings || [];
	toast("Saved " + data.file + ". Sessions started from now on use it.");
	await refresh();
}

async function createRegistry() {
	const id = document.getElementById("new-project-id").value.trim();
	const label = document.getElementById("new-project-label").value.trim();
	if (!id) return toast("Give the project an id, like demo-app");
	const attach = document.getElementById("new-project-attach");
	const remotes = attach && attach.checked ? (STATE.session.remotes || []).map(r => r.key) : [];
	await saveProjects([{ id, label: label || id, remotes, paths: [] }]);
}

function renderProjectsTab() {
	const el = document.getElementById("tab-projects");
	const reg = STATE.projects;
	const s = STATE.session || {};
	if (reg.error) {
		el.innerHTML = '<div class="card"><h3>projects.json can&#39;t be read</h3><div>' + esc(reg.error) + '</div><div class="muted">Fix or remove ' + esc(reg.file) + '; this page won&#39;t overwrite it. Until then every session loads global entries only.</div></div>';
		return;
	}
	const list = PROJECT_DRAFT || reg.list || [];
	const remotes = s.remotes || [];
	const here = remotes.length
		? remotes.map(r => '<code>' + esc(r.name) + '</code> ' + esc(r.key)).join(", ")
		: esc(s.remotesWhy || "no remotes");
	const notes = PROJECT_NOTES.map(n => '<div><span class="badge warning">warning</span> ' + esc(n) + '</div>').join("");
	const checkout = '<div class="card"><h3>Attach this checkout&#39;s remotes</h3>'
		+ '<div class="muted">' + esc(s.checkout || s.cwd || "(no folder)") + ': ' + here + '</div>'
		+ (remotes.length && list.length ? '<div class="row" style="margin-top:8px">' + list.map((p, i) => '<button class="btn" onclick="attachRemotes(' + i + ')">Attach to ' + esc(p.label) + '</button>').join(" ") + '</div>' : '')
		+ '</div>';
	const newFields = '<input type="text" id="new-project-id" placeholder="id, like demo-app" style="width:180px">'
		+ '<input type="text" id="new-project-label" placeholder="Label, like Demo app" style="width:220px">';

	if (list.length === 0 && !PROJECT_DRAFT) {
		el.innerHTML = '<div class="card"><h3>No projects yet</h3>'
			+ '<p class="muted">Every entry and root file is global, as before projects. A project holds entries and root files that apply only in some repositories; a session finds its project from its checkout&#39;s git remotes, once, when it starts.</p>'
			+ '<div class="row">' + newFields
			+ (remotes.length ? '<label><input type="checkbox" id="new-project-attach" checked> attach this checkout&#39;s remotes (' + esc(remotes.map(r => r.key).join(", ")) + ')</label>' : '<span class="muted">This folder has no remotes to attach: ' + esc(s.remotesWhy || "") + '</span>')
			+ '<button class="btn primary" onclick="createRegistry()">Create projects.json</button></div>'
			+ '<div class="muted">Saved to ' + esc(reg.file) + '.</div></div>';
		return;
	}

	const cards = list.map((p, i) => '<div class="card">'
		+ '<div class="row" style="justify-content:space-between"><h3>' + esc(p.id) + '</h3><button class="btn danger" onclick="removeProject(' + i + ')">Remove project</button></div>'
		+ '<div class="field"><label>Label</label><input type="text" id="pj-label-' + i + '" value="' + esc(p.label) + '" oninput="projectDraft()[' + i + '].label = this.value"></div>'
		+ '<div class="field"><label>Remotes (a session is in this project when one of its checkout&#39;s remotes is listed)</label>'
		+ (p.remotes.map((r, j) => '<div class="row" style="margin:0 0 4px"><code>' + esc(r) + '</code><button class="btn" onclick="removeRemote(' + i + ', ' + j + ')">Remove</button></div>').join("") || '<div class="muted">none</div>')
		+ '<div class="row"><input type="text" id="pj-remote-' + i + '" placeholder="Remote URL, like git@github.com:example/app.git" style="width:380px"><button class="btn" onclick="addRemote(' + i + ')">Add remote</button></div></div>'
		+ '<div class="field"><label>Paths (only for folders without a git remote; stored as the real path)</label>'
		+ (p.paths.map((f, j) => '<div class="row" style="margin:0 0 4px"><code>' + esc(f) + '</code><button class="btn" onclick="removePath(' + i + ', ' + j + ')">Remove</button></div>').join("") || '<div class="muted">none</div>')
		+ '<div class="row"><input type="text" id="pj-path-' + i + '" placeholder="Absolute folder path" style="width:380px"><button class="btn" onclick="addPath(' + i + ')">Add path</button></div></div>'
		+ '</div>').join("");

	el.innerHTML = notes + checkout + cards
		+ '<div class="card row">' + newFields + '<button class="btn" onclick="addProject()">Add project</button></div>'
		+ '<div class="card row"><button class="btn primary" onclick="saveProjects()">Save projects.json</button>'
		+ (PROJECT_DRAFT ? '<span class="badge warning">unsaved changes</span>' : '')
		+ '<span class="muted">' + esc(reg.file) + ' · sessions already running keep the project they started with</span></div>';
}

async function loadAndRenderLog(date) {
	LOG_DATE = date;
	const { status, data: log } = await api("/api/log?date=" + encodeURIComponent(date));
	if (status !== 200) return;

	const pausesHtml = (log.pauses || []).map(p => \`
		<tr>
			<td class="muted">\${esc(p.at)}</td>
			<td><code>\${esc(p.session)}</code><div class="muted">\${esc(p.repo)}</div></td>
			<td>\${(p.entries || []).map(e => '<div><strong>' + esc(e.title) + '</strong> <span class="muted">(' + esc(e.file) + ')</span></div>').join("")}</td>
			<td>
				<div>\${(p.when || []).map(w => '<span class="badge trigger">' + esc(w) + '</span>').join(" ")}</div>
				<div class="muted"><code>\${esc(p.action?.summary || "")}</code></div>
			</td>
			<td><span class="badge \${p.outcome === 'caught' ? 'caught' : 'repeat'}">\${esc(p.outcome)}</span></td>
		</tr>
	\`).join("");

	const correctionsHtml = (log.corrections || []).map(c => {
		let whatHappened = '<span class="muted">not a correction</span>';
		if (c.outcome === "learned") {
			whatHappened = \`<span class="badge learned">proposal drafted</span> <a href="#" onclick="openEditModal(\${esc(JSON.stringify(c.proposal))}); return false;" style="color:var(--accent)">\${esc(c.proposal)}</a>\`;
		} else if (c.outcome === "repeat") {
			whatHappened = \`<span class="badge repeat">repeat</span> \${esc(c.covered || "")}\`;
		}
		return \`
			<tr>
				<td class="muted">\${esc(c.at)}<div class="muted">\${esc(c.harness)} · \${esc(c.cwd)}</div></td>
				<td>\${esc(c.message)}</td>
				<td><span class="badge \${c.verdict === 'correction' ? 'warning' : ''}">\${esc(c.verdict)}</span></td>
				<td>\${whatHappened}</td>
			</tr>
		\`;
	}).join("");

	const repeatsHtml = (log.repeats || []).map(r => \`
		<tr>
			<td class="muted">\${esc(r.at)}</td>
			<td>\${esc(r.message)}</td>
			<td><span class="badge repeat">\${esc(r.rule)}</span></td>
		</tr>
	\`).join("");

	document.getElementById("tab-log").innerHTML = \`
		<div class="card row" style="justify-content:space-between">
			<div class="row" style="margin:0">
				<label for="log-date"><strong>Date:</strong></label>
				<input type="date" id="log-date" value="\${esc(log.date)}" onchange="loadAndRenderLog(this.value)">
			</div>
			<div class="tally-pill">
				\${esc(log.date)}: \${log.tally.caught} caught · \${log.tally.learned} learned · \${log.tally.repeats} repeat\${log.tally.repeats === 1 ? "" : "s"}
			</div>
		</div>

		<div class="card">
			<h3>Pauses (\${(log.pauses || []).length})</h3>
			\${pausesHtml ? \`<table><thead><tr><th>When</th><th>Session &amp; Repo</th><th>Entries shown</th><th>Trigger &amp; Action</th><th>Outcome</th></tr></thead><tbody>\${pausesHtml}</tbody></table>\` : '<div class="muted">No pauses recorded on this date.</div>'}
		</div>

		<div class="card">
			<h3>Corrections recorded (\${(log.corrections || []).length})</h3>
			\${correctionsHtml ? \`<table><thead><tr><th>When</th><th>Words</th><th>Verdict</th><th>What happened</th></tr></thead><tbody>\${correctionsHtml}</tbody></table>\` : '<div class="muted">No moments recorded on this date.</div>'}
		</div>

		<div class="card">
			<h3>Repeats: rules broken again (\${(log.repeats || []).length})</h3>
			\${repeatsHtml ? \`<table><thead><tr><th>When</th><th>Words</th><th>Rule broken again</th></tr></thead><tbody>\${repeatsHtml}</tbody></table>\` : '<div class="muted">No repeat rule breaks on this date.</div>'}
		</div>
	\`;
}

refresh();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------------------------------------------------
// HTTP server (`127.0.0.1` only, token required on every request, strict `Host: 127.0.0.1:<port>` check, 30-min idle)
// ---------------------------------------------------------------------------------------------------------------------

const DEFAULT_IDLE_MS = 30 * 60_000;

function validToken(given: string | null, expected: string): boolean {
	if (!given) return false;
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: http.IncomingMessage, maxBytes = 1_000_000): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		let raw = "";
		req.on("data", (chunk: Buffer) => {
			raw += chunk.toString("utf8");
			if (raw.length > maxBytes) {
				reject(new Error("Request body too large."));
				req.destroy();
			}
		});
		req.on("end", () => {
			if (!raw.trim()) return resolve({});
			try {
				const parsed: unknown = JSON.parse(raw);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
					return reject(new Error("Body must be a JSON object."));
				}
				resolve(parsed as Record<string, unknown>);
			} catch {
				reject(new Error("Invalid JSON body."));
			}
		});
		req.on("error", reject);
	});
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
	const text = JSON.stringify(payload);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
	});
	res.end(text);
}

export async function startGrimoireServer(options: {
	dir: string;
	env?: Record<string, string | undefined>;
	token?: string;
	idleMs?: number;
	/** The folder of the session that opened the page, for its remotes and the default preview. */
	cwd?: string;
	/** That session's project, found when it started. */
	project?: SessionProject;
}): Promise<GrimoireServer> {
	const dir = options.dir;
	const env = options.env ?? process.env;
	const session: SnapshotSession = {
		...(options.cwd ? { cwd: options.cwd } : {}),
		...(options.project ? { project: options.project } : {}),
	};

	/**
	 * The preview the page asks for: `?project=<id>`, `?project=global` (no project; `global` is never a project id),
	 * or, with neither, the session's project. A session that started before any project existed previews what a
	 * session started in its folder gets now; the page says so.
	 */
	const previewFor = (asked: string | null): SessionProject => {
		if (asked === "global") return { state: "global", why: "chosen on this page: no project, global only" };
		if (asked !== null) {
			const found = readProjects(dir).projects.find((p) => p.id === asked);
			if (!found) throw new Error(`No project ${JSON.stringify(asked)} in ${join(dir, PROJECTS_FILE)}.`);
			return { state: "matched", project: found, via: "picker", warnings: [] };
		}
		const own = options.project;
		if (own && !(own.state === "off" && projectsOn(dir))) return own;
		if (options.cwd) return sessionProject(options.cwd, dir).project;
		return projectsOn(dir)
			? { state: "global", why: "/grimoire-ui wasn't given a folder, so no project is chosen" }
			: { state: "off" };
	};
	const token = options.token ?? randomBytes(24).toString("hex");
	const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;

	let port = 0;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;

	const resetIdle = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			server.close();
			server.closeAllConnections?.();
		}, idleMs);
		idleTimer.unref?.();
	};

	const server = http.createServer(async (req, res) => {
		try {
			const host = req.headers.host;
			if (host !== `127.0.0.1:${port}`) {
				sendJson(res, 403, { error: "Forbidden Host header." });
				return;
			}
			const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
			const givenToken = url.searchParams.get("token") ?? (req.headers["x-sitra-token"] as string | undefined) ?? null;
			if (!validToken(givenToken, token)) {
				sendJson(res, 401, { error: "Missing or invalid token." });
				return;
			}
			resetIdle();

			const method = req.method ?? "GET";
			const path = url.pathname;

			if (method === "GET" && path === "/") {
				const html = renderPage(token);
				res.writeHead(200, {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
				});
				res.end(html);
				return;
			}

			if (method === "GET" && path === "/api/snapshot") {
				sendJson(res, 200, snapshot(dir, env, previewFor(url.searchParams.get("project")), session));
				return;
			}

			if (method === "POST" && path === "/api/scope") {
				const body = await readBody(req);
				sendJson(res, 200, { files: scopeEntries(dir, body.files, body.scope) });
				return;
			}

			if (method === "GET" && path === "/api/projects") {
				const registry = registryView(dir);
				sendJson(res, 200, {
					file: registry.file,
					projects: registry.list,
					...(registry.error ? { error: registry.error } : {}),
					session: sessionView(dir, session),
				});
				return;
			}

			if (method === "PUT" && path === "/api/projects") {
				const body = await readBody(req);
				sendJson(res, 200, { file: join(dir, PROJECTS_FILE), ...saveProjects(dir, body) });
				return;
			}

			if (method === "POST" && path === "/api/projects/remote-key") {
				const body = await readBody(req);
				sendJson(res, 200, { key: normalizeRemote(String(body.url ?? ""), options.cwd) });
				return;
			}

			if (method === "GET" && path === "/api/log") {
				const date = url.searchParams.get("date") ?? undefined;
				sendJson(res, 200, dayLog(dir, date));
				return;
			}

			if (method === "PUT" && path === "/api/root") {
				const body = await readBody(req);
				const saved = saveRootFile(dir, String(body.file ?? ""), String(body.content ?? ""));
				sendJson(res, 200, saved);
				return;
			}

			if (method === "POST" && path === "/api/entries") {
				const body = await readBody(req);
				const entry = addEntry(dir, {
					kind: body.kind as Kind,
					title: String(body.title ?? ""),
					summary: typeof body.summary === "string" ? body.summary : undefined,
					body: String(body.body ?? ""),
					date: typeof body.date === "string" ? body.date : undefined,
					evidence: typeof body.evidence === "string" ? body.evidence : undefined,
					proposedBy: typeof body.proposedBy === "string" ? body.proposedBy : undefined,
					tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
					links: Array.isArray(body.links) ? (body.links as string[]) : undefined,
					when: Array.isArray(body.when) ? (body.when as string[]) : undefined,
					scope: body.scope as EntryInput["scope"],
				});
				sendJson(res, 200, { file: entry.file, entry });
				return;
			}

			if (method === "PUT" && path === "/api/entries") {
				const body = await readBody(req);
				const entry = updateEntry(dir, String(body.file ?? ""), {
					kind: typeof body.kind === "string" ? (body.kind as Kind) : undefined,
					title: typeof body.title === "string" ? body.title : undefined,
					summary: typeof body.summary === "string" ? body.summary : undefined,
					body: typeof body.body === "string" ? body.body : undefined,
					date: typeof body.date === "string" ? body.date : undefined,
					evidence: typeof body.evidence === "string" ? body.evidence : undefined,
					proposedBy: typeof body.proposedBy === "string" ? body.proposedBy : undefined,
					tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
					links: Array.isArray(body.links) ? (body.links as string[]) : undefined,
					when: Array.isArray(body.when) ? (body.when as string[]) : undefined,
					scope: body.scope as EntryInput["scope"],
				});
				sendJson(res, 200, { file: entry.file, entry });
				return;
			}

			if (method === "DELETE" && path === "/api/entries") {
				const body = await readBody(req);
				const result = deleteEntry(dir, String(body.file ?? ""), {
					onLinks: body.onLinks as LinkActionOptions["onLinks"],
					repointTo: typeof body.repointTo === "string" ? body.repointTo : undefined,
				});
				if (result.brokenLinks) {
					sendJson(res, 409, { error: "Links point to this entry.", brokenLinks: result.brokenLinks });
					return;
				}
				sendJson(res, 200, result);
				return;
			}

			if (method === "POST" && path === "/api/move") {
				const body = await readBody(req);
				const result = moveEntry(dir, String(body.file ?? ""), body.kind as Kind, {
					onLinks: body.onLinks as LinkActionOptions["onLinks"],
					repointTo: typeof body.repointTo === "string" ? body.repointTo : undefined,
				});
				if (result.brokenLinks) {
					sendJson(res, 409, { error: "Links point to this entry.", brokenLinks: result.brokenLinks });
					return;
				}
				sendJson(res, 200, result);
				return;
			}

			if (method === "POST" && path === "/api/accept") {
				const body = await readBody(req);
				const entry = acceptProposal(
					dir,
					String(body.file ?? ""),
					typeof body.kind === "string" ? (body.kind as Kind) : undefined,
					body.scope as EntryInput["scope"],
				);
				sendJson(res, 200, { file: entry.file, entry });
				return;
			}

			if (method === "POST" && path === "/api/reject") {
				const body = await readBody(req);
				const result = rejectProposal(dir, String(body.file ?? ""));
				sendJson(res, 200, result);
				return;
			}

			if (method === "POST" && path === "/api/restore") {
				const body = await readBody(req);
				const entry = restoreRejected(
					dir,
					String(body.file ?? ""),
					typeof body.kind === "string" ? (body.kind as Kind) : undefined,
				);
				sendJson(res, 200, { file: entry.file, entry });
				return;
			}

			sendJson(res, 404, { error: "Not found." });
		} catch (err) {
			sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") {
				reject(new Error("Failed to bind to 127.0.0.1"));
				return;
			}
			port = addr.port;
			resetIdle();
			resolve();
		});
	});

	const close = () =>
		new Promise<void>((resolve) => {
			if (idleTimer) clearTimeout(idleTimer);
			server.closeAllConnections?.();
			server.close(() => resolve());
		});

	return {
		url: `http://127.0.0.1:${port}/?token=${token}`,
		port,
		token,
		close,
	};
}
