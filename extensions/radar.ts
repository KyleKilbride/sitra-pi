/**
 * sitra radar: a zero-token, btop-inspired retro-futuristic TUI that renders your live herdr workspaces as animated
 * half-block pixel dioramas, gradient Braille activity waves, plain-English progress lines, and peer mail.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, watch } from "node:fs";
import { basename, join } from "node:path";
import { knowledgeRepo, knowledgeRoot, listKnownProjects, listProposals } from "./kb.ts";
import { readRun } from "./runs.ts";
import {
	detectSessionAlerts,
	gitBranch,
	groupWorkerSessions,
	listSessions,
	readTranscriptTail,
	type SessionAlert,
	type SessionRecord,
	sessionsDir,
} from "./sessions.ts";

export type VisualState = "working" | "waiting_for_user" | "error_loop" | "idle" | "stopped";

export interface MailItem {
	id: string;
	peer: string;
	direction: "in" | "out";
	state: string;
	summary: string;
	updatedAt: string;
}

export interface RunSummary {
	label: string;
	done: boolean;
	exitCode?: number;
	updatedAt: string;
}

export interface WorkerCard {
	index: number;
	title: string;
	subtitle?: string;
	workspaceId?: string;
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
	pendingProposals: number;
	mail: MailItem[];
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
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;

/**
 * Encodes an activity series into Unicode Braille cells (2 horizontal samples x 4 vertical dot rows per cell),
 * matching btop's high-density terminal graphs.
 */
export function brailleSparkline(values: readonly number[], width = 8): string {
	const totalSamples = Math.max(1, width * 2);
	const samples: number[] = [];
	if (values.length === 0) {
		for (let i = 0; i < totalSamples; i++) samples.push(0);
	} else {
		for (let i = 0; i < totalSamples; i++) {
			const idx = Math.floor((i * values.length) / totalSamples);
			samples.push(Math.max(0, values[idx] ?? 0));
		}
	}
	const max = Math.max(1, ...samples);
	const leftBits = [0x40, 0x04, 0x02, 0x01];
	const rightBits = [0x80, 0x20, 0x10, 0x08];
	let out = "";
	for (let c = 0; c < width; c++) {
		const lv = samples[c * 2] ?? 0;
		const rv = samples[c * 2 + 1] ?? 0;
		const lHeight = lv <= 0 ? 0 : Math.min(4, Math.ceil((lv / max) * 4));
		const rHeight = rv <= 0 ? 0 : Math.min(4, Math.ceil((rv / max) * 4));
		let mask = 0;
		for (let d = 0; d < lHeight; d++) mask |= leftBits[d] ?? 0;
		for (let d = 0; d < rHeight; d++) mask |= rightBits[d] ?? 0;
		out += String.fromCodePoint(0x2800 + mask);
	}
	return out;
}

function gradientSparkline(
	values: readonly number[],
	width: number,
	fromRgb: [number, number, number] = [55, 200, 255],
	toRgb: [number, number, number] = [70, 255, 175],
): string {
	const raw = [...brailleSparkline(values, width)];
	return raw
		.map((ch, i) => {
			const t = raw.length <= 1 ? 1 : i / (raw.length - 1);
			const r = Math.round(fromRgb[0] + (toRgb[0] - fromRgb[0]) * t);
			const g = Math.round(fromRgb[1] + (toRgb[1] - fromRgb[1]) * t);
			const b = Math.round(fromRgb[2] + (toRgb[2] - fromRgb[2]) * t);
			return fg(r, g, b, ch);
		})
		.join("");
}

const PALETTE: Record<string, [number, number, number]> = {
	H: [85, 205, 255],
	V: [200, 255, 255],
	N: [40, 115, 165],
	B: [45, 155, 210],
	A: [125, 235, 255],
	L: [35, 100, 145],
	C: [55, 95, 125],
	T: [35, 65, 90],
	G: [55, 255, 165],
	S: [115, 255, 215],
	D: [0, 215, 255],
	W: [255, 195, 50],
	F: [255, 70, 115],
	Y: [255, 245, 120],
	E: [255, 65, 75],
	O: [255, 145, 40],
	I: [120, 140, 200],
	Z: [155, 215, 255],
	M: [235, 160, 95],
	P: [90, 100, 115],
	K: [55, 62, 72],
};

