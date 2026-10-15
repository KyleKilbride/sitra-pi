import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	auditSessionsFriction,
	detectSessionAlerts,
	drainInbox,
	findSession,
	formatSessionsReport,
	groupWorkerSessions,
	listSessions,
	readTranscriptTail,
	removeSession,
	type SessionRecord,
	sendInboxMessage,
	updateSession,
	writeSession,
} from "../extensions/sessions.ts";
import sitraTower, { towerRules } from "../extensions/tower.ts";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "sitra-sessions-")));

const baseLead: SessionRecord = {
	id: "lead-flights",
	role: "lead",
	pid: 1001,
	cwd: "/work/app/.worktrees/flights",
	repo: "/work/app",
	branch: "feat/flights",
	sessionFile: "/profile/sessions/lead-flights.jsonl",
	paneId: "w1:p1",
	status: "working",
	task: "Fix roundtrip return date handling",
	startedAt: "2026-10-15T14:00:00.000Z",
	updatedAt: "2026-10-15T14:05:00.000Z",
};

describe("session registry", () => {
	test("writes, updates, lists and removes session records", () => {
		const profile = tmp();
		writeSession(profile, baseLead);
		expect(listSessions(profile, () => true)).toEqual([baseLead]);

		const updated = updateSession(profile, "lead-flights", {
			status: "waiting_for_user",
			waitingFor: "waiting for your answer",
			updatedAt: "2026-10-15T14:06:00.000Z",
		});
		expect(updated?.status).toBe("waiting_for_user");
		expect(listSessions(profile, () => true)[0]?.waitingFor).toBe("waiting for your answer");

		removeSession(profile, "lead-flights");
		expect(listSessions(profile, () => true)).toEqual([]);
	});

	test("marks a session whose process exited without cleanup as stopped", () => {
		const profile = tmp();
		writeSession(profile, baseLead);
		const listed = listSessions(profile, (pid) => pid !== 1001);
		expect(listed[0]?.status).toBe("stopped");
	});

	test("groups teammates under their parent worker lead and hides the tower itself", () => {
		const scout: SessionRecord = {
			id: "scout-1",
			role: "teammate",
			name: "flights-scout",
			agent: "scout",
			pid: 1002,
			cwd: "/work/app/.worktrees/flights",
			repo: "/work/app",
			branch: "feat/flights",
			parentSessionFile: baseLead.sessionFile,
			status: "working",
			task: "Find date helpers",
			startedAt: "2026-10-15T14:04:00.000Z",
			updatedAt: "2026-10-15T14:05:30.000Z",
		};
		const tower: SessionRecord = {
			id: "tower-1",
			role: "tower",
			name: "Radar",
			pid: 1003,
			cwd: "/work/app",
			repo: "/work/app",
			status: "idle",
			startedAt: "2026-10-15T14:00:00.000Z",
			updatedAt: "2026-10-15T14:05:00.000Z",
		};
		const groups = groupWorkerSessions([baseLead, scout, tower]);
		expect(groups).toEqual([{ lead: baseLead, teammates: [scout] }]);

		const report = formatSessionsReport([baseLead, scout, tower]);
		expect(report).toContain("app");
		expect(report).toContain("feat/flights");
		expect(report).toContain("Fix roundtrip return date handling");
		expect(report).toContain("flights-scout");
		expect(report).not.toContain("tower-1");
	});

	test("finds a session by id, teammate name, or branch/folder match", () => {
		const other: SessionRecord = {
			...baseLead,
			id: "lead-billing",
			cwd: "/work/billing",
			repo: "/work/billing",
			branch: "main",
		};
		const list = [baseLead, other];
		expect(findSession(list, "lead-flights")?.id).toBe("lead-flights");
		expect(findSession(list, "feat/flights")?.id).toBe("lead-flights");
		expect(findSession(list, "billing")?.id).toBe("lead-billing");
	});

	test("reads the tail of a Pi session transcript", () => {
		const jsonl = [
			JSON.stringify({ type: "session", id: "s1" }),
			JSON.stringify({ type: "message", message: { role: "user", content: "Check the date parser" } }),
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Reading parser.ts now." },
						{ type: "toolCall", name: "read", arguments: { path: "src/parser.ts" } },
					],
				},
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					toolName: "read",
					isError: true,
					content: [{ type: "text", text: "ENOENT: no such file" }],
				},
			}),
		].join("\n");
		const tail = readTranscriptTail(jsonl, 3);
		expect(tail).toEqual([
			{ role: "user", text: "Check the date parser" },
			{ role: "assistant", text: "Reading parser.ts now. [tool: read]" },
			{ role: "tool", text: "read error: ENOENT: no such file", error: true },
		]);
	});

	test("flags workers that are waiting on the person, stopped unexpectedly, stalled, or looping on tool errors", () => {
		const now = Date.parse("2026-10-15T14:20:00.000Z");
		const waiting: SessionRecord = {
			...baseLead,
			id: "w-wait",
			status: "waiting_for_user",
			waitingFor: "waiting for your answer",
			updatedAt: "2026-10-15T14:19:00.000Z",
		};
		const crashed: SessionRecord = {
			...baseLead,
			id: "w-crash",
			branch: "feat/crash",
			status: "stopped",
			updatedAt: "2026-10-15T14:18:00.000Z",
		};
		const looping: SessionRecord = {
			...baseLead,
			id: "w-loop",
			branch: "feat/loop",
			sessionFile: "/tmp/loop.jsonl",
			status: "working",
			updatedAt: "2026-10-15T14:19:30.000Z",
		};
		const stalled: SessionRecord = {
			...baseLead,
			id: "w-stall",
			branch: "feat/stall",
			status: "working",
			updatedAt: "2026-10-15T14:05:00.000Z",
		};
		const alerts = detectSessionAlerts(
			[waiting, crashed, looping, stalled],
			(file) =>
				file === "/tmp/loop.jsonl"
					? [
							{ role: "tool", text: "bash error: exit 1", error: true },
							{ role: "tool", text: "bash error: exit 1", error: true },
							{ role: "tool", text: "bash error: exit 1", error: true },
						]
					: [],
			now,
		);
		expect(alerts.map((a) => a.kind)).toEqual(["waiting_for_user", "stopped", "repeated_errors", "stalled"]);
	});

	test("aggregates tool errors and friction across sessions so the tower can suggest sitra improvements", () => {
		const s1: SessionRecord = { ...baseLead, id: "s1", sessionFile: "/tmp/s1.jsonl" };
		const s2: SessionRecord = {
			...baseLead,
			id: "s2",
			cwd: "/work/billing",
			repo: "/work/billing",
			branch: "main",
			sessionFile: "/tmp/s2.jsonl",
		};
		const audit = auditSessionsFriction([s1, s2], (f) =>
			f === "/tmp/s1.jsonl"
				? [
						{ role: "tool", text: "bash error: command timed out", error: true },
						{ role: "tool", text: "edit error: oldText not found", error: true },
					]
				: [{ role: "tool", text: "edit error: oldText not found", error: true }],
		);
		expect(audit.totalSessions).toBe(2);
		expect(audit.toolErrorCounts).toEqual({ edit: 2, bash: 1 });
		expect(audit.hotspots[0]).toContain("edit");
	});
});

