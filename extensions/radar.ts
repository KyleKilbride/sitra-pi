/** Live, keyboard-driven workspace dashboard with read-only mailbox and run logs. */
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { grimoireDir, listProposals } from "./grimoire.ts";
import { initialRadarState, type RadarState, type TowerSummary } from "./radar-model.ts";
import { collectMail, readTowerSummary } from "./radar-store.ts";
import { buildRadarLayout } from "./radar-view.ts";
import { readRun, readRunHeader } from "./runs.ts";
import {
	createTailReader,
	detectSessionAlerts,
	gitBranch,
	groupWorkerSessions,
	listSessions,
	mainCheckout,
	readLastLines,
	readTranscriptTail,
	type SessionAlert,
	type SessionRecord,
} from "./sessions.ts";

export type VisualState = "working" | "waiting_for_user" | "error_loop" | "idle" | "stopped";

export interface MailItem {
	id: string;
	peer: string;
	direction: "in" | "out";
	/** Deprecated compatibility field: old adapters used this as the row's subject. */
	summary: string;
	subject?: string;
	preview?: string;
	state: string;
	delivery?: {
		confirmed?: boolean;
		status?: string;
	};
	body?: string;
	updatedAt: string;
	/** True when `updatedAt` is only when the dashboard first saw the message, not when it was sent or received. */
	dateApproximate?: boolean;
}

export type RunState = "running" | "passed" | "failed" | "stopped" | "unknown";
export type RunLiveness = "running" | "stopped" | "unknown";
export interface RunProcessIdentity {
	kind: "proc" | "ps-lstart";
	value: string;
}

export interface RunSummary {
	id: string;
	label: string;
	state: RunState;
	project?: string;
	branch?: string;
	agent?: string;
	sessionId?: string;
	tail?: string;
	done: boolean;
	exitCode?: number;
	updatedAt: string;
}

export interface PullRequestSummary {
	id: string;
	project: string;
	number: number;
	title: string;
	branch?: string;
	url?: string;
	isDraft?: boolean;
}

export interface WorkerCard {
	index: number;
	title: string;
	subtitle?: string;
	workspaceId?: string;
	tabId?: string;
	harness?: string;
	lead: SessionRecord;
	teammates: SessionRecord[];
	activeHelpers: number;
	visualState: VisualState;
	nowLine?: string;
	lastLine?: string;
	lastAction?: string;
	activity: number[];
}

