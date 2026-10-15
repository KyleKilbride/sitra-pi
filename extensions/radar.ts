/**
 * sitra radar: a zero-token, btop-inspired retro-futuristic TUI that renders live worker sessions as animated
 * half-block pixel agents, Braille activity sparklines, background runs, knowledge proposals, and peer mail.
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

export function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

export function visibleWidth(text: string): number {
	return [...stripAnsi(text)].length;
}

function padOrTrimAnsi(text: string, width: number): string {
	if (width <= 0) return "";
	const plain = [...stripAnsi(text)];
	if (plain.length <= width) {
		return text + " ".repeat(width - plain.length);
	}
	const trimmed = plain.slice(0, Math.max(1, width - 1)).join("");
	return `${trimmed}…`;
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

const PALETTE: Record<string, [number, number, number]> = {
	H: [90, 210, 255], // cyan helmet
	V: [180, 255, 255], // bright visor
	B: [45, 160, 210], // suit body
	A: [120, 230, 255], // arms/hands
	L: [35, 110, 155], // legs/boots
	C: [40, 85, 110], // console desk
	G: [50, 255, 160], // glowing green screen
	S: [110, 255, 200], // data bit 1
	D: [0, 215, 255], // data bit 2
	W: [255, 195, 50], // amber warning suit
	F: [255, 75, 110], // beacon flag
	Y: [255, 240, 110], // beacon core / spark
	E: [255, 70, 70], // error crimson
	O: [255, 140, 40], // orange spark
	I: [120, 140, 195], // idle indigo suit
	Z: [150, 210, 255], // sleep zZ
	M: [230, 160, 95], // coffee mug
	P: [90, 100, 115], // stopped grey
	K: [55, 62, 72], // stopped dark visor
};

const SPRITES: Record<VisualState, [string[], string[]]> = {
	working: [
		["..HHHH....", ".HVVVVH..S", ".HHHHHH...", "..BBBB..GG", ".ABBBBA.GG", "..BBBB..CC", "..L..L..CC", ".LL..LL..."],
		["..HHHH...D", ".HVVVVH...", ".HHHHHH..S", ".ABBBBA.GG", "..BBBB..GG", "..BBBB..CC", "..L..L..CC", ".LL..LL..."],
	],
	waiting_for_user: [
		["..WWWW..FF", ".WYYYYW.FY", ".WWWWWW..F", ".AWWWWA..F", "..WWWW...F", "..WWWW....", "..L..L...Y", ".LL..LL..."],
		[".AWWWW..YF", ".WYYYYW.FF", "..WWWWW..F", "..WWWW...F", "..WWWW...F", "..WWWW....", "..L..L...F", ".LL..LL..."],
	],
	error_loop: [
		[".AEEEEA..Y", ".EYYYYE.OE", ".EEEEEE..O", "..EEEE..EE", ".AEEEEA.CC", "..EEEE..CC", "..L..L....", ".LL..LL..."],
		["..EEEE..OY", "AEYYYYEA.E", ".EEEEEE.Y.", "..EEEE..EE", "..EEEE..CC", "..EEEE..CC", ".L....L...", "LL....LL.."],
	],
	idle: [
		["..IIII...Z", ".IVVVVI...", ".IIIIII.Z.", "..IIII....", "..IIIIMMM.", "..IIII.MM.", "..L..L....", ".LL..LL..."],
		["..IIII..Z.", ".IVVVVI..Z", ".IIIIII...", "..IIII....", "..IIIIMMM.", "..IIII.MM.", "..L..L....", ".LL..LL..."],
	],
	stopped: [
		["..PPPP....", ".PKKKKP...", ".PPPPPP...", "..PPPP....", "..PPPP....", "..PPPP....", "..K..K....", ".KK..KK..."],
		["..PPPP....", ".PKKKKP...", ".PPPPPP...", "..PPPP....", "..PPPP..K.", "..PPPP....", "..K..K....", ".KK..KK..."],
	],
};

/**
 * Renders an 8x10 pixel grid into 4 terminal rows of 10 columns using Unicode upper/lower half-blocks
 * (`▀`, `▄`, `█`) and 24-bit RGB ANSI colors.
 */
