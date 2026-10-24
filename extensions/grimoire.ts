/**
 * Grimoire: one approved store per person, shared by every agent they run. Plain markdown in `root/` (always loaded),
 * `kinds/` (approved entries, pulled in by relevance), `proposals/` (agents write only here) and `rejected/`. An entry
 * or root file is global unless its `scope` names projects (`projects.json`, see project.ts); a session sees global
 * plus its own project's (`entriesFor`). No Pi imports: the Pi extension, the CLI and the hooks all build on this file.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { shellQuote } from "./runs.ts";

/** What an entry is. `setup` entries are about the agent setup itself (extensions, config, prompts). */
export const KINDS = ["lesson", "fact", "decision", "warning", "setup"] as const;
export type Kind = (typeof KINDS)[number];

export interface Entry {
	kind: Kind;
	title: string;
	body: string;
	date: string;
	evidence?: string;
	proposedBy?: string;
	/** One plain sentence: what to do and when. */
	summary?: string;
	tags?: string[];
	/** Related entries, as paths from the Grimoire folder. */
	links?: string[];
	/** Actions that bring this entry in front of the agent: `command:<words>`, `path:<glob>` or `tool:<name>`. */
	when?: string[];
	/** Project ids this entry belongs to. No scope means global. */
	scope?: string[];
	/** Why a proposal ended up global when it was meant for a project, shown at review. */
	scopeNote?: string;
	/** Path from the Grimoire folder, e.g. `kinds/lessons/2026-10-08-read-evals.md`. */
	file: string;
	/** Frontmatter lines whose key sitra doesn't know, verbatim and in order, so a rewrite never drops them. */
	extra?: { key: string; raw: string }[];
}

export interface RootText {
	text: string;
	files: string[];
	/** Size of the whole root before any cap. */
	chars: number;
	/** Characters of it left out by the cap (0 when it fits). */
	cut: number;
	truncated: boolean;
}

/** The root as loaded for one project: the global part, the project's part, and both together. */
export interface Root extends RootText {
	global: RootText;
	project: RootText;
	/** Root files left out because their frontmatter can't be read, each with why. */
	problems: { file: string; problem: string }[];
}

/** Which project a prompt is for: a project, or no project and why. */
export type SectionScope = { project: { id: string; label: string } } | { project?: undefined; why: string };

export type GrimoireStoreStatus =
	| { state: "ok"; dir: string }
	| { state: "missing"; dir: string; reason: string }
	| { state: "unreadable"; dir: string; reason: string };

/** Sizes that keep the brain from crowding out the work. */
export const LIMITS = {
	rootChars: 32_000,
	globalRootChars: 26_000,
	projectRootChars: 6_000,
	catalogueChars: 12_000,
	queryChars: 4_000,
};

/** Where the Grimoire lives: `$SITRA_GRIMOIRE`, else `grimoire/` in the Pi profile, else in `~/.sitra/profile`. */
export function grimoireDir(env: Record<string, string | undefined>, home = homedir()): string {
	if (env.SITRA_GRIMOIRE?.trim()) return env.SITRA_GRIMOIRE.trim();
	if (env.PI_CODING_AGENT_DIR?.trim()) return join(env.PI_CODING_AGENT_DIR.trim(), "grimoire");
	return join(env.SITRA_HOME?.trim() || join(home, ".sitra"), "profile", "grimoire");
}

export function grimoireStoreStatus(dir: string): GrimoireStoreStatus {
	const problem = readableDir(dir, "Grimoire");
	if (problem === "missing") return { state: "missing", dir, reason: `${dir} does not exist` };
	if (problem) return { state: "unreadable", dir, reason: problem };
	return { state: "ok", dir };
}

function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readableDir(dir: string, label: string): string | "missing" | undefined {
	try {
		const stat = statSync(dir);
		if (!stat.isDirectory()) return `${label} is not a directory: ${dir}`;
		readdirSync(dir);
		return undefined;
	} catch (error) {
		const code = typeof error === "object" && error ? (error as { code?: unknown }).code : undefined;
		return code === "ENOENT" ? "missing" : `${label} can't be read: ${reason(error)}`;
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Entry format: sitra-kb-v1 frontmatter (one `key: value` per line, JSON-style values) plus summary, tags and links.
// ---------------------------------------------------------------------------------------------------------------------

export function slug(title: string): string {
	return (
		title
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60)
			.replace(/-+$/g, "") || "entry"
	);
}

const FIELDS = [
	"kind",
	"title",
	"date",
	"proposedBy",
	"evidence",
	"summary",
	"tags",
	"links",
	"when",
	"scope",
	"scopeNote",
] as const;

export function renderEntry(entry: Omit<Entry, "file">): string {
	const lines = ["---"];
	for (const key of FIELDS) {
		const value = entry[key];
		if (value === undefined || (Array.isArray(value) && value.length === 0)) continue;
		lines.push(`${key}: ${JSON.stringify(value)}`);
	}
	for (const { raw } of entry.extra ?? []) lines.push(raw);
	lines.push("---", "", entry.body.trim(), "");
	return lines.join("\n");
}

function splitFrontmatter(raw: string): { meta: string; body: string } | undefined {
	const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw.replace(/\r\n/g, "\n"));
	return match ? { meta: match[1] ?? "", body: match[2] ?? "" } : undefined;
}