export interface RadarSnapshot {
	towerName: string;
	workers: WorkerCard[];
	alerts: SessionAlert[];
	runs: RunSummary[];
	pullRequests?: PullRequestSummary[];
	statusNotices?: string[];
	pendingProposals: number;
	mail: MailItem[];
	mailNotice?: string;
	summary?: TowerSummary;
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const ANSI_TOKEN_PATTERN = new RegExp(`(${String.fromCharCode(27)}\\[[0-9;]*m)`, "g");

export function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

/** Terminal cell width of a single Unicode code point (accounts for 2-column emojis and CJK). */
export function charWidth(cp: number): number {
	if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
	if (cp >= 0x0300 && cp <= 0x036f) return 0;
	if (cp >= 0xfe00 && cp <= 0xfe0f) return 0;
	if (cp >= 0x2500 && cp <= 0x25ff) return 1;
	if (cp >= 0x2800 && cp <= 0x28ff) return 1;
	if (cp === 0x2605 || cp === 0x2713 || cp === 0x2716 || cp === 0x2717 || cp === 0x2726 || cp === 0x2756) return 1;
	if (cp >= 0x2190 && cp <= 0x21ff) return 1;
	if (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x231a && cp <= 0x23ff) ||
		(cp >= 0x2600 && cp <= 0x27bf) ||
		(cp >= 0x2e80 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe10 && cp <= 0xfe6f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		cp >= 0x1f000
	) {
		return 2;
	}
	return 1;
}

export function visibleWidth(text: string): number {
	let w = 0;
	for (const ch of stripAnsi(text)) {
		w += charWidth(ch.codePointAt(0) ?? 0);
	}
	return w;
}

/**
 * Pads or truncates a single-line ANSI string to an exact terminal cell width while preserving color codes
 * and never splitting a 2-column character across the right edge.
 */
export function fitAnsi(text: string, width: number): string {
	if (width <= 0) return "";
	const sanitized = text.replace(/[\r\n\t]+/g, " ");
	const total = visibleWidth(sanitized);
	if (total <= width) {
		return sanitized + " ".repeat(width - total);
	}
	const target = Math.max(1, width - 1);
	const tokens = sanitized.split(ANSI_TOKEN_PATTERN);
	let out = "";
	let used = 0;
	let hasAnsi = false;
	for (const tok of tokens) {
		if (!tok) continue;
		if (tok.startsWith("\x1b[")) {
			out += tok;
			hasAnsi = true;
			continue;
		}
		for (const ch of tok) {
			const cw = charWidth(ch.codePointAt(0) ?? 0);
			if (used + cw > target) {
				return `${out}${hasAnsi ? "\x1b[0m" : ""}…${" ".repeat(Math.max(0, width - used - 1))}`;
			}
			out += ch;
			used += cw;
		}
	}
	return `${out}${hasAnsi ? "\x1b[0m" : ""}${" ".repeat(Math.max(0, width - used))}`;
}

const fg = (r: number, g: number, b: number, s: string) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

function cleanMarkdown(text: string): string {
	return text
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/^#+\s*/gm, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** How many transcript lines the radar reads from the end of each session file; nothing older is ever needed. */
export const TRANSCRIPT_TAIL_LINES = 200;

function readTranscriptInsights(
	readLines: (file: string) => string,
	sessionFile: string | undefined,
	nowMs: number,
	status: string,
): {
	nowLine?: string;
	lastLine?: string;
	lastAction?: string;
	activity: number[];
} {
	const buckets: number[] = [0, 0, 0, 0, 0, 0, 0, 0];
	if (!sessionFile || !existsSync(sessionFile)) {
		if (status === "working") buckets[7] = 2;
		return { activity: buckets };
	}
	try {
		const raw = readLines(sessionFile);
		const tail = readTranscriptTail(raw, 6);
		const last = tail[tail.length - 1];
		const lastAction = last ? `${last.role}: ${last.text}` : undefined;
		const lines = raw.split("\n");
		const windowMs = 12 * 60_000;
		let nowLine: string | undefined;
		let lastLine: string | undefined;

		for (let i = Math.max(0, lines.length - 100); i < lines.length; i++) {
			const line = lines[i]?.trim();
			if (!line) continue;
			const tsMatch = /"timestamp":"([^"]+)"/.exec(line);
			if (tsMatch?.[1]) {
				const age = nowMs - Date.parse(tsMatch[1]);
				if (Number.isFinite(age) && age >= 0 && age <= windowMs) {
					const idx = Math.min(7, Math.max(0, 7 - Math.floor((age / windowMs) * 8)));
					buckets[idx] = (buckets[idx] ?? 0) + 1;
				}
			}
			try {
				const entry = JSON.parse(line) as {
					type?: string;
					message?: { role?: string; content?: unknown };
				};
				if (entry.type !== "message" || !entry.message) continue;
				if (entry.message.role === "user") {
					if (nowLine?.startsWith("Asking you:")) nowLine = undefined;
					continue;
				}
				if (entry.message.role !== "assistant") continue;
				const content = entry.message.content;
				if (!Array.isArray(content)) continue;
				for (const part of content) {
					if (!part || typeof part !== "object") continue;
					const p = part as { type?: string; thinking?: string; text?: string; name?: string; arguments?: unknown };
					if (p.type === "thinking" && typeof p.thinking === "string") {
						const m = /^\*\*([^*]+)\*\*\s*(.*)/s.exec(p.thinking.trim());
						if (m?.[1]) {
							const firstSentence = m[2]?.trim().split(/\.\s|\n/)[0] ?? "";
							nowLine = firstSentence
								? `${cleanMarkdown(m[1])} — ${cleanMarkdown(firstSentence)}`
								: cleanMarkdown(m[1]);
						}
					} else if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
						for (const rawLine of p.text.trim().split("\n")) {
							const trimmed = rawLine.trim();
							if (!trimmed || trimmed.startsWith("---") || trimmed.startsWith("|")) continue;
							lastLine = cleanMarkdown(trimmed);
							break;
						}
					} else if (p.type === "toolCall" && p.name === "ask_user_question" && status === "waiting_for_user") {
						const args = p.arguments as { questions?: { header?: string; question?: string }[] } | undefined;
						const q = args?.questions?.[0];
						if (q?.question) {
							nowLine = `Asking you: ${cleanMarkdown(q.question.split("\n")[0] ?? q.question)}`;
						}
					}
				}
			} catch {
				// Ignore non-JSON lines.
			}
		}
		if (status === "working" && buckets.every((b) => !b)) {
			buckets[6] = 1;
			buckets[7] = 3;
		}
		return {
			...(nowLine ? { nowLine } : {}),
			...(lastLine ? { lastLine } : {}),
			...(lastAction ? { lastAction } : {}),
			activity: buckets,
		};
	} catch {
		return { activity: buckets };
	}
}