describe("tower rules", () => {
	test("address the tower by its chosen name and the person by theirs", () => {
		const rules = towerRules("Sam", "Radar");
		expect(rules).toContain("Radar");
		expect(rules).toContain("Sam");
		expect(rules).toContain("list_sessions");
		expect(rules).toContain("read_session");
	});

	test("records a worker lifecycle and lets the tower inspect it through list_sessions and read_session", async () => {
		const profile = tmp();
		const prevDir = process.env.PI_CODING_AGENT_DIR;
		const prevRole = process.env.SITRA_ROLE;
		const prevTower = process.env.SITRA_TOWER_NAME;
		const prevUser = process.env.SITRA_USER_NAME;
		try {
			process.env.PI_CODING_AGENT_DIR = profile;
			process.env.SITRA_USER_NAME = "Sam";
			delete process.env.SITRA_ROLE;

			const workerHandlers = new Map<string, (event: unknown, ctx: unknown) => void>();
			const workerBus = new Map<string, (data: { active?: boolean }) => void>();
			sitraTower({
				on: (ev, fn) => workerHandlers.set(ev, fn as never),
				registerTool: () => {},
				events: { on: (ch, fn) => workerBus.set(ch, fn) },
			});

			const ctx = {
				cwd: "/work/checkout",
				sessionManager: {
					getSessionId: () => "worker-checkout",
					getSessionFile: () => undefined,
				},
			};
			workerHandlers.get("session_start")?.({}, ctx);
			workerHandlers.get("before_agent_start")?.(
				{ messageType: "user", prompt: "Fix double charge on retry", systemPromptOptions: { sections: {} } },
				ctx,
			);
			workerBus.get("rpiv:ask-user:blocked")?.({ active: true });

			process.env.SITRA_ROLE = "tower";
			process.env.SITRA_TOWER_NAME = "Radar";
			const towerHandlers = new Map<string, (event: unknown, ctx: unknown) => void>();
			const tools = new Map<
				string,
				{
					execute: (
						id: string,
						params: Record<string, unknown>,
						s: unknown,
						u: unknown,
						c: unknown,
					) => Promise<{ content: { text: string }[]; details: unknown }>;
				}
			>();
			sitraTower({
				on: (ev, fn) => towerHandlers.set(ev, fn as never),
				registerTool: (t) => tools.set(t.name, t as never),
				events: { on: () => {} },
			});

			const promptEvent = {
				messageType: "user",
				prompt: "status?",
				systemPromptOptions: { sections: {} as Record<string, string> },
			};
			towerHandlers.get("before_agent_start")?.(promptEvent, {
				cwd: "/work",
				sessionManager: { getSessionId: () => "tower-1" },
			});
			expect(promptEvent.systemPromptOptions.sections["sitra-tower"]).toContain("Radar");

			const listed = await tools.get("list_sessions")?.execute("1", {}, undefined, undefined, { cwd: "/work" });
			expect(listed?.content[0]?.text).toContain("worker-checkout");
			expect(listed?.content[0]?.text).toContain("waiting_for_user");
			expect(listed?.content[0]?.text).toContain("Fix double charge on retry");

			const detail = await tools
				.get("read_session")
				?.execute("2", { query: "checkout" }, undefined, undefined, { cwd: "/work" });
			expect((detail?.details as { found?: boolean } | undefined)?.found).toBe(true);

			workerHandlers.get("session_shutdown")?.({}, ctx);
			towerHandlers.get("session_shutdown")?.({}, { cwd: "/work" });
			expect(listSessions(profile, () => true)).toEqual([]);
		} finally {
			if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevDir;
			if (prevRole === undefined) delete process.env.SITRA_ROLE;
			else process.env.SITRA_ROLE = prevRole;
			if (prevTower === undefined) delete process.env.SITRA_TOWER_NAME;
			else process.env.SITRA_TOWER_NAME = prevTower;
			if (prevUser === undefined) delete process.env.SITRA_USER_NAME;
			else process.env.SITRA_USER_NAME = prevUser;
		}
	});

	test("delivers tower inbox messages to a worker between steps and delivers reply_tower back to the tower", async () => {
		const profile = tmp();
		const m1 = sendInboxMessage(profile, {
			id: "m1",
			from: "Radar",
			fromSessionId: "tower-1",
			toSessionId: "worker-checkout",
			text: "How is the retry fix going?",
			createdAt: "2026-10-15T14:10:00.000Z",
		});
		expect(m1.id).toBe("m1");
		expect(drainInbox(profile, "worker-checkout")).toEqual([m1]);
		expect(drainInbox(profile, "worker-checkout")).toEqual([]);

		const prevDir = process.env.PI_CODING_AGENT_DIR;
		const prevRole = process.env.SITRA_ROLE;
		const prevTower = process.env.SITRA_TOWER_NAME;
		try {
			process.env.PI_CODING_AGENT_DIR = profile;
			delete process.env.SITRA_ROLE;

			const workerHandlers = new Map<string, (event: unknown, ctx: unknown) => void>();
			const workerTools = new Map<
				string,
				{
					execute: (
						id: string,
						params: Record<string, unknown>,
						s: unknown,
						u: unknown,
						c: unknown,
					) => Promise<{ content: { text: string }[]; details: unknown }>;
				}
			>();
			const workerMessages: { customType: string; content: string }[] = [];
			sitraTower({
				on: (ev, fn) => workerHandlers.set(ev, fn as never),
				registerTool: (t) => workerTools.set(t.name, t as never),
				events: { on: () => {} },
				sendMessage: (msg) => workerMessages.push(msg),
			});

			const workerCtx = {
				cwd: "/work/checkout",
				sessionManager: { getSessionId: () => "worker-checkout", getSessionFile: () => undefined },
			};
			workerHandlers.get("session_start")?.({}, workerCtx);
			workerHandlers.get("before_agent_start")?.(
				{ messageType: "user", prompt: "Fix retry", systemPromptOptions: { sections: {} } },
				workerCtx,
			);

			process.env.SITRA_ROLE = "tower";
			process.env.SITRA_TOWER_NAME = "Radar";
			const towerHandlers = new Map<string, (event: unknown, ctx: unknown) => void>();
			const towerTools = new Map<
				string,
				{
					execute: (
						id: string,
						params: Record<string, unknown>,
						s: unknown,
						u: unknown,
						c: unknown,
					) => Promise<{ content: { text: string }[]; details: unknown }>;
				}
			>();
			const towerMessages: { customType: string; content: string }[] = [];
			sitraTower({
				on: (ev, fn) => towerHandlers.set(ev, fn as never),
				registerTool: (t) => towerTools.set(t.name, t as never),
				events: { on: () => {} },
				sendMessage: (msg) => towerMessages.push(msg),
			});
			const towerCtx = {
				cwd: "/work",
				sessionManager: { getSessionId: () => "tower-1", getSessionFile: () => undefined },
			};
			towerHandlers.get("session_start")?.({}, towerCtx);

			await towerTools
				.get("message_session")
				?.execute("1", { query: "checkout", message: "Any blockers?" }, undefined, undefined, towerCtx);
			expect(workerMessages).toEqual([]);

			workerHandlers.get("agent_end")?.({}, workerCtx);
			expect(workerMessages).toHaveLength(1);
			expect(workerMessages[0]?.content).toContain("Any blockers?");
			expect(workerMessages[0]?.content).toContain("reply_tower");

			await workerTools
				.get("reply_tower")
				?.execute("2", { message: "Tests green, opening PR next." }, undefined, undefined, workerCtx);
			towerHandlers.get("agent_end")?.({}, towerCtx);
			expect(towerMessages).toHaveLength(1);
			expect(towerMessages[0]?.content).toContain("Tests green, opening PR next.");

			workerHandlers.get("session_shutdown")?.({}, workerCtx);
			towerHandlers.get("session_shutdown")?.({}, towerCtx);
		} finally {
			if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevDir;
			if (prevRole === undefined) delete process.env.SITRA_ROLE;
			else process.env.SITRA_ROLE = prevRole;
			if (prevTower === undefined) delete process.env.SITRA_TOWER_NAME;
			else process.env.SITRA_TOWER_NAME = prevTower;
		}
	});
});

