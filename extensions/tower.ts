/**
 * sitra tower: records every sitra session in the shared session registry, delivers between-step inbox messages
 * between the tower and worker leads, and when launched as `sitra tower` (or by the tower's personal name), gives the
 * agent its tower rules and tools to inspect and message workers across projects.
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { Type } from "typebox";
import { writeTowerSummary } from "./radar-store.ts";
import { startCommandInFreshPane } from "./runs.ts";
import {
	auditSessionsFriction,
	createTailReader,
	defaultPidAlive,
	detectSessionAlerts,
	drainInbox,
	findSession,
	formatSessionsReport,
	gitBranch,
	groundingPrompt,
	listSessions,
	mainCheckout,
	moveInbox,
	prepareWorktree,
	pruneEndedSessions,
	readLastLines,
	readTranscriptTail,
	removeSession,
	type SessionRecord,
	type SessionRole,
	sendInboxMessage,
	updateSession,
	writeSession,
	writeSpawnPaneScript,
} from "./sessions.ts";

/** Working rules for the tower (the person's number 2 / producer). */
export function towerRules(userName?: string, towerName?: string): string {
	const who = userName?.trim() || "the user";
	const Who = who[0]?.toUpperCase() + who.slice(1);
	const tower = towerName?.trim() || "Tower";
	return `# You are ${tower}: ${who}'s tower (their number 2)

- **Your job:** watch every sitra session across all projects and worktrees, keep outside communication from muddying the workers, tell ${who} when someone needs their input or looks off track, and help improve sitra itself.
- **Workers stay ${who}'s.** ${Who} drives worker sessions directly. Use \`spawn_session\` when ${who} asks to open a new worker space (it creates the worktree off the base branch ${who} chose, copies \`.env\` files, opens a single-tab single-pane herdr space, runs \`pnpm i && pnpm run build\`, and starts \`sitra\` with its initial docs/rules grounding prompt). A brief carries only limits ${who} gave; an option you offered that ${who} has not chosen is not a limit. Never edit a project's application code behind a worker's back. Only edit sitra itself when ${who} asks for a sitra improvement.
- **Check live state first, and label every claim.** Call \`list_sessions\` and \`read_session\` before answering about any worker. Label every claim about what happened or why: \`verified\` (from session transcript or state), \`observed\` (from status or timing), or \`guess\`.
- Before you ask ${who} anything, check Grimoire, related sessions and peer agents' reports, and say in one line what you checked. Decide engineering points yourself. Ask at most 3 at a time, in plain words with the context in the question.
- **Messaging workers (\`message_session\`):** messages go into the worker's inbox and are delivered only between steps, never mid-task. Only message a worker when you have a clear reason (an update request or something ${who} approved) so workers aren't flooded.
- **What to flag for ${who}:**
  - Anyone in \`waiting_for_user\` (needs ${who}'s answer).
  - Anyone who looks off track: drifting from the task ${who} gave them, repeating the same failing tool or test, or stopped unexpectedly.
- **Improving sitra (\`audit_sessions\`):** use \`audit_sessions\` to spot repeated tool errors and friction across sessions. Propose durable setup improvements with \`grimoire_propose\` (kind \`setup\`), or edit the sitra repo directly when ${who} gives the go.
- **Dashboard status:** publish verified Done / Being done / Next updates with \`update_radar_status\` whenever work changes and before ending a turn. Keep completed work separate from idle sessions, include outside work only from a current owner report, and retain uncertainty. The timestamp is the last verification, not a live remote check. Keep status lists in radar rather than repeating them in chat; use chat for decisions and surprises.
- **How to talk to ${who}:** the headline or ask first, in one line, then a few short lines in plain everyday words. Name the project and branch — never send ${who} to look up session IDs or file paths.
`;
}

interface Ctx {
	cwd: string;
	isIdle?: () => boolean;
	ui?: {
		notify?(message: string, level?: "info" | "warning" | "error"): void;
	};
	sessionManager?: {
		getSessionId?(): string | undefined;
		getSessionFile?(): string | undefined;
	};
}

interface BeforeAgentStartEvent {
	messageType?: string;
	prompt?: string;
	systemPromptOptions: { sections: Record<string, string> };
}