const DIORAMAS_14: Record<VisualState, [string[], string[], string[], string[]]> = {
	working: [
		[
			"..HHHH....S...",
			".HVVVVH.....D.",
			".HHHHHH..TTTTT",
			"..BBBB...TGGST",
			".ABBBBA..TGSGT",
			"..BBBB...TTTTT",
			"..L..L..CCCCCC",
			".LL..LL.......",
		],
		[
			"..HHHH.....D..",
			".HVVVVH..S....",
			".HHHHHH..TTTTT",
			".ABBBBA..TSGGT",
			"..BBBB...TGGST",
			"..BBBB...TTTTT",
			"..L..L..CCCCCC",
			".LL..LL.......",
		],
		[
			"..HHHH...D...S",
			".HVVVVH.......",
			".HHHHHH..TTTTT",
			"..BBBB...TGGST",
			".ABBBBA..TSTGT",
			"..BBBB...TTTTT",
			"..L..L..CCCCCC",
			".LL..LL.......",
		],
		[
			"..HHHH....S...",
			".HNNNNH....D..",
			".HHHHHH..TTTTT",
			".ABBBBA..TSTGT",
			"..BBBB...TGGST",
			"..BBBB...TTTTT",
			"..L..L..CCCCCC",
			".LL..LL.......",
		],
	],
	waiting_for_user: [
		[
			"..WWWW...FFFFF",
			".WYYYYW..FYYYF",
			".WWWWWW..FFFFF",
			".AWWWWA....F..",
			"..WWWW...TTTTT",
			"..WWWW...TYYYT",
			"..L..L..CCCCCC",
			".LL..LL.......",
		],
		[
			".AWWWW...YYYYY",
			".WYYYYW..YFFFY",
			"..WWWWW..YYYYY",
			"..WWWW.....Y..",
			"..WWWW...TTTTT",
			"..WWWW...TFFFT",
			"..L..L..CCCCCC",
			".LL..LL.......",
		],
		[
			"..WWWW...FFFFF",
			".WYYYYW..FYYYF",
			".WWWWWW..FFFFF",
			".AWWWWA....F..",
			"..WWWW...TTTTT",
			"..WWWW...TFFFT",
			"..L..L..CCCCCC",
			".LL..LL.......",
		],
		[
			".AWWWW...YYYYY",
			".WYYYYW..YFFFY",
			"..WWWWW..YYYYY",
			"..WWWW.....Y..",
			"..WWWW...TTTTT",
			"..WWWW...TYYYT",
			"..L..L..CCCCCC",
			".LL..LL.......",
		],
	],
	error_loop: [
		[
			".AEEEEA..Y..O.",
			".EYYYYE...OE..",
			".EEEEEE..TTTTT",
			"..EEEE...TEEET",
			".AEEEEA..TEYET",
			"..EEEE...TTTTT",
			"..L..L..CCCCCC",
			".LL..LL.......",
		],
		[
			"..EEEE....OY..",
			"AEYYYYEA.E..Y.",
			".EEEEEE..TTTTT",
			"..EEEE...TYEET",
			"..EEEE...TEEET",
			"..EEEE...TTTTT",
			".L....L.CCCCCC",
			"LL....LL......",
		],
		[
			".AEEEEA...Y.O.",
			".EYYYYE..O.E..",
			".EEEEEE..TTTTT",
			"..EEEE...TEEET",
			".AEEEEA..TEYET",
			"..EEEE...TTTTT",
			"..L..L..CCCCCC",
			".LL..LL.......",
		],
		[
			"..EEEE...O..Y.",
			"AEYYYYEA..EY..",
			".EEEEEE..TTTTT",
			"..EEEE...TEYET",
			"..EEEE...TEEET",
			"..EEEE...TTTTT",
			".L....L.CCCCCC",
			"LL....LL......",
		],
	],
	idle: [
		[
			"..IIII....Z...",
			".IVVVVI.....Z.",
			".IIIIII..TTTTT",
			"..IIII...TKKKT",
			"..IIIIMMMTKKKT",
			"..IIII.MMTTTTT",
			"..L..L..CCCCCC",
			".LL..LL.......",
		],
		[
			"..IIII.....Z..",
			".IVVVVI...Z...",
			".IIIIII..TTTTT",
			"..IIII...TKKKT",
			"..IIIIMMMTKKKT",
			"..IIII.MMTTTTT",
			"..L..L..CCCCCC",
			".LL..LL.......",
		],
		[
			"..IIII...Z....",
			".INNNNI....Z..",
			".IIIIII..TTTTT",
			"..IIII...TKKKT",
			"..IIIIMMMTKKKT",
			"..IIII.MMTTTTT",
			"..L..L..CCCCCC",
			".LL..LL.......",
		],
		[
			"..IIII....Z...",
			".IVVVVI..Z....",
			".IIIIII..TTTTT",
			"..IIII...TKKKT",
			"..IIIIMMMTKKKT",
			"..IIII.MMTTTTT",
			"..L..L..CCCCCC",
			".LL..LL.......",
		],
	],
	stopped: [
		[
			"..PPPP........",
			".PKKKKP.......",
			".PPPPPP..TTTTT",
			"..PPPP...TKKKT",
			"..PPPP...TKKKT",
			"..PPPP...TTTTT",
			"..K..K..CCCCCC",
			".KK..KK.......",
		],
		[
			"..PPPP........",
			".PKKKKP.......",
			".PPPPPP..TTTTT",
			"..PPPP...TKKKT",
			"..PPPP...TKPPT",
			"..PPPP...TTTTT",
			"..K..K..CCCCCC",
			".KK..KK.......",
		],
		[
			"..PPPP........",
			".PKKKKP.......",
			".PPPPPP..TTTTT",
			"..PPPP...TKKKT",
			"..PPPP...TKKKT",
			"..PPPP...TTTTT",
			"..K..K..CCCCCC",
			".KK..KK.......",
		],
		[
			"..PPPP........",
			".PKKKKP.......",
			".PPPPPP..TTTTT",
			"..PPPP...TKKKT",
			"..PPPP...TPKKT",
			"..PPPP...TTTTT",
			"..K..K..CCCCCC",
			".KK..KK.......",
		],
	],
};