type Tool = {
	execute: (
		id: string,
		params: Record<string, unknown>,
		s: unknown,
		u: unknown,
		c: unknown,
	) => Promise<{ content: { text: string }[]; details: unknown }>;
};

/** Loads the extension as one Pi session would, with the given environment, and hands back its hooks and tools. */
function startSession(env: Record<string, string | undefined>) {
	const keys = [
		"PI_CODING_AGENT_DIR",
		"SITRA_ROLE",
		"SITRA_TOWER_NAME",
		"PI_SUBAGENT_NAME",
		"HERDR_ENV",
		"HERDR_PANE_ID",
		"PATH",
	];
	const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
	for (const k of keys) if (k !== "PATH") delete process.env[k];
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const tools = new Map<string, Tool>();
	const messages: { customType: string; content: string }[] = [];
	sitraTower({
		on: (ev, fn) => handlers.set(ev, fn as never),
		registerTool: (t) => tools.set(t.name, t as never),
		events: { on: () => {} },
		sendMessage: (msg) => messages.push(msg),
	});
	const restore = () => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	};
	const ctxFor = (id: string, cwd = "/work/checkout") => ({
		cwd,
		sessionManager: { getSessionId: () => id, getSessionFile: () => undefined },
	});
	return { handlers, tools, messages, restore, ctxFor };
}

