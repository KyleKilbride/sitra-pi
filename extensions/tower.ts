/**
 * sitra tower: records every sitra session in the shared session registry, and when launched as `sitra tower` (or by
 * the tower's personal name), gives the agent its tower rules and tools to inspect all workers across projects.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { knowledgeRepo } from "./kb.ts";
import {
	findSession,
	formatSessionsReport,
	gitBranch,
	listSessions,
	readTranscriptTail,
	removeSession,
	type SessionRecord,
	type SessionRole,
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
- **What to flag for ${who}:**
  - Anyone in \`waiting_for_user\` (needs ${who}'s answer).
  - Anyone who looks off track: drifting from the task ${who} gave them, repeating the same failing tool or test, or stopped unexpectedly.
- **How to talk to ${who}:** the headline or ask first, in one line, then a few short lines in plain everyday words. Name the project and branch — never send ${who} to look up session IDs or file paths.
`;
}

interface Ctx {
	cwd: string;
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
	const startedAt = new Date().toISOString();
	let currentId: string | undefined;
	let currentTask: string | undefined;

	const syncRecord = (ctx: Ctx, patch: Partial<SessionRecord>): void => {
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
			...(subagentName
				? { name: subagentName }
				: role === "tower"
					? { name: process.env.SITRA_TOWER_NAME || "Tower" }
					: {}),
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

	pi.on("session_start", (_event, ctx) => {
		syncRecord(ctx, { status: "idle" });
	});

	pi.on("before_agent_start", (event, ctx) => {
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
		syncRecord(ctx, { status: "idle" });
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
		if (!currentId) return;
		removeSession(profileDir, currentId);
		currentId = undefined;
	};
	pi.on("session_shutdown", cleanup);
	process.once("exit", cleanup);

	if (role !== "tower") return;

	pi.registerTool({
		name: "list_sessions",
		label: "List sitra sessions",
		description:
			"List every sitra worker session across all projects and git worktrees, with its status (working, waiting_for_user, idle, stopped), branch, current task, and any teammates.",
		promptSnippet: "list_sessions: list all running sitra worker sessions and their status",
		parameters: Type.Object({}),
		async execute() {
			const sessions = listSessions(profileDir);
			return {
				content: [{ type: "text", text: formatSessionsReport(sessions) }],
				details: { sessions },
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
			const sessions = listSessions(profileDir);
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
}