export function renderSprite(state: VisualState, tick = 0, width: 14 | 8 = 14): string[] {
	const frames = DIORAMAS_14[state];
	const grid = frames[Math.abs(tick) % 4] ?? frames[0];
	const rows: string[] = [];
	for (let r = 0; r < 8; r += 2) {
		const topRow = grid[r] ?? "";
		const botRow = grid[r + 1] ?? "";
		let line = "";
		for (let c = 0; c < width; c++) {
			const srcCol = width === 8 && c >= 6 ? c + 6 : c;
			const t = topRow[srcCol] ?? ".";
			const b = botRow[srcCol] ?? ".";
			const tc = PALETTE[t];
			const bc = PALETTE[b];
			if (!tc && !bc) {
				line += " ";
			} else if (tc && !bc) {
				line += `\x1b[38;2;${tc[0]};${tc[1]};${tc[2]}m▀\x1b[0m`;
			} else if (!tc && bc) {
				line += `\x1b[38;2;${bc[0]};${bc[1]};${bc[2]}m▄\x1b[0m`;
			} else if (tc && bc && t === b) {
				line += `\x1b[38;2;${tc[0]};${tc[1]};${tc[2]}m█\x1b[0m`;
			} else if (tc && bc) {
				line += `\x1b[38;2;${tc[0]};${tc[1]};${tc[2]}m\x1b[48;2;${bc[0]};${bc[1]};${bc[2]}m▀\x1b[0m`;
			}
		}
		rows.push(line);
	}
	return rows;
}

function cleanMarkdown(text: string): string {
	return text
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/^#+\s*/gm, "")
		.replace(/\s+/g, " ")
		.trim();
}

function readTranscriptInsights(
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
		const raw = readFileSync(sessionFile, "utf8");
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

function collectRuns(profileDir: string): RunSummary[] {
	const dir = join(profileDir, "runs");
	if (!existsSync(dir)) return [];
	try {
		const files = readdirSync(dir)
			.filter((f) => f.endsWith(".log"))
			.sort()
			.reverse()
			.slice(0, 4);
		return files.map((file) => {
			const full = join(dir, file);
			const status = readRun(readFileSync(full, "utf8"), 3);
			const label = file.replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-/, "").replace(/\.log$/, "");
			const mtime = statSync(full).mtime.toISOString();
			return {
				label,
				done: status.done,
				...(status.exitCode !== undefined ? { exitCode: status.exitCode } : {}),
				updatedAt: mtime,
			};
		});
	} catch {
		return [];
	}
}

function collectMail(profileDir: string): MailItem[] {
	const file = join(profileDir, "sitra-mail.json");
	if (!existsSync(file)) return [];
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		return Array.isArray(parsed) ? (parsed as MailItem[]).slice(0, 6) : [];
	} catch {
		return [];
	}
}