describe("tower edge cases", () => {
	test("a teammate stays with the lead that started it, even when another lead in the same repo is more recent", () => {
		const older: SessionRecord = { ...baseLead, id: "lead-old", sessionFile: "/profile/sessions/old.jsonl" };
		const newer: SessionRecord = {
			...baseLead,
			id: "lead-new",
			cwd: "/work/app/.worktrees/billing",
			branch: "feat/billing",
			sessionFile: "/profile/sessions/new.jsonl",
			updatedAt: "2026-10-15T14:09:00.000Z",
		};
		const scout: SessionRecord = {
			...baseLead,
			id: "scout-1",
			role: "teammate",
			name: "flights-scout",
			cwd: "/work/app/.worktrees/billing",
			parentSessionFile: older.sessionFile,
		};
		const groups = groupWorkerSessions([newer, older, scout]);
		expect(groups.find((g) => g.lead.id === "lead-old")?.teammates.map((t) => t.id)).toEqual(["scout-1"]);
		expect(groups.find((g) => g.lead.id === "lead-new")?.teammates).toEqual([]);
	});

	test("a resumed session left behind by a crash shows as running, not stopped", () => {
		const profile = tmp();
		writeSession(profile, { ...baseLead, id: "worker-checkout", pid: 2_147_483_000 });
		const s = startSession({ PI_CODING_AGENT_DIR: profile });
		try {
			s.handlers.get("session_start")?.({}, s.ctxFor("worker-checkout"));
			const [record] = listSessions(profile);
			expect(record?.pid).toBe(process.pid);
			expect(record?.status).not.toBe("stopped");
		} finally {
			s.handlers.get("session_shutdown")?.({}, s.ctxFor("worker-checkout"));
			s.restore();
		}
	});

	test("a message sent before the worker's session id changed still reaches it", () => {
		const profile = tmp();
		const s = startSession({ PI_CODING_AGENT_DIR: profile });
		try {
			s.handlers.get("session_start")?.({}, s.ctxFor("first-id"));
			sendInboxMessage(profile, { from: "Radar", fromSessionId: "tower-1", toSessionId: "first-id", text: "ping" });
			s.handlers.get("session_start")?.({}, s.ctxFor("second-id"));
			s.handlers.get("agent_end")?.({}, s.ctxFor("second-id"));
			expect(s.messages.map((m) => m.customType)).toEqual(["sitra-inbox"]);
			expect(drainInbox(profile, "first-id")).toEqual([]);
		} finally {
			s.handlers.get("session_shutdown")?.({}, s.ctxFor("second-id"));
			s.restore();
		}
	});

	test("flags a worker retrying a failing tool one call at a time", () => {
		const call = { role: "assistant" as const, text: "[tool: bash]" };
		const fail = { role: "tool" as const, text: "bash error: exit 1", error: true };
		const looping: SessionRecord = { ...baseLead, id: "w-loop", sessionFile: "/tmp/loop.jsonl" };
		const alerts = detectSessionAlerts(
			[looping],
			() => [call, fail, call, fail, call, fail],
			Date.parse(baseLead.updatedAt),
		);
		expect(alerts.map((a) => a.kind)).toEqual(["repeated_errors"]);
	});

	test("does not flag a batch where some tool calls succeeded between the failures", () => {
		const fail = { role: "tool" as const, text: "bash error: exit 1", error: true };
		const ok = { role: "tool" as const, text: "read ok", error: false };
		const batch: SessionRecord = { ...baseLead, id: "w-batch", sessionFile: "/tmp/batch.jsonl" };
		const alerts = detectSessionAlerts(
			[batch],
			() => [{ role: "assistant", text: "[tool: bash, read, bash, read, bash]" }, fail, ok, fail, ok, fail],
			Date.parse(baseLead.updatedAt),
		);
		expect(alerts).toEqual([]);
	});

	test("the transcript tail keeps successful tool results, marked as not errors", () => {
		const jsonl = [
			JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "read", content: "file body" } }),
			JSON.stringify({
				type: "message",
				message: { role: "toolResult", toolName: "bash", isError: true, content: "exit 1" },
			}),
		].join("\n");
		expect(readTranscriptTail(jsonl)).toEqual([
			{ role: "tool", text: "read ok", error: false },
			{ role: "tool", text: "bash error: exit 1", error: true },
		]);
	});

	test("the audit counts only failed tool results", () => {
		const s1: SessionRecord = { ...baseLead, id: "s1", sessionFile: "/tmp/s1.jsonl" };
		const audit = auditSessionsFriction([s1], () => [
			{ role: "tool", text: "read ok", error: false },
			{ role: "tool", text: "bash error: exit 1", error: true },
		]);
		expect(audit.toolErrorCounts).toEqual({ bash: 1 });
	});

	test("refuses to message a session herdr shows but that has no sitra inbox", async () => {
		const profile = tmp();
		const bin = tmp();
		const sessionFile = join(profile, "sessions", "old_01a11bfb-8764-730a-8028-998d5abed1ab.jsonl");
		writeFileSync(
			join(bin, "herdr"),
			`#!/bin/sh\necho '${JSON.stringify({
				result: {
					agents: [
						{
							agent: "pi",
							agent_status: "idle",
							cwd: "/work/legacy",
							pane_id: "w9:p1",
							agent_session: { value: sessionFile },
						},
					],
				},
			})}'\n`,
		);
		chmodSync(join(bin, "herdr"), 0o755);
		const s = startSession({
			PI_CODING_AGENT_DIR: profile,
			SITRA_ROLE: "tower",
			HERDR_ENV: "1",
			HERDR_PANE_ID: "w0:p0",
			PATH: `${bin}:${process.env.PATH}`,
		});
		try {
			const towerCtx = s.ctxFor("tower-1", "/work");
			const listed = await s.tools.get("list_sessions")?.execute("1", {}, undefined, undefined, towerCtx);
			expect(listed?.content[0]?.text).toContain("01a11bfb-8764-730a-8028-998d5abed1ab");
			const sent = await s.tools
				.get("message_session")
				?.execute("2", { query: "legacy", message: "status?" }, undefined, undefined, towerCtx);
			expect((sent?.details as { sent?: boolean } | undefined)?.sent).toBe(false);
			expect(drainInbox(profile, "01a11bfb-8764-730a-8028-998d5abed1ab")).toEqual([]);
		} finally {
			s.restore();
		}
	});
});