/** A run with no recorded owner and no output for this long is assumed dead. */
const LEGACY_RUN_STALE_MS = 15 * 60_000;

function readFirstLine(file: string): string {
	const fd = openSync(file, "r");
	try {
		const buffer = Buffer.alloc(2048);
		const read = readSync(fd, buffer, 0, buffer.length, 0);
		return buffer.toString("utf8", 0, read).split("\n")[0] ?? "";
	} finally {
		closeSync(fd);
	}
}

function procPidStart(pid: number): string | undefined {
	if (process.platform !== "linux") return undefined;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const end = stat.lastIndexOf(") ");
		if (end < 0) return undefined;
		// Field 22 is starttime. After the comm field, token 0 is field 3 (`state`).
		return stat
			.slice(end + 2)
			.trim()
			.split(/\s+/)[19];
	} catch {
		return undefined;
	}
}

function psPidStart(pid: number): string | undefined {
	try {
		const value = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
			timeout: 1000,
			stdio: ["ignore", "pipe", "ignore"],
		})
			.trim()
			.replace(/\s+/g, " ");
		return value || undefined;
	} catch {
		return undefined;
	}
}

function processLiveness(pid: number, identity?: RunProcessIdentity): RunLiveness {
	try {
		process.kill(pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPERM") return "stopped";
	}
	if (!identity) return "unknown";
	const currentStart = identity.kind === "proc" ? procPidStart(pid) : psPidStart(pid);
	if (currentStart === undefined) return "unknown";
	return currentStart === identity.value ? "running" : "stopped";
}

function runIdentity(
	header: { pidStart?: string; pidStartKind?: "proc" | "ps-lstart" } | undefined,
): RunProcessIdentity | undefined {
	if (!header?.pidStart || !header.pidStartKind) return undefined;
	return { kind: header.pidStartKind, value: header.pidStart };
}

function normalizeLiveness(value: RunLiveness | boolean): RunLiveness {
	if (value === true) return "running";
	if (value === false) return "stopped";
	return value;
}

function unfinishedRunState(
	header: { pid: number; pidStart?: string; pidStartKind?: "proc" | "ps-lstart" } | undefined,
	mtimeMs: number,
	nowMs: number,
	pidAlive: (pid: number, identity?: RunProcessIdentity) => RunLiveness | boolean,
): RunState {
	if (!header) return nowMs - mtimeMs < LEGACY_RUN_STALE_MS ? "running" : "stopped";
	const identity = runIdentity(header);
	if (!identity) return "unknown";
	return normalizeLiveness(pidAlive(header.pid, identity));
}

function sortRunGroup(state: RunState): number {
	switch (state) {
		case "running":
			return 0;
		case "unknown":
			return 1;
		default:
			return 2;
	}
}

function collectRuns(
	profileDir: string,
	nowMs: number,
	pidAlive: (pid: number, identity?: RunProcessIdentity) => RunLiveness | boolean,
): RunSummary[] {
	const dir = join(profileDir, "runs");
	if (!existsSync(dir)) return [];
	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".log"))
		.sort()
		.reverse()
		.slice(0, 30);
	const runs = files.flatMap((file): RunSummary[] => {
		try {
			const full = join(dir, file);
			const firstLine = readFirstLine(full);
			const status = readRun(`${firstLine}\n${readLastLines(full, 100)}`, 80);
			const header = readRunHeader(firstLine);
			const mtimeMs = statSync(full).mtimeMs;
			const label =
				header?.meta.label ?? file.replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-/, "").replace(/\.log$/, "");
			const state: RunState = status.done
				? status.exitCode === 0
					? "passed"
					: "failed"
				: unfinishedRunState(header, mtimeMs, nowMs, pidAlive);
			return [{
				id: full,
				label,
				state,
				...(header?.meta.project ? { project: header.meta.project } : {}),
				...(header?.meta.branch ? { branch: header.meta.branch } : {}),
				...(header?.meta.agent ? { agent: header.meta.agent } : {}),
				...(header?.meta.sessionId ? { sessionId: header.meta.sessionId } : {}),
				tail: status.tail,
				done: status.done,
				...(status.exitCode !== undefined ? { exitCode: status.exitCode } : {}),
				updatedAt: new Date(mtimeMs).toISOString(),
			}];
		} catch (error) {
			if ((error as { code?: unknown }).code === "ENOENT") return [];
			const full = join(dir, file);
			return [{
				id: full,
				label: file.replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-/, "").replace(/\.log$/, ""),
				state: "unknown",
				tail: `Run log error: ${String(error)}`,
				done: false,
				updatedAt: new Date(nowMs).toISOString(),
			}];
		}
	});
	// Live runs first so "who is running what" is the top of the list; unknowns stay visible just below them.
	return runs.toSorted(
		(a, b) => sortRunGroup(a.state) - sortRunGroup(b.state) || b.updatedAt.localeCompare(a.updatedAt),
	);
}