interface HerdrWorkspaceMeta {
	workspaceId: string;
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
			JSON.parse(execFileSync("herdr", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).result;
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
	options?: { nowMs?: number; towerName?: string; includeHerdr?: boolean },
): RadarSnapshot {
	const nowMs = options?.nowMs ?? Date.now();
	const towerName = options?.towerName?.trim() || process.env.SITRA_TOWER_NAME?.trim() || "Tower";
	const baseSessions = listSessions(profileDir);
	const towerRecord = baseSessions.find((s) => s.role === "tower");
	const readTail = (file: string) => (existsSync(file) ? readTranscriptTail(readFileSync(file, "utf8"), 8) : []);
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
						repo: knowledgeRepo(cwd),
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
			const insights = readTranscriptInsights(sessionFile, nowMs, status);
			const teammates = matchedGroup?.teammates ?? [];
			const activeHelpers = Math.max(ws.activeSubagents, teammates.filter((t) => t.status === "working").length);
			workers.push({
				index: ws.number,
				title: ws.name,
				...(ws.tabLabel && ws.tabLabel.toLowerCase() !== ws.name.toLowerCase() ? { subtitle: ws.tabLabel } : {}),
				workspaceId: ws.workspaceId,
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
			const insights = readTranscriptInsights(g.lead.sessionFile, nowMs, g.lead.status);
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
			const insights = readTranscriptInsights(g.lead.sessionFile, nowMs, g.lead.status);
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
	for (const repo of listKnownProjects(profileDir)) {
		try {
			pendingProposals += listProposals(knowledgeRoot(repo)).length;
		} catch {
			// Skip unreadable repos.
		}
	}

	return {
		towerName,
		workers,
		alerts,
		runs: collectRuns(profileDir),
		pendingProposals,
		mail: collectMail(profileDir),
	};
}

function drawBox(
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

function statusBadge(state: VisualState, activeHelpers = 0): string {
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

function formatAge(iso: string, nowMs = Date.now()): string {
	const sec = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
	if (!Number.isFinite(sec)) return "";
	if (sec < 30) return "now";
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h`;
	return `${Math.floor(hr / 24)}d`;
}

export function renderRadarFrame(
	snapshot: RadarSnapshot,
	options?: { cols?: number; rows?: number; tick?: number; selectedIndex?: number; nowMs?: number },
): string {
	const cols = Math.max(20, options?.cols ?? 84);
	const rows = Math.max(12, options?.rows ?? 32);
	const tick = options?.tick ?? 0;
	const selected = options?.selectedIndex ?? 0;
	const nowMs = options?.nowMs ?? Date.now();

	const workingCount = snapshot.workers.filter((w) => w.visualState === "working").length;
	const waitingWorkers = snapshot.workers.filter(
		(w) => w.visualState === "waiting_for_user" || w.visualState === "error_loop",
	);
	const waitingCount = waitingWorkers.length;
	const totalActivity = [0, 0, 0, 0, 0, 0, 0, 0].map((_, idx) =>
		snapshot.workers.reduce((sum, w) => sum + (w.activity[idx] ?? 0), 0),
	);

	const beacon = waitingCount > 0 ? "▲" : workingCount > 0 ? "◈" : "❖";
	const waveWidth = Math.max(4, Math.min(12, cols - 44));
	const wave = gradientSparkline(totalActivity, waveWidth, [0, 215, 255], [75, 255, 175]);
	const headerHeadline =
		waitingCount > 0
			? fg(255, 205, 55, bold(`Needs you in #${waitingWorkers[0]?.index} ${waitingWorkers[0]?.title}`))
			: `${fg(75, 255, 175, `${workingCount} working`)} · ${dim(`${snapshot.workers.length - workingCount} idle`)} · ${fg(160, 225, 200, "Nothing waiting on you")}`;
	const headerBox = drawBox(
		`${beacon} SITRA RADAR · ${snapshot.towerName}`,
		waitingCount > 0 ? "NEEDS YOU" : "ALL CLEAR",
		[` ${wave}  ${headerHeadline}`],
		cols,
		waitingCount > 0 ? [255, 190, 55] : [60, 195, 245],
	);

	const inner = cols - 2;
	const spriteWidth: 14 | 8 = cols >= 44 ? 14 : 8;
	const textCols = Math.max(8, inner - spriteWidth - 3);
	const workerLines: string[] = [];

	if (snapshot.workers.length === 0) {
		workerLines.push(dim(" No active workspaces found."));
	} else {
		for (let i = 0; i < snapshot.workers.length; i++) {
			const w = snapshot.workers[i];
			if (!w) continue;
			const sprite = renderSprite(w.visualState, tick + i, spriteWidth);
			const sub = w.subtitle ? ` · ${w.subtitle}` : "";
			const paneTag = !w.workspaceId && w.lead.paneId ? ` [${w.lead.paneId}]` : "";
			const age = formatAge(w.lead.updatedAt, nowMs);
			const ageTag = age ? ` · ${age}` : "";
			const selMark = i === selected ? fg(80, 255, 200, "▸") : " ";
			const spark = gradientSparkline(
				w.activity,
				Math.max(4, Math.min(8, Math.floor(textCols / 5))),
				w.visualState === "waiting_for_user" ? [255, 180, 50] : [55, 205, 255],
				w.visualState === "waiting_for_user" ? [255, 235, 100] : [80, 255, 175],
			);

			const r0 = `${selMark}${bold(`#${w.index} ${w.title}`)}${fg(140, 210, 250, sub)}  ${statusBadge(
				w.visualState,
				w.activeHelpers,
			)}${dim(`${paneTag}${ageTag}`)}`;

			const line1Text =
				w.nowLine ??
				(w.visualState === "waiting_for_user"
					? (w.lead.waitingFor ?? "Waiting for your answer")
					: (w.lead.task ?? "Standing by"));
			const r1 = `  ${fg(120, 220, 255, w.visualState === "working" ? "Now: " : "Task: ")}${fg(230, 245, 255, line1Text)}`;

			const line2Text =
				w.lastLine ??
				(w.teammates.length > 0
					? `Helpers: ${w.teammates.map((t) => `${t.name ?? t.agent ?? "helper"} (${t.status})`).join(", ")}`
					: (w.lastAction ?? "Ready"));
			const r2 = `  ${dim(`Last: ${line2Text}`)}`;

			const branchOrTeam =
				w.teammates.length > 0
					? `${fg(120, 230, 255, "team:")} ${w.teammates.map((t) => t.name ?? t.agent ?? "helper").join(", ")}`
					: dim(w.lead.branch ?? basename(w.lead.repo || w.lead.cwd));
			const r3 = `  ${spark}  ${branchOrTeam}`;

			const rightRows = [r0, r1, r2, r3];
			for (let r = 0; r < 4; r++) {
				workerLines.push(` ${sprite[r]}  ${fitAnsi(rightRows[r] ?? "", textCols)}`);
			}
			if (i < snapshot.workers.length - 1) {
				workerLines.push(dim(` ${"─".repeat(Math.max(6, inner - 2))} `));
			}
		}
	}
	const workersBox = drawBox("YOUR WORKSPACES", `${snapshot.workers.length} open`, workerLines, cols, [65, 200, 245]);

	const activeRuns = snapshot.runs.filter((r) => !r.done);
	const runsBox =
		activeRuns.length > 0 || (snapshot.runs.length > 0 && !snapshot.workers.some((w) => w.workspaceId))
			? drawBox(
					"BACKGROUND RUNS",
					`${snapshot.runs.length}`,
					snapshot.runs.slice(0, 2).map((r) => {
						const icon = !r.done
							? fg(80, 235, 255, "◐")
							: r.exitCode === 0
								? fg(70, 250, 165, "✓")
								: fg(255, 90, 95, `✗(${r.exitCode})`);
						return ` ${icon} ${r.label}`;
					}),
					cols,
					[70, 215, 175],
				)
			: [];

	const mailBox =
		snapshot.mail.length > 0
			? drawBox(
					"CONCOURSE MAIL",
					`${snapshot.mail.length} recent`,
					snapshot.mail.slice(0, 3).map((m) => {
						const tag =
							m.state === "WORKING"
								? fg(255, 210, 80, "waiting on them")
								: m.state === "INPUT_REQUIRED"
									? fg(255, 110, 110, bold("needs reply"))
									: fg(110, 235, 175, "done");
						return ` ${bold(m.peer)} (${tag}): ${m.summary}`;
					}),
					cols,
					[185, 145, 255],
				)
			: [];

	const footer = fitAnsi(
		` ${fg(95, 225, 255, "[1-9]")} jump to workspace  ${fg(95, 225, 255, "[↑/↓ Enter]")} switch  ${fg(
			95,
			225,
			255,
			"[q]",
		)} close`,
		cols,
	);

	const allLines = [...headerBox, ...workersBox, ...runsBox, ...mailBox, footer];
	return allLines.slice(0, rows).join("\n");
}

function focusWorker(card: WorkerCard | undefined): void {
	if (!card) return;
	try {
		const wsId = card.workspaceId ?? (card.lead.paneId?.includes(":") ? card.lead.paneId.split(":")[0] : undefined);
		if (wsId) {
			execFileSync("herdr", ["workspace", "focus", wsId], { stdio: "ignore" });
		}
	} catch {
		// Ignore when outside herdr.
	}
}

/** Runs the interactive full-screen btop-style radar TUI in the current terminal. */
export function runRadarTui(profileDir: string, options?: { towerName?: string; closePaneOnExit?: boolean }): void {
	let tick = 0;
	let selectedIndex = 0;
	let lastSnap = collectRadarSnapshot(profileDir, { towerName: options?.towerName, includeHerdr: true });

	const render = (refreshData: boolean) => {
		if (refreshData) {
			lastSnap = collectRadarSnapshot(profileDir, { towerName: options?.towerName, includeHerdr: true });
			if (selectedIndex >= lastSnap.workers.length) {
				selectedIndex = Math.max(0, lastSnap.workers.length - 1);
			}
		}
		const cols = process.stdout.columns || 84;
		const rows = process.stdout.rows || 32;
		const frameLines = renderRadarFrame(lastSnap, { cols, rows, tick, selectedIndex }).split("\n");
		let out = "\x1b[?2026h";
		for (let r = 0; r < frameLines.length; r++) {
			out += `\x1b[${r + 1};1H${frameLines[r]}\x1b[K`;
		}
		out += "\x1b[J\x1b[?2026l";
		process.stdout.write(out);
	};

	process.stdout.write("\x1b]0;sitra radar\x07\x1b[?1049h\x1b[?25l\x1b[2J");
	render(false);

	const watchers: ReturnType<typeof watch>[] = [];
	for (const dir of [profileDir, sessionsDir(profileDir), join(profileDir, "runs")]) {
		if (!existsSync(dir)) continue;
		try {
			watchers.push(watch(dir, () => render(true)));
		} catch {
			// Polling fallback handles platforms where watch fails.
		}
	}

	const timer = setInterval(() => {
		tick++;
		render(tick % 4 === 0);
	}, 450);

	const onResize = () => {
		process.stdout.write("\x1b[2J");
		render(false);
	};
	process.stdout.on("resize", onResize);

	const cleanup = () => {
		clearInterval(timer);
		for (const w of watchers) w.close();
		process.stdout.off("resize", onResize);
		if (process.stdin.isTTY) process.stdin.setRawMode(false);
		process.stdout.write("\x1b[?25h\x1b[?1049l\x1b]0;\x07");
	};
	process.once("SIGINT", () => {
		cleanup();
		process.exit(0);
	});
	process.once("SIGTERM", () => {
		cleanup();
		process.exit(0);
	});

	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.on("data", (buf: Buffer) => {
			const key = buf.toString("utf8");
			if (key === "q" || key === "\u0003") {
				cleanup();
				if (options?.closePaneOnExit && process.env.HERDR_ENV === "1" && process.env.HERDR_PANE_ID) {
					try {
						execFileSync("herdr", ["pane", "close", process.env.HERDR_PANE_ID], { stdio: "ignore" });
					} catch {
						// Ignore if already closing.
					}
				}
				process.exit(0);
			}
			if (key === "r") {
				render(true);
				return;
			}
			if (key === "j" || key === "\u001b[B") {
				selectedIndex = Math.min(Math.max(0, lastSnap.workers.length - 1), selectedIndex + 1);
				render(false);
				return;
			}
			if (key === "k" || key === "\u001b[A") {
				selectedIndex = Math.max(0, selectedIndex - 1);
				render(false);
				return;
			}
			if (key === "\r" || key === "\n") {
				focusWorker(lastSnap.workers[selectedIndex]);
				return;
			}
			if (/^[1-9]$/.test(key)) {
				const num = Number(key);
				const byWorkspaceNumber = lastSnap.workers.findIndex((w) => w.index === num);
				const idx = byWorkspaceNumber !== -1 ? byWorkspaceNumber : num - 1;
				if (lastSnap.workers[idx]) {
					selectedIndex = idx;
					focusWorker(lastSnap.workers[idx]);
					render(false);
				}
			}
		});
	}
}
