/**
 * Session registry: every sitra session (worker lead, teammate, or tower) records its live status in
 * `<PI_CODING_AGENT_DIR>/sitra-sessions/<id>.json` so the tower can see every session across all projects and worktrees.
 */
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	closeSync,
	copyFileSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { shellQuote } from "./runs.ts";

export type SessionRole = "lead" | "teammate" | "tower";
export type SessionStatus = "idle" | "working" | "waiting_for_user" | "stopped";

export interface SessionRecord {
	id: string;
	role: SessionRole;
	name?: string;
	agent?: string;
	pid: number;
	cwd: string;
	repo: string;
	branch?: string;
	sessionFile?: string;
	parentSessionFile?: string;
	paneId?: string;
	status: SessionStatus;
	/** Found through herdr, not the sitra registry: an older or non-sitra Pi with no inbox. */
	discovered?: boolean;
	waitingFor?: string;
	task?: string;
	startedAt: string;
	updatedAt: string;
}

export interface TranscriptItem {
	role: "user" | "assistant" | "tool" | "custom";
	text: string;
	/** Tool results only: whether the call failed. */
	error?: boolean;
}

export interface InboxMessage {
	id: string;
	from: string;
	fromSessionId: string;
	toSessionId: string;
	text: string;
	createdAt: string;
}

export interface SessionAlert {
	key: string;
	sessionId: string;
	kind: "waiting_for_user" | "stopped" | "repeated_errors" | "stalled";
	summary: string;
}

export interface FrictionReport {
	totalSessions: number;
	toolErrorCounts: Record<string, number>;
	hotspots: string[];
}

export function auditSessionsFriction(
	records: readonly SessionRecord[],
	readTail: (sessionFile: string) => TranscriptItem[],
): FrictionReport {
	const workers = records.filter((r) => r.role !== "tower");
	const toolErrorCounts: Record<string, number> = {};
	const examples: Record<string, string> = {};
	for (const r of workers) {
		if (!r.sessionFile) continue;
		for (const item of readTail(r.sessionFile)) {
			if (item.role !== "tool" || !item.error) continue;
			const match = /^([a-zA-Z0-9_-]+) error:\s*(.*)$/.exec(item.text);
			const tool = match?.[1] ?? "tool";
			toolErrorCounts[tool] = (toolErrorCounts[tool] ?? 0) + 1;
			if (!examples[tool] && match?.[2]) examples[tool] = `${sessionLabel(r)}: ${match[2]}`;
		}
	}
	const hotspots = Object.entries(toolErrorCounts)
		.sort((a, b) => b[1] - a[1])
		.map(
			([tool, count]) =>
				`${tool} (${count} error${count === 1 ? "" : "s"}${examples[tool] ? ` — e.g. ${examples[tool]}` : ""})`,
		);
	return { totalSessions: workers.length, toolErrorCounts, hotspots };
}

const STALL_MS = 10 * 60_000;

function sessionLabel(record: SessionRecord): string {
	const project = basename(record.repo || record.cwd);
	return record.branch ? `${project} (${record.branch})` : project;
}

export function detectSessionAlerts(
	records: readonly SessionRecord[],
	readTail?: (sessionFile: string) => TranscriptItem[],
	nowMs = Date.now(),
): SessionAlert[] {
	const alerts: SessionAlert[] = [];
	for (const r of records) {
		if (r.role === "tower") continue;
		const where = sessionLabel(r);
		if (r.status === "waiting_for_user") {
			alerts.push({
				key: `waiting:${r.id}:${r.updatedAt}`,
				sessionId: r.id,
				kind: "waiting_for_user",
				summary: `${where} is waiting for your answer${r.task ? ` (task: ${r.task})` : ""}.`,
			});
			continue;
		}
		if (r.status === "stopped" && r.role === "lead") {
			alerts.push({
				key: `stopped:${r.id}`,
				sessionId: r.id,
				kind: "stopped",
				summary: `${where} stopped unexpectedly (process ${r.pid} is no longer running).`,
			});
			continue;
		}
		if (r.sessionFile && readTail) {
			const tail = readTail(r.sessionFile);
			// Failed tool results in a row, newest first. A turn that only calls tools sits between retries and doesn't
			// break the streak; a successful result, the person, or the agent saying something does.
			let streak = 0;
			let lastError = "";
			for (let i = tail.length - 1; i >= 0; i--) {
				const item = tail[i];
				if (item?.role === "tool" && item.error) {
					streak++;
					if (!lastError) lastError = item.text;
				} else if (item?.role === "assistant" && item.text.startsWith("[tool:")) {
					// A tool-call-only turn.
				} else {
					break;
				}
			}
			if (streak >= 3) {
				alerts.push({
					key: `errors:${r.id}:${r.updatedAt}`,
					sessionId: r.id,
					kind: "repeated_errors",
					summary: `${where} hit ${streak} tool errors in a row (${lastError}) and may be stuck.`,
				});
				continue;
			}
		}
		const ageMs = nowMs - Date.parse(r.updatedAt);
		if (r.status === "working" && Number.isFinite(ageMs) && ageMs >= STALL_MS) {
			const mins = Math.round(ageMs / 60_000);
			alerts.push({
				key: `stalled:${r.id}:${r.updatedAt}`,
				sessionId: r.id,
				kind: "stalled",
				summary: `${where} has been in the same step for ${mins}m${r.task ? ` (task: ${r.task})` : ""}.`,
			});
		}
	}
	return alerts;
}