function collectOpenPullRequests(repos: readonly string[]): { items: PullRequestSummary[]; notices: string[] } {
	const items: PullRequestSummary[] = [];
	const notices: string[] = [];
	const seenRepos = new Set<string>();
	for (const repo of repos) {
		if (seenRepos.has(repo) || !existsSync(repo)) continue;
		seenRepos.add(repo);
		const project = basename(repo);
		try {
			const raw = execFileSync(
				"gh",
				["pr", "list", "--state", "open", "--limit", "20", "--json", "number,title,headRefName,isDraft,url"],
				{ cwd: repo, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "pipe"] },
			);
			const parsed = JSON.parse(raw) as {
				number?: unknown;
				title?: unknown;
				headRefName?: unknown;
				isDraft?: unknown;
				url?: unknown;
			}[];
			for (const pr of parsed) {
				if (typeof pr.number !== "number" || typeof pr.title !== "string") continue;
				items.push({
					id: `${project}#${pr.number}`,
					project,
					number: pr.number,
					title: pr.title.slice(0, 200),
					...(typeof pr.headRefName === "string" ? { branch: pr.headRefName.slice(0, 200) } : {}),
					...(typeof pr.url === "string" ? { url: pr.url } : {}),
					...(typeof pr.isDraft === "boolean" ? { isDraft: pr.isDraft } : {}),
				});
			}
		} catch {
			notices.push(`Open PRs unavailable for ${project}; gh pr list failed.`);
		}
	}
	return { items, notices };
}

interface HerdrWorkspaceMeta {
	workspaceId: string;
	tabId?: string;
	number: number;
	name: string;
	tabLabel?: string;
	agentStatus?: string;
	harness?: string;
	activeSubagents: number;
	terminalTitle?: string;
	cwd?: string;
	sessionFile?: string;
	paneId?: string;
	allSessionFiles: string[];
	allPaneIds: string[];
}

function stripNumberPrefix(label: string): string {
	return label.replace(/^\[\d+\]\s*/, "").trim();
}

function cleanTabLabel(label: string | undefined): string | undefined {
	if (!label) return undefined;
	return stripNumberPrefix(label)
		.replace(/\s*›\s*(pi|claude)$/i, "")
		.trim();
}