function list(value: unknown): string[] | undefined {
	const items = Array.isArray(value)
		? value.filter((v): v is string => typeof v === "string")
		: typeof value === "string"
			? value.split(",")
			: [];
	const clean = items.map((v) => v.trim()).filter(Boolean);
	return clean.length > 0 ? clean : undefined;
}

/** A project id: a lowercase slug, and never `global` (no scope already means global). */
export function isProjectId(id: unknown): id is string {
	return typeof id === "string" && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id) && id !== "global";
}

/** One `key: value` per line; JSON-style values are parsed, others kept as text. Unknown keys are kept verbatim. */
function readMeta(text: string): { meta: Record<string, unknown>; extra: { key: string; raw: string }[] } {
	const meta: Record<string, unknown> = {};
	const extra: { key: string; raw: string }[] = [];
	for (const line of text.split("\n")) {
		const kv = /^(\w+):\s*(.*)$/.exec(line);
		if (!kv?.[1]) continue;
		if (!(FIELDS as readonly string[]).includes(kv[1])) extra.push({ key: kv[1], raw: line });
		const value = (kv[2] ?? "").trim();
		try {
			meta[kv[1]] = value.startsWith('"') || value.startsWith("[") ? JSON.parse(value) : value;
		} catch {
			meta[kv[1]] = value;
		}
	}
	return { meta, extra };
}

/** The `scope` frontmatter value: absent is global; anything but a non-empty list of project ids is refused. */
function readScope(meta: Record<string, unknown>): { scope?: string[]; problem?: string } {
	if (!("scope" in meta)) return {};
	const value = meta.scope;
	if (!Array.isArray(value))
		return { problem: `scope must be a JSON list of project ids, like ["app"], not ${JSON.stringify(value)}` };
	if (value.length === 0) return { problem: "scope is an empty list; remove the scope line to make it global" };
	const bad = value.find((id) => !isProjectId(id));
	if (bad === "global") return { problem: 'scope can\'t name "global"; remove the scope line to make it global' };
	if (bad !== undefined) return { problem: `scope item ${JSON.stringify(bad)} isn't a project id (a lowercase slug)` };
	return { scope: [...new Set(value as string[])] };
}

/** The entry, or why the file isn't one (no frontmatter, unknown kind, no title or date, an unreadable scope). */
export function readEntry(
	raw: string,
	file: string,
): { entry: Entry; problem?: undefined } | { entry?: undefined; problem: string } {
	const parts = splitFrontmatter(raw);
	if (!parts) return { problem: "no frontmatter between --- lines" };
	const { meta, extra } = readMeta(parts.meta);
	const str = (k: string) => (typeof meta[k] === "string" && meta[k] ? (meta[k] as string) : undefined);
	const kind = str("kind");
	const title = str("title");
	const date = str("date");
	if (!KINDS.includes(kind as Kind))
		return { problem: `kind ${JSON.stringify(kind)} isn't one of ${KINDS.join(", ")}` };
	if (!title) return { problem: "no title" };
	if (!date) return { problem: "no date" };
	const { scope, problem } = readScope(meta);
	if (problem) return { problem };
	const evidence = str("evidence");
	const proposedBy = str("proposedBy");
	const summary = str("summary");
	const scopeNote = str("scopeNote");
	const tags = list(meta.tags);
	const links = list(meta.links);
	const when = list(meta.when);
	return {
		entry: {
			kind: kind as Kind,
			title,
			body: parts.body.trim(),
			date,
			...(evidence ? { evidence } : {}),
			...(proposedBy ? { proposedBy } : {}),
			...(summary ? { summary } : {}),
			...(tags ? { tags } : {}),
			...(links ? { links } : {}),
			...(when ? { when } : {}),
			...(scope ? { scope } : {}),
			...(scopeNote ? { scopeNote } : {}),
			...(extra.length > 0 ? { extra } : {}),
			file,
		},
	};
}

export function parseEntry(raw: string, file: string): Entry | undefined {
	return readEntry(raw, file).entry;
}

/** The entries a project sees: every global (unscoped) entry, plus those scoped to the project. */
export function entriesFor(entries: readonly Entry[], projectId: string | undefined): Entry[] {
	return entries.filter((e) => !e.scope || (projectId !== undefined && e.scope.includes(projectId)));
}

/**
 * The entry with a new scope (`undefined`: global), dropping any note on why it was proposed as global: the person
 * has now chosen. An invalid scope throws, naming the file.
 */
function withScope<T extends Omit<Entry, "file">>(entry: T, scope: readonly string[] | undefined, file: string): T {
	const { scope: _old, scopeNote: _note, ...rest } = entry;
	if (scope === undefined) return rest as T;
	const checked = readScope({ scope });
	if (checked.problem) throw new Error(`${file}: ${checked.problem}`);
	return { ...rest, scope: checked.scope } as T;
}

