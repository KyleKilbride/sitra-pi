/**
 * sitra radar: a zero-token, btop-inspired retro-futuristic TUI that renders live worker sessions as animated
 * half-block pixel dioramas, gradient Braille activity sparklines, background runs, knowledge proposals, and peer mail.
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
	lead: SessionRecord;
	teammates: SessionRecord[];
	visualState: VisualState;
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
	// Guaranteed 1-column geometric, box-drawing, block, and Braille ranges we use in the TUI.
	if (cp >= 0x2500 && cp <= 0x25ff) return 1;
	if (cp >= 0x2800 && cp <= 0x28ff) return 1;
	if (cp === 0x2605 || cp === 0x2713 || cp === 0x2716 || cp === 0x2717 || cp === 0x2726 || cp === 0x2756) return 1;
	if (cp >= 0x2190 && cp <= 0x21ff) return 1;
	// Emojis, dingbats (like U+26A1 lightning), and fullwidth CJK occupy 2 cells in modern terminals.
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

/** Colors each Braille cell along a smooth btop cyan -> mint -> emerald RGB gradient. */
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
	H: [85, 205, 255], // cyan helmet
	V: [200, 255, 255], // bright glowing visor
	N: [40, 115, 165], // visor blink
	B: [45, 155, 210], // suit torso
	A: [125, 235, 255], // animated hands/arms
	L: [35, 100, 145], // boots
	C: [55, 95, 125], // workstation desk
	T: [35, 65, 90], // monitor bezel
	G: [55, 255, 165], // emerald code line 1
	S: [115, 255, 215], // mint particle / code line 2
	D: [0, 215, 255], // cyan matrix spark
	W: [255, 195, 50], // amber alert suit
	F: [255, 70, 115], // crimson/magenta beacon
	Y: [255, 245, 120], // bright gold core / spark
	E: [255, 65, 75], // error suit
	O: [255, 145, 40], // orange arc
	I: [120, 140, 200], // idle indigo suit
	Z: [155, 215, 255], // floating sleep zZ
	M: [235, 160, 95], // coffee mug
	P: [90, 100, 115], // stopped grey
	K: [55, 62, 72], // powered-down visor
};

/** 14x8 pixel dioramas (4 animation frames each): character + dual-monitor console + floating status particles. */
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

/**
 * Renders an 8-row pixel diorama into 4 terminal rows using Unicode upper/lower half-blocks (`▀`, `▄`, `█`)
 * and 24-bit RGB ANSI colors. Supports 14-column full dioramas (default) and 8-column compact mode.
 */
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

function readTranscriptActivity(
	sessionFile: string | undefined,
	nowMs: number,
	status: string,
): {
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
		for (let i = Math.max(0, lines.length - 120); i < lines.length; i++) {
			const line = lines[i]?.trim();
			if (!line) continue;
			const tsMatch = /"timestamp":"([^"]+)"/.exec(line);
			if (!tsMatch?.[1]) continue;
			const age = nowMs - Date.parse(tsMatch[1]);
			if (!Number.isFinite(age) || age < 0 || age > windowMs) continue;
			const idx = Math.min(7, Math.max(0, 7 - Math.floor((age / windowMs) * 8)));
			buckets[idx] = (buckets[idx] ?? 0) + 1;
		}
		if (status === "working" && buckets.every((b) => !b)) {
			buckets[6] = 1;
			buckets[7] = 3;
		}
		return { ...(lastAction ? { lastAction } : {}), activity: buckets };
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