function queryHerdrWorkspaces(
	towerSessionFile: string | undefined,
	teammateSessionFiles: ReadonlySet<string>,
	teammatePaneIds: ReadonlySet<string>,
): HerdrWorkspaceMeta[] {
	if (process.env.HERDR_ENV !== "1") return [];
	try {
		const run = (args: string[]) =>
			JSON.parse(execFileSync("herdr", args, { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }))
				.result;
		const workspaces = (run(["workspace", "list"])?.workspaces ?? []) as {
			workspace_id: string;
			number: number;
			label: string;
			active_tab_id?: string;
			agent_status?: string;
		}[];
		const tabs = new Map<string, string>(
			((run(["tab", "list"])?.tabs ?? []) as { tab_id: string; label: string }[]).map((t) => [t.tab_id, t.label]),
		);
		const agents = (run(["agent", "list"])?.agents ?? []) as {
			workspace_id: string;
			tab_id?: string;
			pane_id?: string;
			agent?: string;
			agent_status?: string;
			cwd?: string;
			terminal_title_stripped?: string;
			agent_session?: { value?: string };
			tokens?: { pi_subagents_work_v1?: string };
		}[];

		const out: HerdrWorkspaceMeta[] = [];
		for (const ws of workspaces) {
			const wsName = stripNumberPrefix(ws.label);
			const wsAgents = agents.filter((a) => a.workspace_id === ws.workspace_id);
			if (wsName.toLowerCase() === "tower") continue;
			if (towerSessionFile && wsAgents.some((a) => a.agent_session?.value === towerSessionFile)) continue;
			if (wsAgents.length === 0) continue;

			const isTeammateAgent = (a: (typeof wsAgents)[number]): boolean => {
				if (a.agent_session?.value && teammateSessionFiles.has(a.agent_session.value)) return true;
				if (a.pane_id && teammatePaneIds.has(a.pane_id)) return true;
				const tLabel = a.tab_id ? stripNumberPrefix(tabs.get(a.tab_id) ?? "") : "";
				return /^\[[a-z0-9_-]+\]/i.test(tLabel);
			};
			const leadCandidates = wsAgents.filter((a) => !isTeammateAgent(a));
			const pool = leadCandidates.length > 0 ? leadCandidates : wsAgents;

			const primary =
				pool.find((a) => a.tab_id === ws.active_tab_id) ??
				pool.find((a) => a.agent_status === "working" || a.agent_status === "blocked") ??
				pool[0];
			if (!primary) continue;

			let activeSubagents = 0;
			const token = primary.tokens?.pi_subagents_work_v1;
			if (token) {
				const parts = token.split(":");
				const count = Number(parts[1]);
				if (Number.isFinite(count) && count > 0) activeSubagents = count;
			}
			const tabLabel = cleanTabLabel(primary.tab_id ? tabs.get(primary.tab_id) : undefined);
			out.push({
				workspaceId: ws.workspace_id,
				...(primary.tab_id ? { tabId: primary.tab_id } : {}),
				number: ws.number,
				name: wsName,
				...(tabLabel ? { tabLabel } : {}),
				...(primary.agent_status ? { agentStatus: primary.agent_status } : {}),
				...(primary.agent ? { harness: primary.agent } : {}),
				activeSubagents,
				...(primary.terminal_title_stripped ? { terminalTitle: primary.terminal_title_stripped } : {}),
				...(primary.cwd ? { cwd: primary.cwd } : {}),
				...(primary.agent_session?.value ? { sessionFile: primary.agent_session.value } : {}),
				...(primary.pane_id ? { paneId: primary.pane_id } : {}),
				allSessionFiles: wsAgents.map((a) => a.agent_session?.value).filter((v): v is string => Boolean(v)),
				allPaneIds: wsAgents.map((a) => a.pane_id).filter((v): v is string => Boolean(v)),
			});
		}
		return out.sort((a, b) => a.number - b.number);
	} catch {
		return [];
	}
}