// ---------------------------------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------------------------------

function markdownFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.sort();
}

function unreadable(dir: string, error: unknown): GrimoireStoreStatus {
	return { state: "unreadable", dir, reason: reason(error) };
}

function readEntries(root: string, rel: string, strict = false): Entry[] {
	return markdownFiles(join(root, rel)).flatMap((f) => {
		try {
			const entry = parseEntry(readFileSync(join(root, rel, f), "utf8"), `${rel}/${f}`);
			return entry ? [entry] : [];
		} catch (error) {
			if (strict) throw error;
			return []; // one unreadable file never hides the rest
		}
	});
}

/** Approved entries, from `kinds/<kind>s/`. */
export function listEntries(dir: string): Entry[] {
	return KINDS.flatMap((kind) => readEntries(dir, `kinds/${kind}s`));
}

export function listEntriesWithStatus(dir: string): { status: GrimoireStoreStatus; entries: Entry[] } {
	const status = grimoireStoreStatus(dir);
	if (status.state === "missing") return { status, entries: [] };
	if (status.state === "unreadable") return { status, entries: [] };
	try {
		return {
			status,
			entries: KINDS.flatMap((kind) => readEntries(dir, `kinds/${kind}s`, true)),
		};
	} catch (error) {
		return { status: unreadable(dir, error), entries: [] };
	}
}

export function listProposals(dir: string): Entry[] {
	return readEntries(dir, "proposals");
}

export function listRejected(dir: string): Entry[] {
	return readEntries(dir, "rejected");
}

/** Proposal files that aren't valid entries (unknown kind, no frontmatter), so a review can say so instead of hiding them. */
export function unreadableProposals(dir: string): string[] {
	return unreadableEntries(dir, ["proposals"]).map((u) => u.file);
}

/** Files in `kinds/` and `proposals/` that aren't valid entries, each with why, so they're reported instead of hidden. */
export function unreadableEntries(
	dir: string,
	folders: readonly string[] = [...KINDS.map((k) => `kinds/${k}s`), "proposals"],
): { file: string; problem: string }[] {
	return folders.flatMap((rel) =>
		markdownFiles(join(dir, rel)).flatMap((f) => {
			const file = `${rel}/${f}`;
			try {
				const read = readEntry(readFileSync(join(dir, file), "utf8"), file);
				return read.problem ? [{ file, problem: read.problem }] : [];
			} catch (error) {
				return [{ file, problem: reason(error) }];
			}
		}),
	);
}

export function writeProposal(dir: string, entry: Omit<Entry, "file">): string {
	const folder = join(dir, "proposals");
	mkdirSync(folder, { recursive: true });
	// The date comes from agents and old knowledge bases: only a real date may become part of the file name.
	const day = /^\d{4}-\d{2}-\d{2}$/.test(entry.date.slice(0, 10))
		? entry.date.slice(0, 10)
		: new Date().toISOString().slice(0, 10);
	const stem = `${day}-${slug(entry.title)}`;
	let name = `${stem}.md`;
	for (let n = 2; existsSync(join(folder, name)); n++) name = `${stem}-${n}.md`;
	writeFileSync(join(folder, name), renderEntry(entry));
	return `proposals/${name}`;
}

/**
 * Moves a proposal into `kinds/` (accepted) or `rejected/` (kept, never shown). Accepting can change the kind, and set
 * the scope (a list of project ids) or clear it (`null`: global); leaving `scope` out keeps the proposal's own.
 */
export function decide(
	dir: string,
	proposalFile: string,
	verdict: "accept" | "reject",
	change: { kind?: Kind; scope?: readonly string[] | null } = {},
): string {
	const from = join(dir, proposalFile);
	const raw = readFileSync(from, "utf8");
	const read = readEntry(raw, proposalFile);
	if (read.problem !== undefined) throw new Error(`${proposalFile} is not a Grimoire entry: ${read.problem}`);
	const kind = change.kind ?? read.entry.kind;
	let text = raw;
	if (verdict === "accept" && (kind !== read.entry.kind || change.scope !== undefined)) {
		const changed = { ...read.entry, kind };
		text = renderEntry(
			change.scope === undefined ? changed : withScope(changed, change.scope ?? undefined, proposalFile),
		);
	}
	const target = verdict === "accept" ? `kinds/${kind}s` : "rejected";
	mkdirSync(join(dir, target), { recursive: true });
	const name = basename(proposalFile, ".md");
	let to = `${target}/${name}.md`;
	for (let n = 2; existsSync(join(dir, to)); n++) to = `${target}/${name}-${n}.md`;
	renameSync(from, join(dir, to));
	if (text !== raw) writeFileSync(join(dir, to), text);
	return to;
}

const ENTRY_FOLDERS = [...KINDS.map((k) => `kinds/${k}s`), "proposals", "rejected"];

