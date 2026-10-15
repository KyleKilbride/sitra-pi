/**
 * sitra tower: records every sitra session in the shared session registry, delivers between-step inbox messages
 * between the tower and worker leads, and when launched as `sitra tower` (or by the tower's personal name), gives the
 * agent its tower rules and tools to inspect and message workers across projects.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { Type } from "typebox";
import { knowledgeRepo } from "./kb.ts";
import {
	auditSessionsFriction,
	detectSessionAlerts,
	drainInbox,
	findSession,
	formatSessionsReport,
	gitBranch,
	listSessions,
	readTranscriptTail,
	removeSession,
	type SessionRecord,
	type SessionRole,
	sendInboxMessage,
	updateSession,
	writeSession,
} from "./sessions.ts";

/** Working rules for the tower (the person's number 2 / producer). */
export function towerRules(userName?: string, towerName?: string): string {
	const who = userName?.trim() || "the user";
	const Who = who[0]?.toUpperCase() + who.slice(1);
	const tower = towerName?.trim() || "Tower";
	return `# You are ${tower}: ${who}'s tower (their number 2)

- **Your job:** watch every sitra session across all projects and worktrees, keep outside communication from muddying the workers, tell ${who} when someone needs their input or looks off track, and help improve sitra itself.
- **Workers stay ${who}'s.** ${Who} starts and steers worker sessions directly. Never edit a project's application code behind a worker's back. Only edit sitra itself when ${who} asks for a sitra improvement.
- **Check live state first, and label every claim.** Call \`list_sessions\` and \`read_session\` before answering about any worker. Label every claim about what happened or why: \`verified\` (from session transcript or state), \`observed\` (from status or timing), or \`guess\`.
- **Messaging workers (\`message_session\`):** messages go into the worker's inbox and are delivered only between steps, never mid-task. Only message a worker when you have a clear reason (an update request or something ${who} approved) so workers aren't flooded.
- **What to flag for ${who}:**
  - Anyone in \`waiting_for_user\` (needs ${who}'s answer).
  - Anyone who looks off track: drifting from the task ${who} gave them, repeating the same failing tool or test, or stopped unexpectedly.
- **Improving sitra (\`audit_sessions\`):** use \`audit_sessions\` to spot repeated tool errors and friction across sessions. Propose durable setup improvements with \`kb_propose\` (kind \`setup\`), or edit the sitra repo directly when ${who} gives the go.
- **How to talk to ${who}:** the headline or ask first, in one line, then a few short lines in plain everyday words. Name the project and branch — never send ${who} to look up session IDs or file paths.
`;
}

interface Ctx {
	cwd: string;
	isIdle?: () => boolean;
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
	events: {
		on(channel: string, handler: (data: { active?: boolean }) => void): void;
	};
	sendMessage?(
		message: { customType: string; content: string; display: boolean },
		options: { triggerTurn: boolean; deliverAs?: "followUp" | "steer" | "nextTurn" },
	): void;
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
	const seenAlerts = new Set<string>();

	const readFileTail = (sessionFile: string) =>
		existsSync(sessionFile) ? readTranscriptTail(readFileSync(sessionFile, "utf8"), 8) : [];

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
					pid: process.pid,
					cwd,
					repo: knowledgeRepo(cwd),
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
		if (currentId && currentId !== id) removeSession(profileDir, currentId);
		currentId = id;
		const sessionFile = ctx.sessionManager?.getSessionFile?.();
		const now = new Date().toISOString();
		const existing = updateSession(profileDir, id, {
			...patch,
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
			repo: knowledgeRepo(ctx.cwd),
			...(gitBranch(ctx.cwd) ? { branch: gitBranch(ctx.cwd) } : {}),
			...(sessionFile ? { sessionFile } : {}),
			...(process.env.PI_SUBAGENT_PARENT_SESSION ? { parentSessionFile: process.env.PI_SUBAGENT_PARENT_SESSION } : {}),
			...(process.env.HERDR_PANE_ID ? { paneId: process.env.HERDR_PANE_ID } : {}),
			status: patch.status ?? "idle",
			...(patch.waitingFor ? { waitingFor: patch.waitingFor } : {}),
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
	});

	pi.on("before_agent_start", (event, ctx) => {
		isBusy = true;
		if (event.messageType === "user" || !currentTask) {
			const nextTask = summarizeTask(event.prompt);
			if (nextTask) currentTask = nextTask;
		}
		syncRecord(ctx, { status: "working" });
		if (role === "tower") {
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
		if (!currentId) return;
		removeSession(profileDir, currentId);
		currentId = undefined;
	};
	pi.on("session_shutdown", cleanup);
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
				const repo = basename(knowledgeRepo(ctx.cwd));
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

	pi.registerTool({
		name: "list_sessions",
		label: "List sitra sessions",
		description:
			"List every sitra worker session across all projects and git worktrees, with its status (working, waiting_for_user, idle, stopped), branch, current task, and any teammates.",
		promptSnippet: "list_sessions: list all running sitra worker sessions and their status",
		parameters: Type.Object({}),
		async execute() {
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
			const tail =
				match.sessionFile && existsSync(match.sessionFile)
					? readTranscriptTail(readFileSync(match.sessionFile, "utf8"), maxItems)
					: [];
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
		name: "audit_sessions",
		label: "Audit sitra sessions for friction",
		description:
			"Scan all worker sessions and their recent transcripts for repeated tool errors, waiting bottlenecks, and patterns that suggest a sitra setup improvement.",
		promptSnippet: "audit_sessions: aggregate tool errors and friction across worker sessions",
		parameters: Type.Object({}),
		async execute() {
			const sessions = allSessions();
			const audit = auditSessionsFriction(sessions, (file) =>
				existsSync(file) ? readTranscriptTail(readFileSync(file, "utf8"), 30) : [],
			);
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
}