export function collectRadarSnapshot(
	profileDir: string,
	options?: {
		nowMs?: number;
		towerName?: string;
		includeHerdr?: boolean;
		includePullRequests?: boolean;
		listPullRequests?: (repos: string[]) => PullRequestSummary[];
		readLines?: (file: string) => string;
		pidAlive?: (pid: number, identity?: RunProcessIdentity) => RunLiveness | boolean;
	},
): RadarSnapshot {
	const nowMs = options?.nowMs ?? Date.now();
	const towerName = options?.towerName?.trim() || process.env.SITRA_TOWER_NAME?.trim() || "Tower";
	const baseSessions = listSessions(profileDir);
	const towerRecord = baseSessions.find((s) => s.role === "tower");
	const readLines = options?.readLines ?? createTailReader(TRANSCRIPT_TAIL_LINES);
	const readTail = (file: string) => (existsSync(file) ? readTranscriptTail(readLines(file), 8) : []);
	const alerts = detectSessionAlerts(baseSessions, readTail, nowMs);
	const errorLoopIds = new Set(alerts.filter((a) => a.kind === "repeated_errors").map((a) => a.sessionId));
	const groups = groupWorkerSessions(baseSessions);

	const teammateSessionFiles = new Set(
		baseSessions
			.filter((s) => s.role === "teammate")
			.map((s) => s.sessionFile)
			.filter((v): v is string => Boolean(v)),
	);
	const teammatePaneIds = new Set(
		baseSessions
			.filter((s) => s.role === "teammate")
			.map((s) => s.paneId)
			.filter((v): v is string => Boolean(v)),
	);
	const herdrWorkspaces = options?.includeHerdr
		? queryHerdrWorkspaces(towerRecord?.sessionFile, teammateSessionFiles, teammatePaneIds)
		: [];
	const workers: WorkerCard[] = [];
	const claimedLeadIds = new Set<string>();

	if (herdrWorkspaces.length > 0) {
		for (const ws of herdrWorkspaces) {
			const matchedGroup = groups.find(
				(g) =>
					(g.lead.sessionFile && ws.allSessionFiles.includes(g.lead.sessionFile)) ||
					(g.lead.paneId && ws.allPaneIds.includes(g.lead.paneId)) ||
					g.teammates.some(
						(t) =>
							(t.sessionFile && ws.allSessionFiles.includes(t.sessionFile)) ||
							(t.paneId && ws.allPaneIds.includes(t.paneId)),
					),
			);
			if (matchedGroup) claimedLeadIds.add(matchedGroup.lead.id);
			const cwd = ws.cwd ?? matchedGroup?.lead.cwd ?? process.cwd();
			const sessionFile =
				matchedGroup?.lead.sessionFile ?? (ws.sessionFile?.endsWith(".jsonl") ? ws.sessionFile : undefined);
			const mtime =
				sessionFile && existsSync(sessionFile)
					? statSync(sessionFile).mtime.toISOString()
					: new Date(nowMs).toISOString();
			const status =
				ws.agentStatus === "blocked" || matchedGroup?.lead.status === "waiting_for_user"
					? "waiting_for_user"
					: ws.agentStatus === "working" || ws.activeSubagents > 0 || matchedGroup?.lead.status === "working"
						? "working"
						: matchedGroup?.lead.status === "stopped"
							? "stopped"
							: "idle";
			const lead: SessionRecord = matchedGroup?.lead
				? {
						...matchedGroup.lead,
						status,
						updatedAt: mtime > matchedGroup.lead.updatedAt ? mtime : matchedGroup.lead.updatedAt,
					}
				: {
						id: `ws-${ws.number}`,
						role: "lead",
						pid: process.pid,
						cwd,
						repo: mainCheckout(cwd),
						...(gitBranch(cwd) ? { branch: gitBranch(cwd) } : {}),
						...(sessionFile ? { sessionFile } : {}),
						...(ws.paneId ? { paneId: ws.paneId } : {}),
						status,
						startedAt: mtime,
						updatedAt: mtime,
					};
			const visualState: VisualState = errorLoopIds.has(lead.id)
				? "error_loop"
				: status === "waiting_for_user"
					? "waiting_for_user"
					: status === "working"
						? "working"
						: status === "stopped"
							? "stopped"
							: "idle";
			const insights = readTranscriptInsights(readLines, sessionFile, nowMs, status);
			const teammates = matchedGroup?.teammates ?? [];
			const activeHelpers = Math.max(ws.activeSubagents, teammates.filter((t) => t.status === "working").length);
			workers.push({
				index: ws.number,
				title: ws.name,
				...(ws.tabLabel && ws.tabLabel.toLowerCase() !== ws.name.toLowerCase() ? { subtitle: ws.tabLabel } : {}),
				workspaceId: ws.workspaceId,
				...(ws.tabId ? { tabId: ws.tabId } : {}),
				...(ws.harness ? { harness: ws.harness } : {}),
				lead,
				teammates,
				activeHelpers,
				visualState,
				...(insights.nowLine
					? { nowLine: insights.nowLine }
					: ws.terminalTitle && !ws.terminalTitle.startsWith("π -")
						? { nowLine: ws.terminalTitle }
						: {}),
				...(insights.lastLine ? { lastLine: insights.lastLine } : {}),
				...(insights.lastAction ? { lastAction: insights.lastAction } : {}),
				activity: insights.activity,
			});
		}
		for (const g of groups) {
			if (claimedLeadIds.has(g.lead.id)) continue;
			const visualState: VisualState = errorLoopIds.has(g.lead.id)
				? "error_loop"
				: g.lead.status === "waiting_for_user"
					? "waiting_for_user"
					: g.lead.status === "working"
						? "working"
						: g.lead.status === "stopped"
							? "stopped"
							: "idle";
			const insights = readTranscriptInsights(readLines, g.lead.sessionFile, nowMs, g.lead.status);
			const nextIndex = Math.max(0, ...workers.map((w) => w.index)) + 1;
			workers.push({
				index: nextIndex,
				title: basename(g.lead.repo || g.lead.cwd),
				...(g.lead.branch ? { subtitle: g.lead.branch } : {}),
				lead: g.lead,
				teammates: g.teammates,
				activeHelpers: g.teammates.filter((t) => t.status === "working").length,
				visualState,
				...(insights.nowLine ? { nowLine: insights.nowLine } : {}),
				...(insights.lastLine ? { lastLine: insights.lastLine } : {}),
				...(insights.lastAction ? { lastAction: insights.lastAction } : {}),
				activity: insights.activity,
			});
		}
	} else {
		for (let i = 0; i < groups.length; i++) {
			const g = groups[i];
			if (!g) continue;
			const visualState: VisualState = errorLoopIds.has(g.lead.id)
				? "error_loop"
				: g.lead.status === "waiting_for_user"
					? "waiting_for_user"
					: g.lead.status === "working"
						? "working"
						: g.lead.status === "stopped"
							? "stopped"
							: "idle";
			const insights = readTranscriptInsights(readLines, g.lead.sessionFile, nowMs, g.lead.status);
			workers.push({
				index: i + 1,
				title: basename(g.lead.repo || g.lead.cwd),
				...(g.lead.branch ? { subtitle: g.lead.branch } : {}),
				lead: g.lead,
				teammates: g.teammates,
				activeHelpers: g.teammates.filter((t) => t.status === "working").length,
				visualState,
				...(insights.nowLine ? { nowLine: insights.nowLine } : {}),
				...(insights.lastLine ? { lastLine: insights.lastLine } : {}),
				...(insights.lastAction ? { lastAction: insights.lastAction } : {}),
				activity: insights.activity,
			});
		}
	}

	let pendingProposals = 0;
	try {
		pendingProposals = listProposals(grimoireDir({ ...process.env, PI_CODING_AGENT_DIR: profileDir })).length;
	} catch {
		// An unreadable Grimoire just shows nothing to review.
	}
	const runSummaries = collectRuns(profileDir, nowMs, options?.pidAlive ?? processLiveness);
	const repos = Array.from(
		new Set(
			workers
				.map((w) => w.lead.repo || w.lead.cwd)
				.filter((repo): repo is string => Boolean(repo))
				.map((repo) => mainCheckout(repo)),
		),
	);
	const pullRequestResult = options?.listPullRequests
		? { items: options.listPullRequests(repos), notices: [] }
		: options?.includePullRequests
			? collectOpenPullRequests(repos)
			: { items: [], notices: [] };

	return {
		towerName,
		workers,
		alerts,
		runs: runSummaries,
		...(pullRequestResult.items.length > 0 ? { pullRequests: pullRequestResult.items } : {}),
		...(pullRequestResult.notices.length > 0 ? { statusNotices: pullRequestResult.notices } : {}),
		pendingProposals,
		mail: collectMail(profileDir),
		summary: readTowerSummary(profileDir),
	};
}