/**
 * The one writer for scope changes: sets the scope of each listed entry (paths from the Grimoire folder, in `kinds/`,
 * `proposals/` or `rejected/`) to these project ids, or makes it global (`undefined`). Every file is checked before
 * any is written, so a bad path, an unreadable entry or an invalid scope changes nothing. Returns the files.
 */
export function setScope(dir: string, files: readonly string[], scope: readonly string[] | undefined): string[] {
	const planned = files.map((file) => {
		const folder = dirname(file);
		if (isAbsolute(file) || !ENTRY_FOLDERS.includes(folder))
			throw new Error(
				`${file} isn't an entry in kinds/, proposals/ or rejected/; root files carry their scope in their own frontmatter`,
			);
		const full = join(dir, file);
		if (!existsSync(full)) throw new Error(`${file} doesn't exist in ${dir}`);
		const raw = readFileSync(full, "utf8");
		const read = readEntry(raw, file);
		if (read.problem !== undefined) throw new Error(`${file} is not a Grimoire entry: ${read.problem}`);
		return { file, full, raw, text: renderEntry(withScope(read.entry, scope, file)) };
	});
	for (const p of planned) if (p.text !== p.raw) writeFileSync(p.full, p.text);
	return planned.map((p) => p.file);
}

export interface LinkProblem {
	/** The root file or entry that links. */
	from: string;
	/** The path it links to, from the Grimoire folder. */
	target: string;
	/** `missing`: no such file. `not-an-entry`: a proposal, a rejected entry or a file that isn't an entry. `out-of-scope`: another project's. */
	problem: "missing" | "not-an-entry" | "out-of-scope";
}

/**
 * Links from the root files and approved entries a project sees whose target it won't see: missing, not an approved
 * entry or root file, or scoped to other projects. A link is a path in an entry's `links`, or a store file's path
 * written in the text (as `/grimoire-ui` finds them), so a missing target is found from `links` only. Loads nothing.
 */