function discoverHerdrSessions(profileDir: string, recorded: SessionRecord[], startedAt: string): SessionRecord[] {
	if (process.env.HERDR_ENV !== "1") return recorded;
	try {
		const raw = execFileSync("herdr", ["agent", "list"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const parsed = JSON.parse(raw) as {
			result?: {
				agents?: {
					agent?: string;
					agent_status?: string;
					cwd?: string;
					pane_id?: string;
					agent_session?: { value?: string };
				}[];
			};
		};
		const merged = [...recorded];
		for (const a of parsed.result?.agents ?? []) {
			const sessionFile = a.agent_session?.value;
			if (a.agent !== "pi" || !sessionFile || !sessionFile.startsWith(profileDir)) continue;
			if (merged.some((r) => r.sessionFile === sessionFile || (a.pane_id && r.paneId === a.pane_id))) continue;
			const idMatch = /_([0-9a-f-]{36})\.jsonl$/i.exec(sessionFile);
			const id = idMatch?.[1] ?? (a.pane_id ? `herdr-${a.pane_id}` : basename(sessionFile, ".jsonl"));
			const cwd = a.cwd || process.cwd();
			const mtime = existsSync(sessionFile) ? statSync(sessionFile).mtime.toISOString() : startedAt;
			merged.push({
				id,
				role: "lead",
				discovered: true,
				pid: process.pid,
				cwd,
				repo: knowledgeRepo(cwd),
				...(gitBranch(cwd) ? { branch: gitBranch(cwd) } : {}),
				sessionFile,
				...(a.pane_id ? { paneId: a.pane_id } : {}),
				status: a.agent_status === "blocked" ? "waiting_for_user" : a.agent_status === "working" ? "working" : "idle",
				startedAt: mtime,
				updatedAt: mtime,
			});
		}
		return merged;
	} catch {
		return recorded;
	}
}

export function collectRadarSnapshot(
	profileDir: string,
	options?: { nowMs?: number; towerName?: string; includeHerdr?: boolean },
): RadarSnapshot {
	const nowMs = options?.nowMs ?? Date.now();
	const towerName = options?.towerName?.trim() || process.env.SITRA_TOWER_NAME?.trim() || "Tower";
	const baseSessions = listSessions(profileDir);
	const sessions = options?.includeHerdr
		? discoverHerdrSessions(profileDir, baseSessions, new Date(nowMs).toISOString())
		: baseSessions;
	const readTail = (file: string) => (existsSync(file) ? readTranscriptTail(readFileSync(file, "utf8"), 8) : []);
	const alerts = detectSessionAlerts(sessions, readTail, nowMs);
	const errorLoopIds = new Set(alerts.filter((a) => a.kind === "repeated_errors").map((a) => a.sessionId));
	const groups = groupWorkerSessions(sessions);

	const workers: WorkerCard[] = groups.map((g, i) => {
		const visualState: VisualState = errorLoopIds.has(g.lead.id)
			? "error_loop"
			: g.lead.status === "waiting_for_user"
				? "waiting_for_user"
				: g.lead.status === "working"
					? "working"
					: g.lead.status === "stopped"
						? "stopped"
						: "idle";
		const { lastAction, activity } = readTranscriptActivity(g.lead.sessionFile, nowMs, g.lead.status);
		return {
			index: i + 1,
			lead: g.lead,
			teammates: g.teammates,
			visualState,
			...(lastAction ? { lastAction } : {}),
			activity,
		};
	});

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

/**
 * Draws a btop-inspired rounded box with bracketed title tabs (`╭─┤ TITLE ├───...─┤ TAG ├─╮`)
 * where every returned line is guaranteed to be exactly `cols` terminal cells wide.
 */
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

function statusBadge(state: VisualState): string {
	switch (state) {
		case "working":
			return fg(65, 255, 175, bold("● WORKING"));
		case "waiting_for_user":
			return fg(255, 205, 55, bold("▲ NEEDS YOU"));
		case "error_loop":
			return fg(255, 80, 95, bold("✖ LOOPING"));
		case "stopped":
			return fg(130, 140, 155, "◌ STOPPED");
		default:
			return fg(140, 180, 230, "○ IDLE");
	}
}

function formatAge(iso: string, nowMs = Date.now()): string {
	const sec = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
	if (!Number.isFinite(sec)) return "";
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m`;
	return `${Math.floor(min / 60)}h`;
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
	const waitingCount = snapshot.workers.filter(
		(w) => w.visualState === "waiting_for_user" || w.visualState === "error_loop",
	).length;
	const totalActivity = [0, 0, 0, 0, 0, 0, 0, 0].map((_, idx) =>
		snapshot.workers.reduce((sum, w) => sum + (w.activity[idx] ?? 0), 0),
	);

	// Guaranteed 1-column geometric glyphs so the header border never shifts width across ticks.
	const beacon = waitingCount > 0 ? "▲" : workingCount > 0 ? "◈" : "❖";
	const waveWidth = Math.max(4, Math.min(14, cols - 38));
	const wave = gradientSparkline(totalActivity, waveWidth, [0, 215, 255], [75, 255, 175]);
	const headerSummary = `${fg(75, 255, 175, `${workingCount} active`)} · ${
		waitingCount > 0 ? fg(255, 200, 55, bold(`${waitingCount} alert`)) : dim("0 alert")
	} · ${snapshot.pendingProposals > 0 ? fg(255, 210, 80, `${snapshot.pendingProposals} /kb`) : dim("0 /kb")}`;
	const headerBox = drawBox(
		`${beacon} SITRA RADAR · ${snapshot.towerName}`,
		waitingCount > 0 ? "NEEDS YOU" : "LIVE WATCH",
		[` ${wave}  ${headerSummary}`],
		cols,
		waitingCount > 0 ? [255, 190, 55] : [60, 195, 245],
	);

	const inner = cols - 2;
	const spriteWidth: 14 | 8 = cols >= 44 ? 14 : 8;
	const textCols = Math.max(8, inner - spriteWidth - 3);
	const workerLines: string[] = [];

	if (snapshot.workers.length === 0) {
		workerLines.push(dim(" No active worker sessions recorded yet."));
	} else {
		for (let i = 0; i < snapshot.workers.length; i++) {
			const w = snapshot.workers[i];
			if (!w) continue;
			const sprite = renderSprite(w.visualState, tick + i, spriteWidth);
			const project = basename(w.lead.repo || w.lead.cwd);
			const branch = w.lead.branch ? ` (${w.lead.branch})` : "";
			const pane = w.lead.paneId ? ` [${w.lead.paneId}]` : "";
			const age = formatAge(w.lead.updatedAt, nowMs);
			const ageTag = age ? ` · ${age}` : "";
			const selMark = i === selected ? fg(80, 255, 200, "▸") : " ";
			const spark = gradientSparkline(
				w.activity,
				Math.max(4, Math.min(8, Math.floor(textCols / 5))),
				w.visualState === "waiting_for_user" ? [255, 180, 50] : [55, 205, 255],
				w.visualState === "waiting_for_user" ? [255, 235, 100] : [80, 255, 175],
			);

			const r0 = `${selMark}${bold(`[${w.index}] ${project}`)}${fg(140, 210, 250, branch)} ${statusBadge(
				w.visualState,
			)}${dim(`${pane}${ageTag}`)}`;
			const r1 = `  ${fg(225, 240, 250, w.lead.task ?? "(ready for task)")}`;
			const r2 = `  ${spark} ${dim(w.lastAction ?? w.lead.waitingFor ?? w.lead.cwd)}`;
			const tmText =
				w.teammates.length > 0
					? `  ${fg(120, 230, 255, "↳ team:")} ${w.teammates
							.map((t) => `${t.name ?? t.agent ?? "helper"}[${t.status}]`)
							.join(", ")}`
					: `  ${dim(w.lead.cwd)}`;

			const rightRows = [r0, r1, r2, tmText];
			for (let r = 0; r < 4; r++) {
				workerLines.push(` ${sprite[r]}  ${fitAnsi(rightRows[r] ?? "", textCols)}`);
			}
			if (i < snapshot.workers.length - 1) {
				workerLines.push(dim(` ${"─".repeat(Math.max(6, inner - 2))} `));
			}
		}
	}
	const workersBox = drawBox(
		"AGENTS ON WATCH",
		`${snapshot.workers.length} session${snapshot.workers.length === 1 ? "" : "s"}`,
		workerLines,
		cols,
		[65, 200, 245],
	);

	const runLines: string[] = [];
	if (snapshot.runs.length === 0) {
		runLines.push(dim(" No background pane runs yet."));
	} else {
		const spinner = ["◐", "◓", "◑", "◒"][Math.abs(tick) % 4] ?? "◐";
		for (const r of snapshot.runs.slice(0, 3)) {
			const icon = !r.done
				? fg(80, 235, 255, spinner)
				: r.exitCode === 0
					? fg(70, 250, 165, "✓")
					: fg(255, 90, 95, `✗(${r.exitCode})`);
			runLines.push(` ${icon} ${r.label}`);
		}
	}
	if (snapshot.pendingProposals > 0) {
		runLines.push(
			` ${fg(255, 210, 75, "★")} ${snapshot.pendingProposals} knowledge proposal${
				snapshot.pendingProposals === 1 ? "" : "s"
			} waiting for /kb`,
		);
	}
	const runsBox = drawBox("RUNS & KNOWLEDGE", `/kb: ${snapshot.pendingProposals}`, runLines, cols, [70, 215, 175]);

	const mailBox =
		snapshot.mail.length > 0
			? drawBox(
					"PEER MAIL · COMMS",
					`${snapshot.mail.length} thread${snapshot.mail.length === 1 ? "" : "s"}`,
					snapshot.mail.slice(0, 3).map((m) => {
						const arrow = m.direction === "in" ? fg(95, 245, 255, "↙") : fg(185, 225, 145, "↗");
						return ` ${arrow} ${bold(m.peer)} [${m.state}] ${m.summary}`;
					}),
					cols,
					[185, 145, 255],
				)
			: [];

	const footer = fitAnsi(
		` ${fg(95, 225, 255, "[1-9]")} focus pane  ${fg(95, 225, 255, "[↑/↓ Enter]")} jump  ${fg(
			95,
			225,
			255,
			"[r]",
		)} refresh  ${fg(95, 225, 255, "[q]")} close`,
		cols,
	);

	const allLines = [...headerBox, ...workersBox, ...runsBox, ...mailBox, footer];
	return allLines.slice(0, rows).join("\n");
}

function focusWorkerPane(card: WorkerCard | undefined): void {
	if (!card?.lead.paneId) return;
	try {
		execFileSync("herdr", ["pane", "focus", card.lead.paneId], { stdio: "ignore" });
	} catch {
		// Ignore when outside herdr or pane already closed.
	}
}

/** Runs the interactive full-screen btop-style radar TUI in the current terminal. */
export function runRadarTui(profileDir: string, options?: { towerName?: string }): void {
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
				if (process.env.HERDR_ENV === "1" && process.env.HERDR_PANE_ID) {
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
				focusWorkerPane(lastSnap.workers[selectedIndex]);
				return;
			}
			if (/^[1-9]$/.test(key)) {
				const idx = Number(key) - 1;
				if (lastSnap.workers[idx]) {
					selectedIndex = idx;
					focusWorkerPane(lastSnap.workers[idx]);
					render(false);
				}
			}
		});
	}
}
