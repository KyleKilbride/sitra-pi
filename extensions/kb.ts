import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** What an entry is. `setup` entries propose changes to the agent setup itself (extensions, config, prompts). */
export const KINDS = ["lesson", "fact", "decision", "warning", "setup"] as const;
export type Kind = (typeof KINDS)[number];

export interface Entry {
	kind: Kind;
	title: string;
	body: string;
	evidence?: string;
	proposedBy?: string;
	date: string;
	/** Path relative to the knowledge root. */
	file: string;
}

/** `.pi/knowledge` in the repo: accepted entries by kind, `proposals/` waiting for you, `rejected/` kept for the record. */
export function knowledgeRoot(repo: string): string {
	return join(repo, ".pi", "knowledge");
}

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

const FIELDS = ["kind", "title", "date", "proposedBy", "evidence"] as const;

export function renderEntry(entry: Omit<Entry, "file">): string {
	const lines = ["---"];
	for (const key of FIELDS) {
		const value = entry[key];
		if (value !== undefined) lines.push(`${key}: ${JSON.stringify(value)}`);
	}
	lines.push("---", "", entry.body.trim(), "");
	return lines.join("\n");
}

export function parseEntry(raw: string, file: string): Entry | undefined {
	const text = raw.replace(/\r\n/g, "\n");
	const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
	if (!match) return undefined;
	const meta: Record<string, string> = {};
	for (const line of (match[1] ?? "").split("\n")) {
		const kv = /^(\w+):\s*(.*)$/.exec(line);
		if (!kv?.[1]) continue;
		const raw = kv[2] ?? "";
		try {
			meta[kv[1]] = raw.startsWith('"') ? JSON.parse(raw) : raw;
		} catch {
			meta[kv[1]] = raw;
		}
	}
	if (!KINDS.includes(meta.kind as Kind) || !meta.title || !meta.date) return undefined;
	return {
		kind: meta.kind as Kind,
		title: meta.title,
		body: (match[2] ?? "").trim(),
		...(meta.evidence ? { evidence: meta.evidence } : {}),
		...(meta.proposedBy ? { proposedBy: meta.proposedBy } : {}),
		date: meta.date,
		file,
	};
}

const ORDER: Kind[] = ["warning", "decision", "lesson", "fact", "setup"];

/** The compact list every agent sees at the start of a session; full entries are one `read` away. */
export function knowledgeIndex(entries: readonly Entry[], root: string): string {
	const out = [
		"# Project knowledge (approved by the human)",
		"Read an entry in full before acting on anything it touches. When you learn something future agents need,",
		"call kb_propose — the human approves each entry; you never edit these files directly.",
	];
	if (entries.length === 0) out.push("", "(No entries yet.)");
	for (const kind of ORDER) {
		const ofKind = entries.filter((e) => e.kind === kind);
		if (ofKind.length === 0) continue;
		out.push("", `## ${kind}s`);
		for (const e of ofKind) out.push(`- ${e.title} — ${join(root, e.file)}`);
	}
	return `${out.join("\n")}\n`;
}

export function listEntries(root: string): Entry[] {
	return KINDS.flatMap((kind) => readDir(join(root, `${kind}s`), `${kind}s`));
}

export function listProposals(root: string): Entry[] {
	return readDir(join(root, "proposals"), "proposals");
}

function readDir(dir: string, rel: string): Entry[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.sort()
		.flatMap((f) => {
			try {
				const entry = parseEntry(readFileSync(join(dir, f), "utf8"), `${rel}/${f}`);
				return entry ? [entry] : [];
			} catch {
				return []; // one unreadable file never hides the rest
			}
		});
}

export function writeProposal(root: string, entry: Omit<Entry, "file">): string {
	const dir = join(root, "proposals");
	mkdirSync(dir, { recursive: true });
	let name = `${entry.date.slice(0, 10)}-${slug(entry.title)}.md`;
	for (let n = 2; existsSync(join(dir, name)); n++) name = `${entry.date.slice(0, 10)}-${slug(entry.title)}-${n}.md`;
	writeFileSync(join(dir, name), renderEntry(entry));
	return `proposals/${name}`;
}

/** Moves a proposal into the knowledge base (accepted) or into rejected/ (kept, never shown to agents). */
export function decide(root: string, proposalFile: string, verdict: "accept" | "reject", kind?: Kind): string {
	const from = join(root, proposalFile);
	const entry = parseEntry(readFileSync(from, "utf8"), proposalFile);
	if (!entry) throw new Error(`${proposalFile} is not a knowledge entry`);
	const dir = verdict === "accept" ? `${kind ?? entry.kind}s` : "rejected";
	mkdirSync(join(root, dir), { recursive: true });
	const name = basename(proposalFile, ".md");
	let to = `${dir}/${name}.md`;
	for (let n = 2; existsSync(join(root, to)); n++) to = `${dir}/${name}-${n}.md`;
	renameSync(from, join(root, to));
	return to;
}

/**
 * The checkout whose `.pi/knowledge` this folder uses: the main checkout, even from inside a linked worktree, so
 * every worktree of a repo reads and grows the same knowledge base. Outside git, the folder itself.
 */
export function knowledgeRepo(cwd: string): string {
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	try {
		// The shared `.git` of all worktrees lives in the main checkout. Submodules and unusual layouts keep their
		// own top level.
		const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
		return basename(common) === ".git" ? dirname(common) : git("rev-parse", "--show-toplevel");
	} catch {
		return cwd;
	}
}

/** Every project (knowledge repo) any sitra session has run in, so the tower can read all their knowledge. */
function knownProjectsFile(profileDir: string): string {
	return join(profileDir, "sitra-known-projects.json");
}

export function listKnownProjects(profileDir: string): string[] {
	try {
		const list = JSON.parse(readFileSync(knownProjectsFile(profileDir), "utf8"));
		return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
	} catch {
		return [];
	}
}

export function rememberProject(profileDir: string, repo: string): void {
	const known = listKnownProjects(profileDir);
	if (known.includes(repo)) return;
	mkdirSync(profileDir, { recursive: true });
	writeFileSync(knownProjectsFile(profileDir), `${JSON.stringify([...known, repo], null, "\t")}\n`);
}

/**
 * The tower's view of every other project's approved knowledge: one line per entry, grouped by project, most
 * important kinds first. Empty string when no other project has entries.
 */
export function allProjectsKnowledgeIndex(repos: readonly string[], ownRepo: string): string {
	const out: string[] = [];
	for (const repo of new Set(repos)) {
		if (repo === ownRepo) continue;
		const root = knowledgeRoot(repo);
		const entries = listEntries(root);
		if (entries.length === 0) continue;
		out.push("", `## ${basename(repo)} (${entries.length} entries)`);
		for (const kind of ORDER) {
			for (const e of entries.filter((x) => x.kind === kind))
				out.push(`- [${kind}] ${e.title} — ${join(root, e.file)}`);
		}
	}
	if (out.length === 0) return "";
	return [
		"# Other projects' knowledge (approved by the human)",
		"What the workers in each project have been told. Read an entry in full before judging whether a worker is",
		"following it or before advising on anything it touches. Workers propose these with kb_propose in their own project.",
		...out,
		"",
	].join("\n");
}