export function linkReport(dir: string, projectId: string | undefined): LinkProblem[] {
	const sees = (scope: string[] | undefined) => !scope || (projectId !== undefined && scope.includes(projectId));
	const approved = listEntries(dir);
	const root = rootFiles(dir).filter((r) => r.problem === undefined);
	const visible = new Set([
		...entriesFor(approved, projectId).map((e) => e.file),
		...root.filter((r) => sees(r.scope)).map((r) => r.file),
	]);
	const known = new Set([...approved.map((e) => e.file), ...root.map((r) => r.file)]);
	const storeFiles = [...ENTRY_FOLDERS, "root"].flatMap((rel) =>
		markdownFiles(join(dir, rel)).map((f) => `${rel}/${f}`),
	);
	const sources = [
		...root.filter((r) => sees(r.scope)).map((r) => ({ file: r.file, text: r.raw, links: [] as string[] })),
		...entriesFor(approved, projectId).map((e) => ({ file: e.file, text: e.body, links: e.links ?? [] })),
	];
	const out: LinkProblem[] = [];
	for (const source of sources) {
		const targets = new Set([
			...source.links,
			...storeFiles.filter((f) => f !== source.file && source.text.includes(f)),
		]);
		for (const target of targets) {
			if (visible.has(target)) continue;
			const problem = known.has(target) ? "out-of-scope" : existsSync(join(dir, target)) ? "not-an-entry" : "missing";
			out.push({ from: source.file, target, problem });
		}
	}
	return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The always-loaded root
// ---------------------------------------------------------------------------------------------------------------------

/** Every `root/*.md`, README first, with its body and scope, or why its frontmatter can't be read. */
function rootFiles(dir: string): { file: string; raw: string; body: string; scope?: string[]; problem?: string }[] {
	const rootDir = join(dir, "root");
	const names = markdownFiles(rootDir).sort((a, b) => {
		const ra = a.toLowerCase() === "readme.md" ? 0 : 1;
		const rb = b.toLowerCase() === "readme.md" ? 0 : 1;
		return ra - rb || a.localeCompare(b);
	});
	return names.map((name) => {
		const raw = readFileSync(join(rootDir, name), "utf8");
		const parts = splitFrontmatter(raw);
		const { scope, problem } = parts ? readScope(readMeta(parts.meta).meta) : {};
		return {
			file: `root/${name}`,
			raw,
			body: (parts?.body ?? raw).trim(),
			...(scope ? { scope } : {}),
			...(problem ? { problem } : {}),
		};
	});
}

/** Joins root files and caps them at `maxChars`, ending with where to read the rest; never cut without saying so. */
function capRoot(files: { file: string; body: string }[], maxChars: number, label: string, rootDir: string): RootText {
	const full = files.map((f) => f.body).join("\n\n");
	const rel = files.map((f) => f.file);
	if (full.length <= Math.max(0, maxChars))
		return { text: full, files: rel, chars: full.length, cut: 0, truncated: false };
	const notice = (shown: number) =>
		`\n\n[The ${label} is cut off here, at ${shown} of ${full.length} characters. Read the rest in ${rootDir}.]`;
	if (maxChars <= 0) return { text: "", files: rel, chars: full.length, cut: full.length, truncated: true };
	const budget = Math.max(0, maxChars - notice(full.length).length);
	const at = full.lastIndexOf("\n", budget);
	const kept = full.slice(0, at > budget / 2 ? at : budget).trimEnd();
	return {
		text: `${kept}${notice(kept.length)}`.slice(-maxChars),
		files: rel,
		chars: full.length,
		cut: full.length - kept.length,
		truncated: true,
	};
}

/**
 * The root for a project: unscoped root files (the global root, at most `LIMITS.globalRootChars`) and the files
 * scoped to the project (at most `LIMITS.projectRootChars`), README first, frontmatter removed, together at most
 * `maxChars`. Each part over its cap ends with a pointer to the rest. With no project the global root may use all of
 * `maxChars`, as it did before projects. Root files whose scope can't be read are left out and listed in `problems`.
 */
export function loadRoot(dir: string, projectId?: string, maxChars = LIMITS.rootChars): Root {
	const rootDir = join(dir, "root");
	const files = rootFiles(dir);
	const usable = files.filter((f) => f.problem === undefined);
	const global = capRoot(
		usable.filter((f) => !f.scope),
		projectId === undefined ? maxChars : Math.min(LIMITS.globalRootChars, maxChars),
		projectId === undefined ? "root" : "global root",
		rootDir,
	);
	const projectFiles = projectId === undefined ? [] : usable.filter((f) => f.scope?.includes(projectId));
	const project = capRoot(
		projectFiles,
		Math.min(LIMITS.projectRootChars, maxChars - global.text.length - (global.text ? 2 : 0)),
		`root for project ${projectId}`,
		rootDir,
	);
	return {
		text: [global.text, project.text].filter(Boolean).join("\n\n"),
		files: [...global.files, ...project.files],
		chars: global.chars + project.chars,
		cut: global.cut + project.cut,
		truncated: global.truncated || project.truncated,
		global,
		project,
		problems: files.flatMap((f) => (f.problem === undefined ? [] : [{ file: f.file, problem: f.problem }])),
	};
}

export function loadRootWithStatus(
	dir: string,
	projectId?: string,
	maxChars = LIMITS.rootChars,
): { status: GrimoireStoreStatus; root: Root } {
	const status = grimoireStoreStatus(dir);
	const part = { text: "", files: [], chars: 0, cut: 0, truncated: false };
	const empty = { ...part, global: part, project: part, problems: [] };
	if (status.state === "missing") return { status, root: empty };
	if (status.state === "unreadable") return { status, root: empty };
	try {
		return { status, root: loadRoot(dir, projectId, maxChars) };
	} catch (error) {
		return { status: unreadable(dir, error), root: empty };
	}
}

/**
 * The root as one file Claude Code imports from CLAUDE.md (`<grimoire>/.sitra/root.md`), capped like Pi's. With
 * `projects` (projects are in use), it is the same for every project: the global root (at most
 * `LIMITS.globalRootChars`) and the catalogue of global entries; Claude Code's session hook adds the project's part.
 * Rewritten only when it changed; every Claude Code session start and every sitra session start refreshes it, so
 * files approved later are picked up.
 */
export function writeClaudeRoot(dir: string, maxChars = LIMITS.rootChars, projects = false): string {
	const file = join(dir, ".sitra", "root.md");
	const { text } = claudeImport(dir, maxChars, projects);
	if (!existsSync(file) || readFileSync(file, "utf8") !== text) {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, text);
	}
	return file;
}

/** The text `writeClaudeRoot` writes, with the root it holds and, with projects in use, its global catalogue. */
export function claudeImport(
	dir: string,
	maxChars = LIMITS.rootChars,
	projects = false,
): { text: string; root: Root; catalogue?: CatalogueFit } {
	const root = loadRoot(dir, undefined, projects ? Math.min(LIMITS.globalRootChars, maxChars) : maxChars);
	if (!projects) return { text: root.text ? `${root.text}\n` : "(The Grimoire root is empty.)\n", root };
	const global = entriesFor(listEntries(dir), undefined);
	const search = `\`sitra grimoire search --dir ${shellQuote(dir)} "<words>"\` in the shell`;
	const listed = catalogueFit(global, LIMITS.catalogueChars, search);
	const text = [
		root.text || "(The Grimoire global root is empty.)",
		"",
		"---",
		"",
		`## Global Grimoire entries (${global.length}, in ${dir})`,
		"Entries for the project you work in come from sitra's session hook.",
		...(global.length > 0 ? ["", listed.text] : []),
		"",
	].join("\n");
	return { text, root, catalogue: listed };
}