export function drawBox(
	title: string,
	rightTag: string,
	bodyLines: readonly string[],
	cols: number,
	borderRgb: [number, number, number],
): string[] {
	const w = Math.max(20, cols);
	const inner = w - 2;
	const color = (s: string) => fg(borderRgb[0], borderRgb[1], borderRgb[2], s);

	const rawTitle = stripAnsi(title).replace(/[\r\n\t]+/g, " ");
	const rawRight = rightTag ? stripAnsi(rightTag).replace(/[\r\n\t]+/g, " ") : "";
	let leftTab = `┤ ${rawTitle} ├`;
	let rightTab = rawRight ? `┤ ${rawRight} ├` : "";

	if (visibleWidth(leftTab) + visibleWidth(rightTab) + 1 > inner) {
		rightTab = "";
	}
	if (visibleWidth(leftTab) > inner) {
		leftTab = fitAnsi(rawTitle, inner);
	}
	const dashes = Math.max(0, inner - visibleWidth(leftTab) - visibleWidth(rightTab));
	const topInner = `${color("┤ ")}${bold(fg(220, 250, 255, fitAnsi(rawTitle, visibleWidth(leftTab) - 4)))}${color(
		" ├",
	)}${color("─".repeat(dashes))}${rightTab ? `${color("┤ ")}${fg(155, 220, 240, rawRight)}${color(" ├")}` : ""}`;
	const top =
		visibleWidth(leftTab) === inner && !leftTab.startsWith("┤")
			? `${color("╭")}${bold(fg(220, 250, 255, leftTab))}${color("╮")}`
			: `${color("╭")}${topInner}${color("╮")}`;
	const mid = bodyLines.map((line) => `${color("│")}${fitAnsi(line, inner)}${color("│")}`);
	const bot = `${color("╰")}${color("─".repeat(inner))}${color("╯")}`;
	return [top, ...mid, bot];
}