interface Pi {
	on(event: "session_start", handler: (event: unknown, ctx: Ctx) => void): void;
	on(event: "before_agent_start", handler: (event: BeforeAgentStartEvent, ctx: Ctx) => void): void;
	on(event: "agent_end", handler: (event: unknown, ctx: Ctx) => void): void;
	on(event: "session_shutdown", handler: (event: unknown, ctx: Ctx) => void): void;
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		promptSnippet?: string;
		parameters: unknown;
		execute(
			id: string,
			params: Record<string, unknown>,
			signal: unknown,
			onUpdate: unknown,
			ctx: Ctx,
		): Promise<{
			content: { type: "text"; text: string }[];
			details: unknown;
		}>;
	}): void;
	registerCommand?(
		name: string,
		command: {
			description: string;
			handler(args: string, ctx: Ctx): Promise<void>;
		},
	): void;
	events: {
		on(channel: string, handler: (data: { active?: boolean }) => void): void;
	};
	sendMessage?(
		message: { customType: string; content: string; display: boolean },
		options: { triggerTurn: boolean; deliverAs?: "followUp" | "steer" | "nextTurn" },
	): void;
	getActiveTools?(): string[];
	setActiveTools?(tools: string[]): void;
}

function summarizeTask(prompt: string | undefined): string | undefined {
	const firstLine = prompt
		?.trim()
		.split("\n")
		.find((line) => line.trim().length > 0)
		?.trim();
	if (!firstLine) return undefined;
	return firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine;
}