export interface SectionOptions {
	who?: string;
	catalogueChars?: number;
	/** For tools without sitra's grimoire_search and grimoire_propose (Claude Code, Codex): use the shell and files. */
	shell?: boolean;
	/** The project the entries were chosen for. Leave it out when no projects are registered. */
	scope?: SectionScope;
	/** The catalogue as already built (a `projectCatalogue`), used instead of building one from `entries`. */
	catalogueText?: string;
	/**
	 * The file the global root and global entries are loaded from instead (Claude Code's import). `entries` are then
	 * the project's only, and the section says where the global part is.
	 */
	globalIn?: string;
}

/** How a section tells the agent to search: sitra's tool, or the shell command for this project. */
function sectionSearch(dir: string, options: SectionOptions): string {
	const scope = options.scope;
	const flag = !scope ? "" : scope.project ? ` --project ${scope.project.id}` : " --global-only";
	return options.shell
		? `\`sitra grimoire search --dir ${shellQuote(dir)}${flag} "<words>"\` in the shell`
		: "grimoire_search";
}

/** The catalogue `grimoireSection` lists for these entries and options (unless given `catalogueText`), with its counts. */
export function sectionCatalogue(dir: string, entries: readonly Entry[], options: SectionOptions = {}): CatalogueFit {
	if (entries.length === 0) return { text: "", shown: 0, total: 0 };
	return catalogueFit(entries, options.catalogueChars, sectionSearch(dir, options));
}

/**
 * What every agent starts with: the root, the catalogue of approved entries, and how to find and propose more.
 * Stable across turns (it only changes when Grimoire does), so it stays in the cached part of the prompt. Pass no root
 * when the tool loads the root another way (Claude Code imports it from CLAUDE.md). With `scope`, the entries are
 * expected to be `entriesFor` that project; the section names it, or says why there is none.
 */
export function grimoireSection(
	dir: string,
	root: RootText | Root | undefined,
	entries: readonly Entry[],
	options: SectionOptions = {},
): string {
	const who = options.who ?? "the person you work with";
	const scope = options.scope;
	const search = sectionSearch(dir, options);
	const scopeField = scope?.project
		? `; scope, ["${scope.project.id}"] for ${scope.project.label} only, or leave it out when it applies everywhere`
		: "";
	const propose = options.shell
		? `add a file to ${join(dir, "proposals")} named YYYY-MM-DD-short-title.md: frontmatter between --- lines with one JSON-style value per line (kind: lesson, fact, decision, warning or setup; title; date; proposedBy; evidence; summary, one sentence; tags; links, paths of related entries${scopeField}), then a short body`
		: "use grimoire_propose";
	const out = [`# Grimoire: ${who}'s approved knowledge`];
	const projectRoot = root && "project" in root && scope?.project ? root.project.text : "";
	const rootText = projectRoot && root && "global" in root ? root.global.text : root?.text;
	if (rootText) out.push("", rootText);
	if (projectRoot) out.push("", `## Root for ${scope?.project?.label}`, "", projectRoot);
	if (rootText || projectRoot) out.push("", "---");
	const globalCount = entries.filter((e) => !e.scope).length;
	const count = options.globalIn
		? scope?.project
			? `${entries.length} for ${scope.project.label}`
			: "global only"
		: !scope
			? `${entries.length}`
			: scope.project
				? `${globalCount} global + ${entries.length - globalCount} for ${scope.project.label}`
				: `${globalCount} global`;
	out.push(
		"",
		`## Approved entries (${count}, in ${dir})`,
		...(scope?.project
			? [
					`This session is in project ${scope.project.label} (${scope.project.id}), fixed when it started: you get global entries and ${scope.project.label}'s, not other projects'.`,
				]
			: scope
				? [`No project here, so global only: ${scope.why}.`]
				: []),
		...(options.globalIn
			? [`The global root and global entries are in ${options.globalIn}, which CLAUDE.md imports.`]
			: []),
		`Before each step, check whether an entry below touches what you are about to do; if one might, read it in full before acting. Don't guess what ${who} would want: look it up (${search}) or ask.`,
	);
	const listed = options.catalogueText ?? sectionCatalogue(dir, entries, options).text;
	if (listed) out.push("", listed);
	out.push(
		"",
		`When you learn something future agents must know (a lesson from a mistake, a fact about how things really work, a decision and its reason, a warning, a change to the agent setup), propose it: ${propose}. Only ${who} approves entries. Never edit files in ${join(dir, "root")} or ${join(dir, "kinds")}.`,
	);
	return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Search: BM25 over title, tags, summary and body.
// ---------------------------------------------------------------------------------------------------------------------

const STOP = new Set(
	`a an the and or but if then so to of in on at for with from by as is are was were be been being it its this that these
those i you he she we they me my your our us them their do does did done doing have has had not no yes ok okay just can could
would should will shall may might must what why how when where which who whom there here also all any some more most very
too up out about into over again now than like get got let lets go going want wanted need needs make sure think know see
look use using one thing things really still even way well back right good great thanks thank please im ive youre thats
whats dont didnt doesnt isnt wont cant hey hi sound sounds lol yeah yep nope maybe kind sort bit lot lots something anything
everything nothing every each other another same such only own both few many much just able done said say says tell told
being am wasnt werent hasnt havent hadnt wouldnt shouldnt couldnt via per etc ie eg`.split(/\s+/),
);

function stem(word: string): string {
	let w = word;
	if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
	else if (w.length > 4 && (w.endsWith("sses") || w.endsWith("ches") || w.endsWith("shes") || w.endsWith("xes")))
		w = w.slice(0, -2);
	else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is"))
		w = w.slice(0, -1);
	if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
	else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
	return w;
}

export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/['’]/g, "")
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length >= 2 && !STOP.has(t) && !/^\d{1,2}$/.test(t))
		.map(stem);
}

