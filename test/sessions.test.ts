import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	findSession,
	formatSessionsReport,
	groupWorkerSessions,
	listSessions,
	readTranscriptTail,
	removeSession,
	type SessionRecord,
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
			{ role: "tool", text: "read error: ENOENT: no such file" },
		]);
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

			const listed = await tools.get("list_sessions")!.execute("1", {}, undefined, undefined, { cwd: "/work" });
			expect(listed.content[0]?.text).toContain("worker-checkout");
			expect(listed.content[0]?.text).toContain("waiting_for_user");
			expect(listed.content[0]?.text).toContain("Fix double charge on retry");

			const detail = await tools
				.get("read_session")!
				.execute("2", { query: "checkout" }, undefined, undefined, { cwd: "/work" });
			expect((detail.details as { found: boolean }).found).toBe(true);

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
});
