/**
 * Session registry: every sitra session (worker lead, teammate, or tower) records its live status in
 * `<PI_CODING_AGENT_DIR>/sitra-sessions/<id>.json` so the tower can see every session across all projects and worktrees.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

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
	waitingFor?: string;
	task?: string;
	startedAt: string;
	updatedAt: string;
}

export interface TranscriptItem {
	role: "user" | "assistant" | "tool" | "custom";
	text: string;
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
			if (item.role !== "tool") continue;
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
			let streak = 0;
			let lastError = "";
			for (let i = tail.length - 1; i >= 0; i--) {
				if (tail[i]?.role === "tool") {
					streak++;
					if (!lastError) lastError = tail[i]?.text ?? "";
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
	const groups = leads.map((lead) => {
		const children = teammates.filter((t) => {
			if (claimed.has(t.id)) return false;
			const match =
				(Boolean(t.parentSessionFile) && t.parentSessionFile === lead.sessionFile) ||
				t.cwd === lead.cwd ||
				t.repo === lead.repo;
			if (match) claimed.add(t.id);
			return match;
		});
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
			} else if (msg.role === "toolResult" && msg.isError) {
				const text = extractText(msg.content).split("\n")[0] ?? "failed";
				items.push({ role: "tool", text: `${msg.toolName ?? "tool"} error: ${text}` });
			}
		} catch {
			// Skip malformed lines.
		}
	}
	return items.slice(-maxItems);
}