const FIELD_WEIGHTS = { title: 3, tags: 3, summary: 2, body: 1 } as const;
const K1 = 1.2;
const B = 0.75;

interface Doc {
	entry: Entry;
	tf: Map<string, number>;
	len: number;
}

function docOf(entry: Entry): Doc {
	const tf = new Map<string, number>();
	let len = 0;
	const add = (text: string | undefined, weight: number) => {
		for (const t of tokenize(text ?? "")) {
			tf.set(t, (tf.get(t) ?? 0) + weight);
			len += weight;
		}
	};
	add(entry.title, FIELD_WEIGHTS.title);
	add((entry.tags ?? []).join(" "), FIELD_WEIGHTS.tags);
	add(entry.summary, FIELD_WEIGHTS.summary);
	add(entry.body, FIELD_WEIGHTS.body);
	return { entry, tf, len };
}

export interface Ranked {
	entry: Entry;
	score: number;
}

/** Every entry that shares a word with the query, best first. */
export function rankEntries(entries: readonly Entry[], query: string): Ranked[] {
	const docs = entries.map(docOf);
	if (docs.length === 0) return [];
	const avg = docs.reduce((s, d) => s + d.len, 0) / docs.length || 1;
	const df = new Map<string, number>();
	for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
	const terms = new Set(tokenize(query.slice(0, LIMITS.queryChars)));
	const out: Ranked[] = [];
	for (const d of docs) {
		let score = 0;
		for (const t of terms) {
			const tf = d.tf.get(t);
			if (!tf) continue;
			const n = df.get(t) ?? 0;
			const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
			score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d.len) / avg)));
		}
		if (score > 0) out.push({ entry: d.entry, score });
	}
	return out.sort((a, b) => b.score - a.score || a.entry.file.localeCompare(b.entry.file));
}

const ORDER: Kind[] = ["warning", "decision", "lesson", "fact", "setup"];

/** One line per entry. */
function catalogueLine(e: Entry): string {
	return `- [${e.kind}] ${e.title}${e.summary ? `: ${e.summary}` : ""} (${e.file})`;
}

/**
 * Every approved entry as one line (kind, title, summary, path), most important kinds first and newest first within a
 * kind, so an agent can open what applies. Past `maxChars` the rest are counted, and found with grimoire_search.
 */
function catalogueOrder(entries: readonly Entry[]): Entry[] {
	return ORDER.flatMap((k) =>
		entries.filter((e) => e.kind === k).sort((a, b) => b.date.localeCompare(a.date) || a.file.localeCompare(b.file)),
	);
}

export function catalogue(
	entries: readonly Entry[],
	maxChars = LIMITS.catalogueChars,
	search = "grimoire_search",
): string {
	return catalogueFit(entries, maxChars, search).text;
}

/** A catalogue and how many of its entries it lists; the rest are counted in its last line. */
export interface CatalogueFit {
	text: string;
	shown: number;
	total: number;
}

export function catalogueFit(
	entries: readonly Entry[],
	maxChars = LIMITS.catalogueChars,
	search = "grimoire_search",
): CatalogueFit {
	const sorted = catalogueOrder(entries);
	const all = sorted.map(catalogueLine);
	if (all.join("\n").length <= maxChars) return { text: all.join("\n"), shown: sorted.length, total: sorted.length };
	const more = (n: number) => `- …and ${n} more. Find them with ${search}.`;
	const budget = maxChars - more(sorted.length).length - 1;
	const lines: string[] = [];
	let used = 0;
	for (const line of all) {
		if (used + line.length + 1 > budget) break;
		lines.push(line);
		used += line.length + 1;
	}
	const shown = lines.length;
	lines.push(more(sorted.length - shown));
	return { text: lines.join("\n").slice(0, maxChars), shown, total: sorted.length };
}

export interface ProjectCatalogue {
	text: string;
	/** Entries listed in `text`, in full or by title. */
	shown: number;
	/** Summaries were left out so every title (or as many as fit) could be listed. */
	titlesOnly: boolean;
	/** Entries not listed in `text`, all written to `file`. Absent when every entry is listed. */
	overflow?: { count: number; file: string };
}

/** Where a project's full catalogue goes when the hook can't show every title. */
export function catalogueOverflowFile(dir: string, projectId: string): string {
	return join(dir, ".sitra", "catalogues", `${projectId}.md`);
}

const TITLES_ONLY = "Titles only, to fit; each entry's summary is in its file.";

