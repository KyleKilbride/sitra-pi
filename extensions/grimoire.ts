/**
 * Grimoire: one approved brain per person, shared by every agent they run. Plain markdown in `root/` (always loaded),
 * `kinds/` (approved entries, pulled in by relevance), `proposals/` (agents write only here) and `rejected/`.
 * No Pi imports: the Pi extension, the CLI and the Claude Code / Codex hooks all build on this file.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
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
	truncated: boolean;
}

export type GrimoireStoreStatus =
	| { state: "ok"; dir: string }
	| { state: "missing"; dir: string; reason: string }
	| { state: "unreadable"; dir: string; reason: string };

/** Sizes that keep the brain from crowding out the work. */
export const LIMITS = { rootChars: 32_000, catalogueChars: 12_000, queryChars: 4_000 };

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

const FIELDS = ["kind", "title", "date", "proposedBy", "evidence", "summary", "tags", "links", "when"] as const;

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

export function parseEntry(raw: string, file: string): Entry | undefined {
	const parts = splitFrontmatter(raw);
	if (!parts) return undefined;
	const meta: Record<string, unknown> = {};
	const extra: { key: string; raw: string }[] = [];
	for (const line of parts.meta.split("\n")) {
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
	const str = (k: string) => (typeof meta[k] === "string" && meta[k] ? (meta[k] as string) : undefined);
	const kind = str("kind");
	const title = str("title");
	const date = str("date");
	if (!KINDS.includes(kind as Kind) || !title || !date) return undefined;
	const evidence = str("evidence");
	const proposedBy = str("proposedBy");
	const summary = str("summary");
	const tags = list(meta.tags);
	const links = list(meta.links);
	const when = list(meta.when);
	return {
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
		...(extra.length > 0 ? { extra } : {}),
		file,
	};
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
	const ok = new Set(listProposals(dir).map((p) => p.file));
	return markdownFiles(join(dir, "proposals"))
		.map((f) => `proposals/${f}`)
		.filter((f) => !ok.has(f));
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

/** Moves a proposal into `kinds/` (accepted, optionally as a different kind) or `rejected/` (kept, never shown). */
export function decide(dir: string, proposalFile: string, verdict: "accept" | "reject", kind?: Kind): string {
	const from = join(dir, proposalFile);
	const entry = parseEntry(readFileSync(from, "utf8"), proposalFile);
	if (!entry) throw new Error(`${proposalFile} is not a Grimoire entry`);
	let text = readFileSync(from, "utf8");
	if (verdict === "accept" && kind && kind !== entry.kind) {
		text = text.replace(/^kind:.*$/m, `kind: ${JSON.stringify(kind)}`);
	}
	const target = verdict === "accept" ? `kinds/${kind ?? entry.kind}s` : "rejected";
	mkdirSync(join(dir, target), { recursive: true });
	const name = basename(proposalFile, ".md");
	let to = `${target}/${name}.md`;
	for (let n = 2; existsSync(join(dir, to)); n++) to = `${target}/${name}-${n}.md`;
	renameSync(from, join(dir, to));
	if (text !== readFileSync(join(dir, to), "utf8")) writeFileSync(join(dir, to), text);
	return to;
}

// ---------------------------------------------------------------------------------------------------------------------
// The always-loaded root
// ---------------------------------------------------------------------------------------------------------------------

/** Every `root/*.md`, README first, frontmatter removed, capped at `maxChars` with a pointer to the rest. */
export function loadRoot(dir: string, maxChars = LIMITS.rootChars): RootText {
	const rootDir = join(dir, "root");
	const files = markdownFiles(rootDir).sort((a, b) => {
		const ra = a.toLowerCase() === "readme.md" ? 0 : 1;
		const rb = b.toLowerCase() === "readme.md" ? 0 : 1;
		return ra - rb || a.localeCompare(b);
	});
	if (files.length === 0) return { text: "", files: [], chars: 0, truncated: false };
	const parts = files.map((f) => {
		const raw = readFileSync(join(rootDir, f), "utf8");
		return (splitFrontmatter(raw)?.body ?? raw).trim();
	});
	const full = parts.join("\n\n");
	const rel = files.map((f) => `root/${f}`);
	if (full.length <= maxChars) return { text: full, files: rel, chars: full.length, truncated: false };
	const notice = (shown: number) =>
		`\n\n[The root is cut off here, at ${shown} of ${full.length} characters. Read the rest in ${rootDir}.]`;
	const budget = Math.max(0, maxChars - notice(full.length).length);
	const cut = full.lastIndexOf("\n", budget);
	const kept = full.slice(0, cut > budget / 2 ? cut : budget).trimEnd();
	return {
		text: `${kept}${notice(kept.length)}`.slice(-maxChars),
		files: rel,
		chars: full.length,
		truncated: true,
	};
}

export function loadRootWithStatus(
	dir: string,
	maxChars = LIMITS.rootChars,
): { status: GrimoireStoreStatus; root: RootText } {
	const status = grimoireStoreStatus(dir);
	const empty = { text: "", files: [], chars: 0, truncated: false };
	if (status.state === "missing") return { status, root: empty };
	if (status.state === "unreadable") return { status, root: empty };
	try {
		return { status, root: loadRoot(dir, maxChars) };
	} catch (error) {
		return { status: unreadable(dir, error), root: empty };
	}
}

/**
 * The root as one file Claude Code imports from CLAUDE.md (`<grimoire>/.sitra/root.md`), capped like Pi's. Rewritten
 * only when the root changed; every Claude Code session start and every sitra session start refreshes it, so root
 * files approved later are picked up.
 */
export function writeClaudeRoot(dir: string, maxChars = LIMITS.rootChars): string {
	const file = join(dir, ".sitra", "root.md");
	const root = loadRoot(dir, maxChars);
	const text = root.text ? `${root.text}\n` : "(The Grimoire root is empty.)\n";
	if (!existsSync(file) || readFileSync(file, "utf8") !== text) {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, text);
	}
	return file;
}

export interface SectionOptions {
	who?: string;
	catalogueChars?: number;
	/** For tools without sitra's grimoire_search and grimoire_propose (Claude Code, Codex): use the shell and files. */
	shell?: boolean;
}

/**
 * What every agent starts with: the root, the catalogue of approved entries, and how to find and propose more.
 * Stable across turns (it only changes when Grimoire does), so it stays in the cached part of the prompt. Pass no root
 * when the tool loads the root another way (Claude Code imports it from CLAUDE.md).
 */
export function grimoireSection(
	dir: string,
	root: RootText | undefined,
	entries: readonly Entry[],
	options: SectionOptions = {},
): string {
	const who = options.who ?? "the person you work with";
	const search = options.shell
		? `\`sitra grimoire search --dir ${shellQuote(dir)} "<words>"\` in the shell`
		: "grimoire_search";
	const propose = options.shell
		? `add a file to ${join(dir, "proposals")} named YYYY-MM-DD-short-title.md: frontmatter between --- lines with one JSON-style value per line (kind: lesson, fact, decision, warning or setup; title; date; proposedBy; evidence; summary, one sentence; tags; links, paths of related entries), then a short body`
		: "use grimoire_propose";
	const out = [`# Grimoire: ${who}'s approved knowledge`];
	if (root?.text) out.push("", root.text, "", "---");
	out.push(
		"",
		`## Approved entries (${entries.length}, in ${dir})`,
		`Before each step, check whether an entry below touches what you are about to do; if one might, read it in full before acting. Don't guess what ${who} would want: look it up (${search}) or ask.`,
	);
	if (entries.length > 0) out.push("", catalogue(entries, options.catalogueChars, search));
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
export function catalogue(
	entries: readonly Entry[],
	maxChars = LIMITS.catalogueChars,
	search = "grimoire_search",
): string {
	const sorted = ORDER.flatMap((k) =>
		entries.filter((e) => e.kind === k).sort((a, b) => b.date.localeCompare(a.date) || a.file.localeCompare(b.file)),
	);
	const all = sorted.map(catalogueLine);
	if (all.join("\n").length <= maxChars) return all.join("\n");
	const more = (n: number) => `- …and ${n} more. Find them with ${search}.`;
	const budget = maxChars - more(sorted.length).length - 1;
	const lines: string[] = [];
	let used = 0;
	for (const line of all) {
		if (used + line.length + 1 > budget) break;
		lines.push(line);
		used += line.length + 1;
	}
	lines.push(more(sorted.length - lines.length));
	return lines.join("\n").slice(0, maxChars);
}

/** grimoire_search's answer: the best matches as catalogue lines, or a plain "nothing found". */
export function searchEntries(entries: readonly Entry[], query: string, limit = 8): string {
	const ranked = rankEntries(entries, query).slice(0, limit);
	if (ranked.length === 0) return `Nothing in Grimoire matches "${query}".`;
	return ranked.map((r) => catalogueLine(r.entry)).join("\n");
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
 * any whose title Grimoire already has anywhere (approved, proposed or rejected). Never touches the old folder.
 */
export function importKnowledge(source: string, dir: string, label: string): { imported: string[]; skipped: string[] } {
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
		imported.push(writeProposal(dir, { ...entry, evidence: entry.evidence ? `${entry.evidence}; ${note}` : note }));
	}
	const repos = importedRepos(dir);
	if (!repos.includes(label)) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, IMPORTS), `${JSON.stringify([...repos, label], null, "\t")}\n`);
	}
	return { imported, skipped };
}