export function sendInboxMessage(
	profileDir: string,
	msg: Omit<InboxMessage, "id" | "createdAt"> & { id?: string; createdAt?: string },
): InboxMessage {
	const createdAt = msg.createdAt ?? new Date().toISOString();
	const id = msg.id ?? `${createdAt.replace(/[:.]/g, "-")}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	const full: InboxMessage = {
		id,
		from: msg.from,
		fromSessionId: msg.fromSessionId,
		toSessionId: msg.toSessionId,
		text: msg.text,
		createdAt,
	};
	const dir = join(profileDir, "sitra-inbox", safeFileId(msg.toSessionId));
	mkdirSync(dir, { recursive: true });
	const target = join(dir, `${safeFileId(id)}.json`);
	const tmp = `${target}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(full, null, "\t")}\n`);
	renameSync(tmp, target);
	return full;
}

export function drainInbox(profileDir: string, toSessionId: string): InboxMessage[] {
	const dir = join(profileDir, "sitra-inbox", safeFileId(toSessionId));
	if (!existsSync(dir)) return [];
	const out: InboxMessage[] = [];
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".json")) continue;
		const fullPath = join(dir, file);
		try {
			const msg = JSON.parse(readFileSync(fullPath, "utf8")) as InboxMessage;
			rmSync(fullPath, { force: true });
			out.push(msg);
		} catch {
			// Skip unreadable or already-drained files.
		}
	}
	return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function sessionsDir(profileDir: string): string {
	return join(profileDir, "sitra-sessions");
}

function safeFileId(id: string): string {
	return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function recordPath(profileDir: string, id: string): string {
	return join(sessionsDir(profileDir), `${safeFileId(id)}.json`);
}

function defaultPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * The main checkout of the repo this folder is in, even from inside a linked worktree, so every worktree of a repo
 * counts as the same project. Outside git, the folder itself.
 */
export function mainCheckout(cwd: string): string {
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

export function gitBranch(cwd: string): string | undefined {
	try {
		return (
			execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim() || undefined
		);
	} catch {
		return undefined;
	}
}

export function writeSession(profileDir: string, record: SessionRecord): void {
	const dir = sessionsDir(profileDir);
	mkdirSync(dir, { recursive: true });
	const target = recordPath(profileDir, record.id);
	const tmp = `${target}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(record, null, "\t")}\n`);
	renameSync(tmp, target);
}

export function updateSession(
	profileDir: string,
	id: string,
	patch: Partial<SessionRecord>,
): SessionRecord | undefined {
	const target = recordPath(profileDir, id);
	if (!existsSync(target)) return undefined;
	try {
		const current = JSON.parse(readFileSync(target, "utf8")) as SessionRecord;
		const next: SessionRecord = {
			...current,
			...patch,
			updatedAt: patch.updatedAt ?? new Date().toISOString(),
		};
		if (patch.status && patch.status !== "waiting_for_user" && !("waitingFor" in patch)) {
			delete next.waitingFor;
		}
		writeSession(profileDir, next);
		return next;
	} catch {
		return undefined;
	}
}

/** Moves every message waiting in one inbox into another, e.g. when a session's id changes. */
export function moveInbox(profileDir: string, fromSessionId: string, toSessionId: string): void {
	if (fromSessionId === toSessionId) return;
	for (const msg of drainInbox(profileDir, fromSessionId)) sendInboxMessage(profileDir, { ...msg, toSessionId });
}

export function removeSession(profileDir: string, id: string): void {
	rmSync(recordPath(profileDir, id), { force: true });
}

export function listSessions(
	profileDir: string,
	isPidAlive: (pid: number) => boolean = defaultPidAlive,
): SessionRecord[] {
	const dir = sessionsDir(profileDir);
	if (!existsSync(dir)) return [];
	const out: SessionRecord[] = [];
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".json")) continue;
		try {
			const record = JSON.parse(readFileSync(join(dir, file), "utf8")) as SessionRecord;
			if (record.status !== "stopped" && !isPidAlive(record.pid)) {
				record.status = "stopped";
			}
			if (record.sessionFile && existsSync(record.sessionFile)) {
				const mtime = statSync(record.sessionFile).mtime.toISOString();
				if (mtime > record.updatedAt) record.updatedAt = mtime;
			}
			out.push(record);
		} catch {
			// Skip unreadable or mid-cleanup files.
		}
	}
	return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function groupWorkerSessions(
	records: readonly SessionRecord[],
): { lead: SessionRecord; teammates: SessionRecord[] }[] {
	const workers = records.filter((r) => r.role !== "tower");
	const leads = workers.filter((r) => r.role === "lead");
	const teammates = workers.filter((r) => r.role === "teammate");
	const claimed = new Set<string>();
	// A teammate that names its parent belongs to that lead only. Folder and repo are a fallback for teammates that
	// don't, because every worktree of a repo shares one repo value.
	const parentOf = (t: SessionRecord): SessionRecord | undefined => {
		if (t.parentSessionFile) {
			const parent = leads.find((l) => l.sessionFile === t.parentSessionFile);
			if (parent) return parent;
		}
		return leads.find((l) => l.cwd === t.cwd) ?? leads.find((l) => l.repo === t.repo);
	};
	const groups = leads.map((lead) => {
		const children = teammates.filter((t) => parentOf(t) === lead);
		for (const t of children) claimed.add(t.id);
		return { lead, teammates: children };
	});
	for (const orphan of teammates) {
		if (!claimed.has(orphan.id)) groups.push({ lead: orphan, teammates: [] });
	}
	return groups;
}

export function findSession(records: readonly SessionRecord[], query: string): SessionRecord | undefined {
	const q = query.trim().toLowerCase();
	if (!q) return undefined;
	const pool = records.filter((r) => r.role !== "tower");
	return (
		pool.find((r) => r.id.toLowerCase() === q || r.name?.toLowerCase() === q) ??
		pool.find((r) => r.id.toLowerCase().startsWith(q)) ??
		pool.find(
			(r) =>
				r.branch?.toLowerCase().includes(q) ||
				r.cwd.toLowerCase().includes(q) ||
				r.repo.toLowerCase().includes(q) ||
				r.name?.toLowerCase().includes(q),
		)
	);
}

export function formatSessionsReport(records: readonly SessionRecord[]): string {
	const groups = groupWorkerSessions(records);
	if (groups.length === 0) return "No sitra worker sessions are recorded right now.";
	const lines: string[] = [];
	for (const { lead, teammates } of groups) {
		const project = basename(lead.repo || lead.cwd);
		const where = lead.branch ? `${project} (${lead.branch})` : project;
		const wait = lead.waitingFor ? ` — ${lead.waitingFor}` : "";
		const pane = lead.paneId ? ` [pane ${lead.paneId}]` : "";
		lines.push(`- ${where} [${lead.status}${wait}] (id: ${lead.id})${pane}`);
		lines.push(`  cwd: ${lead.cwd}`);
		if (lead.task) lines.push(`  task: ${lead.task}`);
		lines.push(`  updated: ${lead.updatedAt}`);
		for (const tm of teammates) {
			const label = tm.name ? `${tm.name} (${tm.agent ?? "teammate"})` : (tm.agent ?? "teammate");
			const tmTask = tm.task ? ` — ${tm.task}` : "";
			lines.push(`  teammate: ${label} [${tm.status}] (id: ${tm.id})${tmTask}`);
		}
	}
	return lines.join("\n");
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	const tools: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const p = part as { type?: string; text?: string; name?: string };
		if (p.type === "text" && typeof p.text === "string" && p.text.trim()) texts.push(p.text.trim());
		else if (p.type === "toolCall" && typeof p.name === "string") tools.push(p.name);
	}
	const body = texts.join(" ");
	const suffix = tools.length > 0 ? `[tool: ${tools.join(", ")}]` : "";
	return [body, suffix].filter(Boolean).join(" ");
}

/**
 * The last `maxLines` complete lines of a file, read backwards from the end in chunks so a 100 MB transcript costs
 * the same as a small one. Reads at most `maxBytes`; a line cut off by that cap is dropped, never returned in half.
 * A missing or unreadable file gives "".
 */
export function readLastLines(
	file: string,
	maxLines: number,
	options?: { chunkBytes?: number; maxBytes?: number },
): string {
	const chunkBytes = options?.chunkBytes ?? 64 * 1024;
	const maxBytes = options?.maxBytes ?? 8 * 1024 * 1024;
	let fd: number;
	try {
		fd = openSync(file, "r");
	} catch {
		return "";
	}
	try {
		let pos = fstatSync(fd).size;
		const chunks: Buffer[] = [];
		let read = 0;
		let newlines = 0;
		// One newline more than the lines wanted proves the oldest wanted line starts inside what was read.
		while (pos > 0 && read < maxBytes && newlines <= maxLines) {
			const len = Math.min(chunkBytes, pos, maxBytes - read);
			pos -= len;
			const buf = Buffer.alloc(len);
			readSync(fd, buf, 0, len, pos);
			chunks.unshift(buf);
			read += len;
			for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) newlines++;
		}
		let text = Buffer.concat(chunks).toString("utf8");
		if (pos > 0) {
			// Started mid-line: drop the partial first line.
			const firstBreak = text.indexOf("\n");
			text = firstBreak === -1 ? "" : text.slice(firstBreak + 1);
		}
		const lines = text.split("\n");
		if (lines[lines.length - 1] === "") lines.pop();
		return lines.slice(-maxLines).join("\n");
	} catch {
		return "";
	} finally {
		closeSync(fd);
	}
}

/**
 * A `readLastLines` that remembers each file's tail and reads it again only when the file's size or modified time
 * changes, so a refresh loop over idle transcripts touches nothing but `stat`.
 */
export function createTailReader(
	maxLines: number,
	options?: { chunkBytes?: number; maxBytes?: number },
): (file: string) => string {
	const cache = new Map<string, { size: number; mtimeMs: number; text: string }>();
	return (file) => {
		let size: number;
		let mtimeMs: number;
		try {
			({ size, mtimeMs } = statSync(file));
		} catch {
			cache.delete(file);
			return "";
		}
		const hit = cache.get(file);
		if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.text;
		const text = readLastLines(file, maxLines, options);
		cache.set(file, { size, mtimeMs, text });
		return text;
	};
}

export function readTranscriptTail(jsonl: string, maxItems = 8): TranscriptItem[] {
	const items: TranscriptItem[] = [];
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as {
				type?: string;
				customType?: string;
				content?: unknown;
				message?: {
					role?: string;
					toolName?: string;
					isError?: boolean;
					content?: unknown;
				};
			};
			if (entry.type === "custom_message" && entry.content) {
				const text = extractText(entry.content);
				if (text) items.push({ role: "custom", text });
				continue;
			}
			if (entry.type !== "message" || !entry.message) continue;
			const msg = entry.message;
			if (msg.role === "user") {
				const text = extractText(msg.content);
				if (text) items.push({ role: "user", text });
			} else if (msg.role === "assistant") {
				const text = extractText(msg.content);
				if (text) items.push({ role: "assistant", text });
			} else if (msg.role === "toolResult") {
				const tool = msg.toolName ?? "tool";
				if (msg.isError) {
					const text = extractText(msg.content).split("\n")[0] || "failed";
					items.push({ role: "tool", text: `${tool} error: ${text}`, error: true });
				} else {
					items.push({ role: "tool", text: `${tool} ok`, error: false });
				}
			}
		} catch {
			// Skip malformed lines.
		}
	}
	return items.slice(-maxItems);
}

export interface PreparedWorktree {
	primaryRepo: string;
	worktreePath: string;
	branch: string;
	baseRef: string;
	copiedEnvFiles: string[];
}

export function groundingPrompt(userName?: string, extraInstructions?: string): string {
	const who = userName?.trim() || "the user";
	const extra = extraInstructions?.trim() ? ` Additional context from ${who}: ${extraInstructions.trim()}` : "";
	return `Read AGENTS.md, CLAUDE.md, any project steering index, and Grimoire (the root and catalogue in your prompt) so you are grounded in this codebase and how ${who} works. Do not edit code or start a task yet.${extra} Reply in two short lines confirming which docs and rules you loaded and that you are ready for ${who} to drive.`;
}

export function spawnPaneCommand(grounding: string): string {
	return `pnpm i && pnpm run build && sitra ${shellQuote(grounding)}`;
}

const SKIP_ENV_DIRS = new Set(["node_modules", "dist", "build", "coverage", "out"]);

export function findRepoEnvFiles(primaryRepo: string): string[] {
	const found: string[] = [];
	const walk = (rel: string, depth: number) => {
		if (depth > 3) return;
		const dir = rel ? join(primaryRepo, rel) : primaryRepo;
		try {
			for (const e of readdirSync(dir, { withFileTypes: true })) {
				const name = e.name;
				const sub = rel ? `${rel}/${name}` : name;
				if (e.isDirectory()) {
					if (name.startsWith(".") || SKIP_ENV_DIRS.has(name)) continue;
					walk(sub, depth + 1);
				} else if (
					e.isFile() &&
					/^\.env(\.[a-zA-Z0-9._-]+)?$/.test(name) &&
					!/\.(example|sample|template)$/i.test(name)
				) {
					found.push(sub);
				}
			}
		} catch {
			return;
		}
	};
	walk("", 0);
	return found.sort();
}

export function prepareWorktree(options: {
	repo: string;
	branch: string;
	base: string;
	slug?: string;
}): PreparedWorktree {
	const primaryRepo = mainCheckout(options.repo);
	const branch = options.branch.trim();
	const rawSlug = options.slug?.trim() || branch.replace(/^[^/]+\//, "");
	const slug = rawSlug.replace(/[^a-zA-Z0-9._-]/g, "-");
	if (!branch || !slug) throw new Error("A branch name is required to create a worktree.");

	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: primaryRepo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	const refExists = (ref: string): boolean => {
		try {
			git("show-ref", "--verify", "--quiet", ref);
			return true;
		} catch {
			return false;
		}
	};

	const baseBranch = options.base.trim().replace(/^origin\//, "");
	try {
		git("fetch", "origin", baseBranch);
	} catch {
		// Offline or local-only repo without origin; fall back to local refs.
	}
	const baseRef = refExists(`refs/remotes/origin/${baseBranch}`)
		? `origin/${baseBranch}`
		: refExists(`refs/heads/${baseBranch}`)
			? baseBranch
			: options.base.trim();

	const worktreePath = join(primaryRepo, ".worktrees", slug);
	if (existsSync(worktreePath)) {
		throw new Error(`Worktree already exists at ${worktreePath}; choose a new branch or slug.`);
	}
	mkdirSync(join(primaryRepo, ".worktrees"), { recursive: true });
	if (refExists(`refs/heads/${branch}`)) {
		git("worktree", "add", worktreePath, branch);
	} else {
		git("worktree", "add", "--no-track", "-b", branch, worktreePath, baseRef);
	}

	const envFiles = findRepoEnvFiles(primaryRepo);
	const copiedEnvFiles: string[] = [];
	for (const rel of envFiles) {
		const src = join(primaryRepo, rel);
		const dst = join(worktreePath, rel);
		mkdirSync(dirname(dst), { recursive: true });
		copyFileSync(src, dst);
		chmodSync(dst, 0o600);
		copiedEnvFiles.push(rel);
	}
	if (!copiedEnvFiles.includes("caller/.env") && existsSync(join(primaryRepo, "caller", ".env.example"))) {
		const dst = join(worktreePath, "caller", ".env.example");
		const target = join(worktreePath, "caller", ".env");
		if (!existsSync(target) && existsSync(dst)) {
			copyFileSync(dst, target);
			chmodSync(target, 0o600);
			copiedEnvFiles.push("caller/.env");
		}
	}

	return { primaryRepo, worktreePath, branch, baseRef, copiedEnvFiles };
}