/**
 * A project's catalogue within `budget` characters, never cut without saying so: full lines if they fit; else titles
 * only for every entry; else as many titles as fit, then a line counting the rest and naming `overflowFile`, which
 * gets the full catalogue (rewritten only when it changes). `search` is how to search the project's entries.
 */
export function projectCatalogue(
	entries: readonly Entry[],
	budget: number,
	overflowFile: string,
	options: { label: string; search: string },
): ProjectCatalogue {
	const sorted = catalogueOrder(entries);
	const full = sorted.map(catalogueLine);
	if (full.join("\n").length <= budget) return { text: full.join("\n"), shown: sorted.length, titlesOnly: false };
	const titles = sorted.map((e) => `- [${e.kind}] ${e.title} (${e.file})`);
	const titled = [TITLES_ONLY, ...titles].join("\n");
	if (titled.length <= budget) return { text: titled, shown: sorted.length, titlesOnly: true };

	const total = sorted.length;
	const more = (count: number, shown: number) =>
		`- …and ${count} more ${options.label} entries (showing ${shown} of ${total}): full list in ${overflowFile}; read it before work they might touch, or search with ${options.search}.`;
	const room = budget - TITLES_ONLY.length - 1 - more(total, total).length - 1;
	const lines: string[] = [];
	let used = 0;
	for (const line of titles) {
		if (used + line.length + 1 > room) break;
		lines.push(line);
		used += line.length + 1;
	}
	const content = `# ${options.label}: every approved entry (${total})\n\n${full.join("\n")}\n`;
	if (!existsSync(overflowFile) || readFileSync(overflowFile, "utf8") !== content) {
		mkdirSync(dirname(overflowFile), { recursive: true });
		writeFileSync(overflowFile, content);
	}
	const count = total - lines.length;
	return {
		text: [TITLES_ONLY, ...lines, more(count, lines.length)].join("\n"),
		shown: lines.length,
		titlesOnly: true,
		overflow: { count, file: overflowFile },
	};
}

/** An entry's scope for a list that mixes projects: `global`, or `scope: <ids>`. */
export function scopeLabel(entry: Entry): string {
	return entry.scope ? `scope: ${entry.scope.join(", ")}` : "global";
}

/** grimoire_search's answer: the best matches as catalogue lines, or a plain "nothing found". */
export function searchEntries(
	entries: readonly Entry[],
	query: string,
	limit = 8,
	label?: (entry: Entry) => string,
): string {
	const ranked = rankEntries(entries, query).slice(0, limit);
	if (ranked.length === 0) return `Nothing in Grimoire matches "${query}".`;
	return ranked.map((r) => `${catalogueLine(r.entry)}${label ? ` [${label(r.entry)}]` : ""}`).join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------
// Moving a repo's old `/kb` (`.pi/knowledge`) in
// ---------------------------------------------------------------------------------------------------------------------

/** Same title, ignoring only case, spacing and punctuation: "Use production" and "Do not use production" differ. */
const normalTitle = (t: string) =>
	t
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
const IMPORTS = ".sitra-imports.json";

/** Repos whose old knowledge base has been imported, so sessions there stop suggesting it. */
export function importedRepos(dir: string): string[] {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, IMPORTS), "utf8"));
		return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === "string") : [];
	} catch {
		return [];
	}
}

/**
 * Copies a repo's `.pi/knowledge` entries (approved and proposed) into `proposals/` for the person to review, skipping
 * any whose title Grimoire already has anywhere (approved, proposed or rejected, in every scope). With `scope`, the
 * proposals are scoped to those projects; with `scopeNote` (from `proposalScope`), they record why they are global.
 * Never touches the old folder.
 */
export function importKnowledge(
	source: string,
	dir: string,
	label: string,
	placement: { scope?: readonly string[]; scopeNote?: string } = {},
): { imported: string[]; skipped: string[] } {
	const { scope, scopeNote } = placement;
	const known = new Set(
		[...listEntries(dir), ...listProposals(dir), ...readEntries(dir, "rejected")].map((e) => normalTitle(e.title)),
	);
	const incoming = [...KINDS.flatMap((k) => readEntries(source, `${k}s`)), ...readEntries(source, "proposals")];
	const imported: string[] = [];
	const skipped: string[] = [];
	for (const { file, ...entry } of incoming) {
		const key = normalTitle(entry.title);
		if (known.has(key)) {
			skipped.push(file);
			continue;
		}
		known.add(key);
		const note = `imported from ${label} (.pi/knowledge/${file})`;
		const noted = { ...entry, evidence: entry.evidence ? `${entry.evidence}; ${note}` : note };
		const placed = scope
			? withScope(noted, scope, file)
			: scopeNote
				? { ...withScope(noted, undefined, file), scopeNote }
				: noted;
		imported.push(writeProposal(dir, placed));
	}
	const repos = importedRepos(dir);
	if (!repos.includes(label)) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, IMPORTS), `${JSON.stringify([...repos, label], null, "\t")}\n`);
	}
	return { imported, skipped };
}