export function renderSprite(state: VisualState, tick = 0): string[] {
	const frames = SPRITES[state];
	const grid = frames[Math.abs(tick) % 2] ?? frames[0];
	const rows: string[] = [];
	for (let r = 0; r < 8; r += 2) {
		const topRow = grid[r] ?? "..........";
		const botRow = grid[r + 1] ?? "..........";
		let line = "";
		for (let c = 0; c < 10; c++) {
			const t = topRow[c] ?? ".";
			const b = botRow[c] ?? ".";
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

function drawBox(
	title: string,
	rightTag: string,
	bodyLines: readonly string[],
	cols: number,
	borderRgb: [number, number, number],
): string[] {
	const w = Math.max(24, cols);
	const inner = w - 2;
	const color = (s: string) => fg(borderRgb[0], borderRgb[1], borderRgb[2], s);
	const tClean = ` ${stripAnsi(title)} `;
	const rClean = rightTag ? ` ${stripAnsi(rightTag)} ` : "";
	const dashes = Math.max(1, inner - [...tClean].length - [...rClean].length);
	const top = `${color("╭")}${bold(fg(210, 245, 255, tClean))}${color("─".repeat(dashes))}${
		rClean ? fg(150, 210, 230, rClean) : ""
	}${color("╮")}`;
	const mid = bodyLines.map((line) => `${color("│")}${padOrTrimAnsi(line, inner)}${color("│")}`);
	const bot = `${color("╰")}${color("─".repeat(inner))}${color("╯")}`;
	return [top, ...mid, bot];
}

function statusBadge(state: VisualState): string {
	switch (state) {
		case "working":
			return fg(60, 255, 170, bold("● WORKING"));
		case "waiting_for_user":
			return fg(255, 200, 50, bold("▲ NEEDS YOU"));
		case "error_loop":
			return fg(255, 80, 95, bold("✖ LOOPING"));
		case "stopped":
			return fg(130, 140, 155, "◌ STOPPED");
		default:
			return fg(135, 175, 225, "○ IDLE");
	}
}

export function renderRadarFrame(
	snapshot: RadarSnapshot,
	options?: { cols?: number; rows?: number; tick?: number; selectedIndex?: number },
): string {
	const cols = Math.max(48, options?.cols ?? 84);
	const rows = Math.max(18, options?.rows ?? 32);
	const tick = options?.tick ?? 0;
	const selected = options?.selectedIndex ?? 0;

	const workingCount = snapshot.workers.filter((w) => w.visualState === "working").length;
	const waitingCount = snapshot.workers.filter(
		(w) => w.visualState === "waiting_for_user" || w.visualState === "error_loop",
	).length;
	const totalActivity = [0, 0, 0, 0, 0, 0, 0, 0].map((_, idx) =>
		snapshot.workers.reduce((sum, w) => sum + (w.activity[idx] ?? 0), 0),
	);
	const pulse = tick % 2 === 0 ? "⚡" : "✦";
	const headerSummary = `${workingCount} active · ${waitingCount} alert · ${snapshot.pendingProposals} /kb`;
	const headerLine = ` ${fg(80, 240, 255, brailleSparkline(totalActivity, 8))}  ${fg(180, 225, 245, headerSummary)}`;
	const headerBox = drawBox(
		`${pulse} SITRA RADAR // ${snapshot.towerName}`,
		"zero-token watch",
		[headerLine],
		cols,
		waitingCount > 0 ? [255, 185, 50] : [55, 185, 235],
	);

	const inner = cols - 2;
	const textCols = Math.max(20, inner - 13);
	const workerLines: string[] = [];
	if (snapshot.workers.length === 0) {
		workerLines.push(dim(" No active worker sessions recorded yet."));
	} else {
		for (let i = 0; i < snapshot.workers.length; i++) {
			const w = snapshot.workers[i];
			if (!w) continue;
			const sprite = renderSprite(w.visualState, tick + i);
			const project = basename(w.lead.repo || w.lead.cwd);
			const branch = w.lead.branch ? ` (${w.lead.branch})` : "";
			const pane = w.lead.paneId ? ` [${w.lead.paneId}]` : "";
			const selMark = i === selected ? fg(80, 255, 200, "▸") : " ";
			const spark = fg(70, 235, 200, brailleSparkline(w.activity, 6));

			const r0 = `${selMark}${bold(`[${w.index}] ${project}`)}${fg(140, 205, 245, branch)} ${statusBadge(
				w.visualState,
			)}${dim(pane)}`;
			const r1 = `  ${fg(220, 235, 245, w.lead.task ?? "(no task prompt yet)")}`;
			const r2 = `  ${spark} ${dim(w.lastAction ?? w.lead.waitingFor ?? w.lead.cwd)}`;
			const tmText =
				w.teammates.length > 0
					? `  ${fg(120, 225, 255, "↳ team:")} ${w.teammates
							.map((t) => `${t.name ?? t.agent ?? "helper"}[${t.status}]`)
							.join(", ")}`
					: `  ${dim(w.lead.cwd)}`;

			const rightRows = [r0, r1, r2, tmText];
			for (let r = 0; r < 4; r++) {
				workerLines.push(` ${sprite[r]} ${padOrTrimAnsi(rightRows[r] ?? "", textCols)}`);
			}
			if (i < snapshot.workers.length - 1) {
				workerLines.push(dim(` ${"─".repeat(Math.max(10, inner - 2))}`));
			}
		}
	}
	const workersBox = drawBox(
		"AGENTS ON WATCH",
		`${snapshot.workers.length} session${snapshot.workers.length === 1 ? "" : "s"}`,
		workerLines,
		cols,
		[65, 195, 245],
	);

	const runLines: string[] = [];
	if (snapshot.runs.length === 0) {
		runLines.push(dim(" No background pane runs yet."));
	} else {
		for (const r of snapshot.runs.slice(0, 3)) {
			const icon = !r.done
				? fg(80, 230, 255, tick % 2 === 0 ? "◐" : "◓")
				: r.exitCode === 0
					? fg(70, 250, 160, "✓")
					: fg(255, 90, 90, `✗(${r.exitCode})`);
			runLines.push(` ${icon} ${r.label}`);
		}
	}
	if (snapshot.pendingProposals > 0) {
		runLines.push(
			` ${fg(255, 205, 70, "★")} ${snapshot.pendingProposals} knowledge proposal${
				snapshot.pendingProposals === 1 ? "" : "s"
			} waiting for /kb`,
		);
	}
	const runsBox = drawBox("RUNS & KNOWLEDGE", `/kb: ${snapshot.pendingProposals}`, runLines, cols, [70, 210, 175]);

	const mailBox =
		snapshot.mail.length > 0
			? drawBox(
					"PEER MAIL // COMMS",
					`${snapshot.mail.length} thread${snapshot.mail.length === 1 ? "" : "s"}`,
					snapshot.mail.slice(0, 3).map((m) => {
						const arrow = m.direction === "in" ? fg(90, 245, 255, "↙") : fg(180, 220, 140, "↗");
						return ` ${arrow} ${bold(m.peer)} [${m.state}] ${m.summary}`;
					}),
					cols,
					[185, 140, 255],
				)
			: [];

	const footer = padOrTrimAnsi(
		` ${fg(95, 220, 255, "[1-9]")} focus pane  ${fg(95, 220, 255, "[↑/↓ Enter]")} jump  ${fg(
			95,
			220,
			255,
			"[r]",
		)} refresh  ${fg(95, 220, 255, "[q]")} close`,
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
		const frame = renderRadarFrame(lastSnap, { cols, rows, tick, selectedIndex });
		process.stdout.write(`\x1b[H${frame}\x1b[J`);
	};

	process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J");
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

	const onResize = () => render(false);
	process.stdout.on("resize", onResize);

	const cleanup = () => {
		clearInterval(timer);
		for (const w of watchers) w.close();
		process.stdout.off("resize", onResize);
		if (process.stdin.isTTY) process.stdin.setRawMode(false);
		process.stdout.write("\x1b[?25h\x1b[?1049l");
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