export default function sitraTower(pi: Pi): void {
	const profileDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
	const subagentName = process.env.PI_SUBAGENT_NAME?.trim();
	const role: SessionRole = subagentName ? "teammate" : process.env.SITRA_ROLE === "tower" ? "tower" : "lead";
	const towerName = process.env.SITRA_TOWER_NAME?.trim() || "Tower";
	const startedAt = new Date().toISOString();
	let currentId: string | undefined;
	let currentTask: string | undefined;
	let isBusy = false;
	let lastCtx: Ctx | undefined;
	let radarPane: string | undefined;
	const seenAlerts = new Set<string>();

	const herdr = (args: string[]) =>
		execFileSync("herdr", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	const inspectPane = (id: string): { alive: boolean; runningRadar: boolean } => {
		try {
			const info = herdr(["pane", "get", id]);
			const title = /"terminal_title":"([^"]*)"/.exec(info)?.[1]?.toLowerCase() ?? "";
			return { alive: true, runningRadar: title.includes("radar") };
		} catch {
			return { alive: false, runningRadar: false };
		}
	};
	const openRadarPane = (cwd: string, focus = false): string | undefined => {
		if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) return undefined;
		try {
			if (radarPane) {
				const state = inspectPane(radarPane);
				if (state.alive) {
					if (!state.runningRadar) {
						herdr(["pane", "run", radarPane, "sitra radar --tui"]);
					}
					if (focus) {
						herdr(["pane", "focus", "--current", "--direction", "right"]);
					}
					return radarPane;
				}
			}
			const split = herdr([
				"pane",
				"split",
				"--current",
				"--direction",
				"right",
				"--ratio",
				"0.42",
				"--no-focus",
				"--cwd",
				cwd,
			]);
			radarPane = /"pane_id":"([^"]+)"/.exec(split)?.[1];
			if (!radarPane) return undefined;
			herdr(["pane", "run", radarPane, "sitra radar --tui"]);
			if (focus) {
				herdr(["pane", "focus", "--current", "--direction", "right"]);
			}
			return radarPane;
		} catch {
			return undefined;
		}
	};

	// The alert check runs every 2 seconds over every session, so it reads only the end of each transcript and skips
	// transcripts that haven't changed. A whole-file read of one long session cost a quarter of a second each time.
	const readAlertTail = createTailReader(200);
	const readFileTail = (sessionFile: string) => readTranscriptTail(readAlertTail.read(sessionFile), 8);
	// On-demand tools want more turns; every turn is at least one line, so ten lines per turn leaves plenty of room.
	const readTurns = (sessionFile: string, turns: number) =>
		readTranscriptTail(readLastLines(sessionFile, Math.max(200, turns * 10)), turns);

	const allSessions = (): SessionRecord[] => {
		const recorded = listSessions(profileDir);
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
			for (const a of parsed.result?.agents ?? []) {
				const sessionFile = a.agent_session?.value;
				if (a.agent !== "pi" || !sessionFile || !sessionFile.startsWith(profileDir)) continue;
				if (a.pane_id && a.pane_id === process.env.HERDR_PANE_ID) continue;
				if (recorded.some((r) => r.sessionFile === sessionFile || (a.pane_id && r.paneId === a.pane_id))) continue;
				const idMatch = /_([0-9a-f-]{36})\.jsonl$/i.exec(sessionFile);
				const id = idMatch?.[1] ?? (a.pane_id ? `herdr-${a.pane_id}` : basename(sessionFile, ".jsonl"));
				const cwd = a.cwd || process.cwd();
				const tail = readFileTail(sessionFile);
				const lastUser = [...tail].reverse().find((t) => t.role === "user")?.text;
				const mtime = existsSync(sessionFile) ? statSync(sessionFile).mtime.toISOString() : startedAt;
				recorded.push({
					id,
					role: "lead",
					discovered: true,
					pid: process.pid,
					cwd,
					repo: mainCheckout(cwd),
					...(gitBranch(cwd) ? { branch: gitBranch(cwd) } : {}),
					sessionFile,
					...(a.pane_id ? { paneId: a.pane_id } : {}),
					status: a.agent_status === "blocked" ? "waiting_for_user" : a.agent_status === "working" ? "working" : "idle",
					...(lastUser ? { task: summarizeTask(lastUser) } : {}),
					startedAt: mtime,
					updatedAt: mtime,
				});
			}
		} catch {
			// Fall back to file registry only.
		}
		return recorded;
	};

	const syncRecord = (ctx: Ctx, patch: Partial<SessionRecord>): void => {
		lastCtx = ctx;
		const id = ctx.sessionManager?.getSessionId?.() || `pid-${process.pid}`;
		if (currentId && currentId !== id) {
			// Keep anything already sent to the old id.
			moveInbox(profileDir, currentId, id);
			removeSession(profileDir, currentId);
		}
		currentId = id;
		const sessionFile = ctx.sessionManager?.getSessionFile?.();
		const now = new Date().toISOString();
		const existing = updateSession(profileDir, id, {
			...patch,
			// A resumed session can find its own record left behind by a crash; it's this process now.
			pid: process.pid,
			...(process.env.HERDR_PANE_ID ? { paneId: process.env.HERDR_PANE_ID } : {}),
			cwd: ctx.cwd,
			branch: gitBranch(ctx.cwd),
			...(sessionFile ? { sessionFile } : {}),
			...(currentTask ? { task: currentTask } : {}),
			updatedAt: now,
		});
		if (existing) return;
		const record: SessionRecord = {
			id,
			role,
			...(subagentName ? { name: subagentName } : role === "tower" ? { name: towerName } : {}),
			...(process.env.PI_SUBAGENT_AGENT ? { agent: process.env.PI_SUBAGENT_AGENT } : {}),
			pid: process.pid,
			cwd: ctx.cwd,
			repo: mainCheckout(ctx.cwd),
			...(gitBranch(ctx.cwd) ? { branch: gitBranch(ctx.cwd) } : {}),
			...(sessionFile ? { sessionFile } : {}),
			...(process.env.PI_SUBAGENT_PARENT_SESSION ? { parentSessionFile: process.env.PI_SUBAGENT_PARENT_SESSION } : {}),
			...(process.env.HERDR_PANE_ID ? { paneId: process.env.HERDR_PANE_ID } : {}),
			status: patch.status ?? "idle",
			...(patch.waitingFor ? { waitingFor: patch.waitingFor } : {}),
			...(patch.status === "waiting_for_user" ? { waitingSince: now } : {}),
			...(currentTask ? { task: currentTask } : {}),
			startedAt,
			updatedAt: now,
		};
		writeSession(profileDir, record);
	};

	const deliverInbox = (): void => {
		if (role === "teammate" || isBusy || !pi.sendMessage) return;
		if (lastCtx?.isIdle && !lastCtx.isIdle()) return;
		const target = role === "tower" ? "tower" : currentId;
		if (!target) return;
		const messages = drainInbox(profileDir, target);
		if (messages.length > 0) {
			const text =
				role === "tower"
					? messages.map((m) => `Reply from worker ${m.from} (${m.fromSessionId}): ${m.text}`).join("\n\n")
					: messages
							.map((m) => `Message from ${m.from} (tower): ${m.text}\n(Reply when ready with the reply_tower tool.)`)
							.join("\n\n");
			pi.sendMessage({ customType: "sitra-inbox", content: text, display: true }, { triggerTurn: true });
			return;
		}
		if (role === "tower") {
			pruneEndedSessions(profileDir);
			const alerts = detectSessionAlerts(listSessions(profileDir), readFileTail);
			const fresh = alerts.filter((a) => !seenAlerts.has(a.key));
			if (fresh.length === 0) return;
			for (const a of fresh) seenAlerts.add(a.key);
			const body = fresh.map((a) => `- [${a.kind}] ${a.summary}`).join("\n");
			pi.sendMessage(
				{
					customType: "sitra-alert",
					content: `Session alert:\n${body}`,
					display: true,
				},
				{ triggerTurn: true },
			);
		}
	};

	const inboxTimer =
		role === "teammate"
			? undefined
			: setInterval(() => {
					deliverInbox();
				}, 2_000);
	inboxTimer?.unref();

	pi.on("session_start", (_event, ctx) => {
		isBusy = false;
		syncRecord(ctx, { status: "idle" });
		if (role === "tower" && process.env.SITRA_NO_RADAR !== "1") {
			openRadarPane(ctx.cwd);
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		isBusy = true;
		if (event.messageType === "user" || !currentTask) {
			const nextTask = summarizeTask(event.prompt);
			if (nextTask) currentTask = nextTask;
		}
		syncRecord(ctx, { status: "working" });
		if (role === "tower") {
			if (pi.getActiveTools && pi.setActiveTools) {
				const active = pi.getActiveTools();
				const towerTools = [
					"list_sessions",
					"read_session",
					"message_session",
					"forget_session",
					"audit_sessions",
					"spawn_session",
					"update_radar_status",
				];
				const missing = towerTools.filter((t) => !active.includes(t));
				if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
			}
			event.systemPromptOptions.sections["sitra-tower"] = towerRules(
				process.env.SITRA_USER_NAME,
				process.env.SITRA_TOWER_NAME,
			);
		}
	});

	pi.on("agent_end", (_event, ctx) => {
		isBusy = false;
		syncRecord(ctx, { status: "idle" });
		deliverInbox();
	});

	pi.events.on("rpiv:ask-user:blocked", (data) => {
		if (!currentId) return;
		updateSession(
			profileDir,
			currentId,
			data?.active ? { status: "waiting_for_user", waitingFor: "waiting for your answer" } : { status: "working" },
		);
	});

	const cleanup = () => {
		if (inboxTimer) clearInterval(inboxTimer);
		process.off("SIGHUP", cleanup);
		process.off("exit", cleanup);
		if (radarPane) {
			try {
				herdr(["pane", "close", radarPane]);
			} catch {
				// Already closed.
			}
			radarPane = undefined;
		}
		if (!currentId) return;
		removeSession(profileDir, currentId);
		currentId = undefined;
	};
	pi.on("session_shutdown", cleanup);
	process.once("SIGHUP", cleanup);
	process.once("exit", cleanup);

	if (role === "lead") {
		pi.registerTool({
			name: "reply_tower",
			label: "Reply to tower",
			description: "Send a short status update or answer back to the tower's inbox.",
			promptSnippet: "reply_tower: send a short status or answer back to the tower",
			parameters: Type.Object({
				message: Type.String({ description: "Short status or answer for the tower." }),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const repo = basename(mainCheckout(ctx.cwd));
				const branch = gitBranch(ctx.cwd);
				const label = branch ? `${repo} (${branch})` : repo;
				const sent = sendInboxMessage(profileDir, {
					from: label,
					fromSessionId: currentId ?? `pid-${process.pid}`,
					toSessionId: "tower",
					text: String(params.message ?? ""),
				});
				return {
					content: [{ type: "text", text: "Sent to the tower's inbox." }],
					details: { messageId: sent.id },
				};
			},
		});
		return;
	}

	if (role !== "tower") return;

	pi.registerCommand?.("radar", {
		description: "Open (or focus) the live sitra dashboard in a right-hand herdr pane",
		async handler(_args, ctx) {
			const pane = openRadarPane(ctx.cwd, true);
			ctx.ui?.notify?.(
				pane ? `Radar open in herdr pane ${pane}.` : "Run `sitra radar` in a terminal pane to open the radar.",
				"info",
			);
		},
	});

	pi.registerTool({
		name: "list_sessions",
		label: "List sitra sessions",
		description:
			"List every sitra worker session across all projects and git worktrees, with its status (working, waiting_for_user, idle, stopped), branch, current task, and any teammates.",
		promptSnippet: "list_sessions: list all running sitra worker sessions and their status",
		parameters: Type.Object({}),
		async execute() {
			pruneEndedSessions(profileDir);
			const sessions = allSessions();
			const alerts = detectSessionAlerts(sessions, readFileTail);
			for (const a of alerts) seenAlerts.add(a.key);
			const report = formatSessionsReport(sessions);
			const alertSection =
				alerts.length > 0 ? `\n\nAlerts:\n${alerts.map((a) => `- [${a.kind}] ${a.summary}`).join("\n")}` : "";
			return {
				content: [{ type: "text", text: `${report}${alertSection}` }],
				details: { sessions, alerts },
			};
		},
	});

	pi.registerTool({
		name: "forget_session",
		label: "Forget a stopped sitra session",
		description: "Remove a stopped session from the tower's registry by session id. Running sessions are refused.",
		promptSnippet: "forget_session: remove a stopped session record by id",
		parameters: Type.Object({
			id: Type.String({ description: "Exact session id to remove." }),
		}),
		async execute(_id, params) {
			const sessionId = String(params.id ?? "").trim();
			const match = listSessions(profileDir).find((s) => s.id === sessionId);
			if (!match) {
				return {
					content: [{ type: "text", text: `No sitra session record has id "${sessionId}".` }],
					details: { removed: undefined, reason: "not_found" },
				};
			}
			if (defaultPidAlive(match.pid)) {
				return {
					content: [
						{
							type: "text",
							text: `${match.id} is still running (process ${match.pid}). I did not remove it.`,
						},
					],
					details: { removed: undefined, reason: "running", session: match },
				};
			}
			removeSession(profileDir, match.id);
			return {
				content: [
					{
						type: "text",
						text: `Removed stopped session ${match.id} from the tower registry. Transcript kept${
							match.sessionFile ? ` at ${match.sessionFile}` : "."
						}`,
					},
				],
				details: { removed: match.id, session: match },
			};
		},
	});

	pi.registerTool({
		name: "read_session",
		label: "Read a sitra session",
		description:
			"Read a worker or teammate session's live status and recent conversation turns by id, teammate name, project name, or branch.",
		promptSnippet: "read_session: inspect a worker session's status and recent conversation",
		parameters: Type.Object({
			query: Type.String({ description: "Session id, teammate name, project name, or branch." }),
			turns: Type.Optional(Type.Number({ description: "How many recent transcript items to read (default: 8)." })),
		}),
		async execute(_id, params) {
			const query = String(params.query ?? "");
			const maxItems = typeof params.turns === "number" ? params.turns : 8;
			const sessions = allSessions();
			const match = findSession(sessions, query);
			if (!match) {
				return {
					content: [{ type: "text", text: `No sitra session matched "${query}".` }],
					details: { found: false },
				};
			}
			const tail = match.sessionFile ? readTurns(match.sessionFile, maxItems) : [];
			const header = [
				`Session: ${match.id} (${match.role}${match.name ? `: ${match.name}` : ""})`,
				`Status: ${match.status}${match.waitingFor ? ` — ${match.waitingFor}` : ""}`,
				`Location: ${match.cwd}${match.branch ? ` (${match.branch})` : ""}`,
				...(match.task ? [`Task: ${match.task}`] : []),
				`Updated: ${match.updatedAt}`,
			].join("\n");
			const transcript =
				tail.length > 0
					? tail.map((item) => `[${item.role}] ${item.text}`).join("\n")
					: "(No saved transcript turns yet.)";
			return {
				content: [{ type: "text", text: `${header}\n\nRecent turns:\n${transcript}` }],
				details: { found: true, session: match, tail },
			};
		},
	});

	pi.registerTool({
		name: "message_session",
		label: "Message a sitra worker",
		description:
			"Drop a short message or question into a worker lead's inbox. Delivered only between steps (never mid-task); the worker can answer with reply_tower.",
		promptSnippet: "message_session: send a message to a worker's inbox (delivered between steps)",
		parameters: Type.Object({
			query: Type.String({ description: "Worker session id, project name, or branch." }),
			message: Type.String({ description: "Short message or question for the worker." }),
		}),
		async execute(_id, params) {
			const query = String(params.query ?? "");
			const text = String(params.message ?? "").trim();
			const sessions = allSessions().filter((s) => s.role === "lead" && s.status !== "stopped");
			const match = findSession(sessions, query);
			if (!match) {
				return {
					content: [{ type: "text", text: `No active worker lead matched "${query}".` }],
					details: { sent: false },
				};
			}
			if (match.discovered) {
				// herdr shows it, but it isn't running sitra's inbox, so nothing would ever read the message.
				return {
					content: [
						{
							type: "text",
							text: `Not sent: ${basename(match.repo || match.cwd)}${match.branch ? ` (${match.branch})` : ""} has no sitra inbox (it started before sitra's tower, or outside sitra). It needs a restart with sitra to receive messages.`,
						},
					],
					details: { sent: false, reason: "no_inbox", toSessionId: match.id },
				};
			}
			const sent = sendInboxMessage(profileDir, {
				from: towerName,
				fromSessionId: currentId ?? `pid-${process.pid}`,
				toSessionId: match.id,
				text,
			});
			return {
				content: [
					{
						type: "text",
						text: `Queued in ${basename(match.repo || match.cwd)}${match.branch ? ` (${match.branch})` : ""}'s inbox. It will read it between steps and can reply with reply_tower.`,
					},
				],
				details: { sent: true, toSessionId: match.id, messageId: sent.id },
			};
		},
	});

	pi.registerTool({
		name: "update_radar_status",
		label: "Update radar status",
		description:
			"Publish the tower’s verified Done / Being done / Next summary to radar. Replace all three lists together. Check source state first; this does not verify external work or contact anyone.",
		parameters: Type.Object({
			done: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 20 }),
			doing: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 20 }),
			next: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 20 }),
		}),
		async execute(_id, params) {
			const summary = {
				done: params.done as string[],
				doing: params.doing as string[],
				next: params.next as string[],
				updatedAt: new Date().toISOString(),
			};
			writeTowerSummary(profileDir, summary);
			return { content: [{ type: "text", text: "Radar status updated." }], details: summary };
		},
	});

	pi.registerTool({
		name: "audit_sessions",
		label: "Audit sitra sessions for friction",
		description:
			"Scan all worker sessions and their recent transcripts for repeated tool errors, waiting bottlenecks, and patterns that suggest a sitra setup improvement.",
		promptSnippet: "audit_sessions: aggregate tool errors and friction across worker sessions",
		parameters: Type.Object({}),
		async execute() {
			const sessions = allSessions();
			const audit = auditSessionsFriction(sessions, (file) => readTurns(file, 30));
			const lines = [
				`Sessions checked: ${audit.totalSessions}`,
				...(audit.hotspots.length > 0
					? ["Tool error hotspots:", ...audit.hotspots.map((h) => `- ${h}`)]
					: ["No tool error hotspots in recent turns."]),
			];
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: audit,
			};
		},
	});

	pi.registerTool({
		name: "spawn_session",
		label: "Spawn a new sitra worker workspace",
		description:
			"Create a new git worktree from the chosen base branch (e.g. staging or sre), copy the primary repo's .env files, open a new single-tab single-pane herdr workspace, and run a short startup script for `pnpm i && pnpm run build && sitra <grounding>` in that pane.",
		promptSnippet:
			"spawn_session: open a new herdr space in a fresh worktree with .env files copied, pnpm i && build, and initial grounding instructions",
		parameters: Type.Object({
			branch: Type.String({ description: "New git branch name for the worktree (e.g. krskl/flights-fix)." }),
			base: Type.String({ description: "Base branch to branch from (e.g. staging or sre)." }),
			label: Type.Optional(Type.String({ description: "Workspace label in herdr (defaults to the worktree slug)." })),
			repo: Type.Optional(
				Type.String({ description: "Repository path (defaults to the current working directory's repo)." }),
			),
			instructions: Type.Optional(
				Type.String({ description: "Optional initial focus or grounding notes for the new sitra worker." }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (process.env.HERDR_ENV !== "1") {
				return {
					content: [{ type: "text", text: "Not inside herdr: cannot open a new herdr workspace." }],
					details: { spawned: false, reason: "not_in_herdr" },
				};
			}
			const repo = typeof params.repo === "string" && params.repo.trim() ? params.repo.trim() : ctx.cwd;
			const branch = String(params.branch ?? "").trim();
			const base = String(params.base ?? "").trim();
			const extra = typeof params.instructions === "string" ? params.instructions : undefined;

			const prepared = prepareWorktree({ repo, branch, base });
			const label = (typeof params.label === "string" && params.label.trim()) || basename(prepared.worktreePath);

			const createdRaw = herdr(["workspace", "create", "--cwd", prepared.worktreePath, "--label", label, "--no-focus"]);
			const created = JSON.parse(createdRaw) as {
				result?: {
					workspace?: { workspace_id?: string; number?: number };
					root_pane?: { pane_id?: string };
				};
			};
			const workspaceId = created.result?.workspace?.workspace_id;
			const workspaceNumber = created.result?.workspace?.number;
			const paneId = created.result?.root_pane?.pane_id;
			if (!paneId) {
				throw new Error(`herdr workspace create did not return a root_pane: ${createdRaw.slice(0, 200)}`);
			}

			const prompt = groundingPrompt(process.env.SITRA_USER_NAME, extra);
			const { line, scriptPath, groundingPath } = writeSpawnPaneScript(
				join(profileDir, "runs"),
				prepared.worktreePath,
				prompt,
				label,
			);
			try {
				startCommandInFreshPane(herdr, paneId, line);
			} catch {
				return {
					content: [
						{
							type: "text",
							text: [
								`Spawned workspace ${workspaceNumber ? `#${workspaceNumber} ` : ""}"${label}" (${workspaceId ?? paneId}).`,
								`Worktree: ${prepared.worktreePath} (branch ${prepared.branch} from ${prepared.baseRef})`,
								`Copied .env files: ${prepared.copiedEnvFiles.length > 0 ? prepared.copiedEnvFiles.join(", ") : "none"}`,
								`The worker was not started: pane shell never became ready (${paneId}); the new pane was closed.`,
								`Script: ${scriptPath}`,
							].join("\n"),
						},
					],
					details: {
						spawned: false,
						error: "pane shell never became ready",
						workspaceId,
						workspaceNumber,
						paneId,
						scriptPath,
						groundingPath,
						...prepared,
					},
				};
			}

			return {
				content: [
					{
						type: "text",
						text: [
							`Spawned workspace ${workspaceNumber ? `#${workspaceNumber} ` : ""}"${label}" (${workspaceId ?? paneId}).`,
							`Worktree: ${prepared.worktreePath} (branch ${prepared.branch} from ${prepared.baseRef})`,
							`Copied .env files: ${prepared.copiedEnvFiles.length > 0 ? prepared.copiedEnvFiles.join(", ") : "none"}`,
							`Running in pane ${paneId}: pnpm i && pnpm run build && sitra <grounding>`,
							`Script: ${scriptPath}`,
						].join("\n"),
					},
				],
				details: {
					spawned: true,
					workspaceId,
					workspaceNumber,
					paneId,
					scriptPath,
					groundingPath,
					...prepared,
				},
			};
		},
	});
}