export function statusBadge(state: VisualState, activeHelpers = 0): string {
	const helperNote = activeHelpers > 0 ? ` +${activeHelpers} helper${activeHelpers === 1 ? "" : "s"}` : "";
	switch (state) {
		case "working":
			return fg(65, 255, 175, bold(`● WORKING${helperNote}`));
		case "waiting_for_user":
			return fg(255, 205, 55, bold("▲ NEEDS YOU"));
		case "error_loop":
			return fg(255, 80, 95, bold("✖ STUCK IN LOOP"));
		case "stopped":
			return fg(130, 140, 155, "◌ STOPPED");
		default:
			return fg(140, 180, 230, "○ IDLE");
	}
}

/** Render one bounded frame, with controls and the tower summary pinned below the scrollable viewport. */
export function renderRadarFrame(
	snapshot: RadarSnapshot,
	options?: { cols?: number; rows?: number; tick?: number; selectedIndex?: number; nowMs?: number; state?: RadarState },
): string {
	const layout = buildRadarLayout(snapshot, {
		cols: options?.cols ?? 84,
		rows: options?.rows ?? 32,
		nowMs: options?.nowMs,
		state: options?.state ?? { ...initialRadarState(), selected: options?.selectedIndex ?? 0 },
	});
	return [...layout.header, ...layout.body, ...layout.summary, ...layout.footer].join("\n");
}

/**
 * Runs `refresh` at most once per `minIntervalMs`. The first request after a quiet spell runs at once; requests that
 * arrive while waiting fold into one trailing run, so a burst of file changes costs two refreshes, not hundreds.
 */
export function createRefreshScheduler(
	refresh: () => void,
	minIntervalMs: number,
): { request(): void; cancel(): void } {
	let lastRun = Number.NEGATIVE_INFINITY;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const run = () => {
		timer = undefined;
		lastRun = Date.now();
		refresh();
	};
	return {
		request() {
			if (timer) return;
			const wait = lastRun + minIntervalMs - Date.now();
			if (wait <= 0) run();
			else timer = setTimeout(run, wait);
		},
		cancel() {
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
	};
}

/**
 * The terminal output that turns screen `prev` into `next`: only changed rows are rewritten, and rows the new frame
 * no longer uses are cleared. With no `prev` (start, resize) every row is drawn. "" when nothing changed.
 */
export function frameUpdate(prev: readonly string[] | undefined, next: readonly string[]): string {
	let out = "";
	for (let r = 0; r < next.length; r++) {
		if (!prev || prev[r] !== next[r]) out += `\x1b[${r + 1};1H${next[r]}\x1b[K`;
	}
	for (let r = next.length; r < (prev?.length ?? 0); r++) out += `\x1b[${r + 1};1H\x1b[2K`;
	return out ? `\x1b[?2026h${out}\x1b[?2026l` : "";
}

export { runRadarTui } from "./radar-runtime.ts";
