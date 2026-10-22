import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { writeProposal } from "../extensions/grimoire.ts";
import {
	collectRadarSnapshot,
	collectWorkerRepos,
	createFolderLookupCache,
	createRefreshScheduler,
	createTranscriptCache,
	frameUpdate,
	renderRadarFrame,
	visibleWidth,
} from "../extensions/radar.ts";
import { readTowerSummary } from "../extensions/radar-store.ts";
import { EXIT_MARKER } from "../extensions/runs.ts";
import { type SessionRecord, writeSession } from "../extensions/sessions.ts";
import sitraTower from "../extensions/tower.ts";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "sitra-radar-")));

describe("radar snapshot and frame", () => {
	test("collects workers, teammates, error loops, runs, Grimoire proposals and peer mail into a bounded frame", () => {
		const profile = tmp();
		writeProposal(join(profile, "grimoire"), {
			kind: "lesson",
			title: "Always check live state",
			body: "Read session state before reporting.",
			evidence: "extensions/tower.ts",
			proposedBy: "agent",
			date: "2026-10-15T16:00:00.000Z",
		});

		const loopTranscript = join(profile, "loop.jsonl");
		const failLine = JSON.stringify({
			type: "message",
			message: { role: "toolResult", toolName: "bash", isError: true, content: "exit 1" },
		});
		writeFileSync(loopTranscript, [failLine, failLine, failLine].join("\n"));

		const workingLead: SessionRecord = {
			id: "lead-1",
			role: "lead",
			pid: process.pid,
			cwd: "/work/travelagent-ai/.worktrees/flights",
			repo: "/work/travelagent-ai",
			branch: "sre",
			sessionFile: "/tmp/lead-1.jsonl",
			paneId: "wF:p1",
			status: "working",
			task: "Verify E2E flight cards",
			startedAt: "2026-10-15T16:00:00.000Z",
			updatedAt: "2026-10-15T16:29:50.000Z",
		};
		const scout: SessionRecord = {
			id: "scout-1",
			role: "teammate",
			name: "flights-scout",
			agent: "scout",
			pid: process.pid,
			cwd: workingLead.cwd,
			repo: workingLead.repo,
			parentSessionFile: workingLead.sessionFile,
			status: "working",
			startedAt: "2026-10-15T16:28:00.000Z",
			updatedAt: "2026-10-15T16:29:55.000Z",
		};
		const loopingLead: SessionRecord = {
			id: "lead-2",
			role: "lead",
			pid: process.pid,
			cwd: "/work/billing",
			repo: "/work/billing",
			branch: "feat/retry",
			sessionFile: loopTranscript,
			paneId: "wH:p1",
			status: "working",
			task: "Fix webhook retry",
			startedAt: "2026-10-15T16:00:00.000Z",
			updatedAt: "2026-10-15T16:29:40.000Z",
		};
		writeSession(profile, workingLead);
		writeSession(profile, scout);
		writeSession(profile, loopingLead);

		const runsDir = join(profile, "runs");
		mkdirSync(runsDir, { recursive: true });
		const logFile = join(runsDir, "2026-10-15T16-29-00-000Z-unit-tests.log");
		writeFileSync(logFile, `PASS src/flights.test.ts\n${EXIT_MARKER}0\n`);

		writeFileSync(
			join(profile, "sitra-mail.json"),
			JSON.stringify({
				items: [
					{
						id: "task-1",
						peer: "operator/main",
						direction: "in",
						state: "WORKING",
						summary: "Provisioning karl-bot client ID with Infra",
						updatedAt: "2026-10-15T16:30:00.000Z",
					},
				],
			}),
		);

		const snap = collectRadarSnapshot(profile, {
			nowMs: Date.parse("2026-10-15T16:30:00.000Z"),
			towerName: "Ron",
		});
		expect(snap.towerName).toBe("Ron");
		expect(snap.workers).toHaveLength(2);
		const w1 = snap.workers.find((w) => w.lead.id === "lead-1");
		const w2 = snap.workers.find((w) => w.lead.id === "lead-2");
		expect(w1?.visualState).toBe("working");
		expect(w1?.teammates).toHaveLength(1);
		expect(w2?.visualState).toBe("error_loop");
		expect(snap.pendingProposals).toBe(1);
		expect(snap.runs[0]?.done).toBe(true);
		expect(snap.mail[0]?.peer).toBe("operator/main");

		const frame0 = renderRadarFrame(snap, { cols: 88, rows: 34, tick: 0 });
		const frame1 = renderRadarFrame(snap, { cols: 88, rows: 34, tick: 1 });
		const lines0 = frame0.split("\n");
		const lines1 = frame1.split("\n");
		expect(lines0.length).toBe(lines1.length);
		for (let i = 0; i < lines0.length; i++) {
			expect(visibleWidth(lines0[i] ?? "")).toBe(88);
			expect(visibleWidth(lines1[i] ?? "")).toBe(88);
		}
		expect(frame0).not.toContain("⚡");
		expect(frame0).toContain("Ron");
		expect(frame0).toContain("travelagent-ai");
		expect(frame1).toBe(frame0);
		expect(frame0).not.toMatch(/[▀▄]/u);
		expect(renderRadarFrame(snap, { cols: 88, rows: 34, state: { view: "runs", selected: 0, scroll: 0 } })).toContain(
			"unit-tests",
		);
		expect(renderRadarFrame(snap, { cols: 88, rows: 34, state: { view: "mail", selected: 0, scroll: 0 } })).toContain(
			"operator/main",
		);

		const narrowSnap = {
			...snap,
			workers: snap.workers.map((w) => ({ ...w, lead: { ...w.lead, task: "Fix 🚀 flight search ⚡" } })),
		};
		const narrow = renderRadarFrame(narrowSnap, { cols: 36, rows: 24, tick: 0 });
		for (const line of narrow.split("\n")) {
			expect(visibleWidth(line)).toBe(36);
		}
	});

	test("tower auto-opens the radar in a right-hand herdr pane on start, focuses or restarts it on /radar", async () => {
		const profile = tmp();
		const bin = tmp();
		const logFile = join(bin, "herdr-calls.log");
		const titleFile = join(bin, "pane-title.txt");
		writeFileSync(titleFile, "sitra radar");
		writeFileSync(
			join(bin, "herdr"),
			`#!/bin/sh
echo "$@" >> "${logFile}"
if [ "$1" = "pane" ] && [ "$2" = "split" ]; then
  echo '{"result":{"pane_id":"wR:p2"}}'
elif [ "$1" = "pane" ] && [ "$2" = "get" ]; then
  title=$(cat "${titleFile}")
  echo "{\\"result\\":{\\"pane\\":{\\"pane_id\\":\\"wR:p2\\",\\"terminal_title\\":\\"$title\\"}}}"
fi
`,
		);
		chmodSync(join(bin, "herdr"), 0o755);

		const saved = {
			PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
			SITRA_ROLE: process.env.SITRA_ROLE,
			HERDR_ENV: process.env.HERDR_ENV,
			HERDR_PANE_ID: process.env.HERDR_PANE_ID,
			PATH: process.env.PATH,
		};
		process.env.PI_CODING_AGENT_DIR = profile;
		process.env.SITRA_ROLE = "tower";
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "wR:p1";
		process.env.PATH = `${bin}:${process.env.PATH}`;

		try {
			const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
			const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
			sitraTower({
				on: (ev, fn) => handlers.set(ev, fn as never),
				registerTool: () => {},
				registerCommand: (name, cmd) => commands.set(name, cmd as never),
				events: { on: () => {} },
			});

			const ctx = { cwd: "/work", sessionManager: { getSessionId: () => "tower-1" } };
			handlers.get("session_start")?.({}, ctx);
			await commands.get("radar")?.handler("", ctx);

			let calls = readFileSync(logFile, "utf8").trim().split("\n");
			expect(calls.filter((c) => c.startsWith("pane split --current --direction right"))).toHaveLength(1);
			expect(calls.filter((c) => c === "pane run wR:p2 sitra radar --tui")).toHaveLength(1);
			expect(calls.some((c) => c === "pane focus --current --direction right")).toBe(true);

			writeFileSync(titleFile, "zsh");
			await commands.get("radar")?.handler("", ctx);
			calls = readFileSync(logFile, "utf8").trim().split("\n");
			expect(calls.filter((c) => c === "pane run wR:p2 sitra radar --tui")).toHaveLength(2);

			handlers.get("session_shutdown")?.({}, ctx);
			const afterShutdown = readFileSync(logFile, "utf8").trim().split("\n");
			expect(afterShutdown.some((c) => c === "pane close wR:p2")).toBe(true);
		} finally {
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	});

	test("removes its session record when the pane sends SIGHUP", () => {
		const profile = tmp();
		const saved = {
			PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
			SITRA_ROLE: process.env.SITRA_ROLE,
			SITRA_NO_RADAR: process.env.SITRA_NO_RADAR,
		};
		process.env.PI_CODING_AGENT_DIR = profile;
		process.env.SITRA_ROLE = "tower";
		process.env.SITRA_NO_RADAR = "1";
		try {
			const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
			sitraTower({
				on: (event, fn) => handlers.set(event, fn as never),
				registerTool: () => {},
				registerCommand: () => {},
				events: { on: () => {} },
			});
			const ctx = { cwd: profile, sessionManager: { getSessionId: () => "tower-sighup" } };
			handlers.get("session_start")?.({}, ctx);
			const record = join(profile, "sitra-sessions", "tower-sighup.json");
			expect(existsSync(record)).toBe(true);
			process.emit("SIGHUP", "SIGHUP");
			expect(existsSync(record)).toBe(false);
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	test("herdr workspace view keeps the lead when a teammate tab is focused, preserves stopped leads, and clears answered questions", () => {
		const profile = tmp();
		const bin = tmp();
		const leadTranscript = join(profile, "lead.jsonl");
		writeFileSync(
			leadTranscript,
			[
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								name: "ask_user_question",
								arguments: { questions: [{ question: "Which branch should we target?" }] },
							},
						],
					},
				}),
				JSON.stringify({ type: "message", message: { role: "user", content: "staging" } }),
				JSON.stringify({
					type: "message",
					message: { role: "assistant", content: [{ type: "text", text: "Targeting staging now." }] },
				}),
			].join("\n"),
		);

		const lead: SessionRecord = {
			id: "lead-ws",
			role: "lead",
			pid: process.pid,
			cwd: "/work/app",
			repo: "/work/app",
			branch: "staging",
			sessionFile: leadTranscript,
			paneId: "wH:p1",
			status: "idle",
			startedAt: "2026-10-15T16:00:00.000Z",
			updatedAt: "2026-10-15T16:10:00.000Z",
		};
		const teammate: SessionRecord = {
			id: "tm-ws",
			role: "teammate",
			name: "tips-tester",
			agent: "app-tester",
			pid: process.pid,
			cwd: "/work/app",
			repo: "/work/app",
			sessionFile: join(profile, "tm.jsonl"),
			parentSessionFile: leadTranscript,
			paneId: "wH:p4",
			status: "idle",
			startedAt: "2026-10-15T16:05:00.000Z",
			updatedAt: "2026-10-15T16:09:00.000Z",
		};
		const crashed: SessionRecord = {
			id: "lead-crashed",
			role: "lead",
			pid: 2_147_483_000,
			cwd: "/work/crashed",
			repo: "/work/crashed",
			branch: "fix/crash",
			paneId: "wZ:p1",
			status: "working",
			startedAt: "2026-10-15T15:00:00.000Z",
			updatedAt: "2026-10-15T15:30:00.000Z",
		};
		writeSession(profile, lead);
		writeSession(profile, teammate);
		writeSession(profile, crashed);

		writeFileSync(
			join(bin, "herdr"),
			`#!/bin/sh
if [ "$1" = "workspace" ] && [ "$2" = "list" ]; then
  echo '{"result":{"workspaces":[{"workspace_id":"wH","number":3,"label":"[3] Flight-tips review","active_tab_id":"wH:t2","agent_status":"idle"}]}}'
elif [ "$1" = "tab" ] && [ "$2" = "list" ]; then
  echo '{"result":{"tabs":[{"tab_id":"wH:t1","label":"[1] travelagent › pi"},{"tab_id":"wH:t2","label":"[2] [app-tester] Test travel tips"}]}}'
elif [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  echo '{"result":{"agents":[{"workspace_id":"wH","tab_id":"wH:t1","pane_id":"wH:p1","agent":"pi","agent_status":"idle","cwd":"/work/app","agent_session":{"value":"${leadTranscript}"}},{"workspace_id":"wH","tab_id":"wH:t2","pane_id":"wH:p4","agent":"pi","agent_status":"idle","cwd":"/work/app","agent_session":{"value":"${teammate.sessionFile}"}}]}}'
fi
`,
		);
		chmodSync(join(bin, "herdr"), 0o755);

		const savedEnv = { HERDR_ENV: process.env.HERDR_ENV, PATH: process.env.PATH };
		process.env.HERDR_ENV = "1";
		process.env.PATH = `${bin}:${process.env.PATH}`;
		try {
			const snap = collectRadarSnapshot(profile, { includeHerdr: true, towerName: "Ron" });
			const wsCard = snap.workers.find((w) => w.workspaceId === "wH");
			expect(wsCard?.lead.id).toBe("lead-ws");
			expect(wsCard?.tabId).toBe("wH:t1");
			expect(wsCard?.teammates.map((t) => t.id)).toEqual(["tm-ws"]);
			expect(wsCard?.nowLine).toBeUndefined();
			expect(wsCard?.lastLine).toBe("Targeting staging now.");

			const crashedCard = snap.workers.find((w) => w.lead.id === "lead-crashed");
			expect(crashedCard?.visualState).toBe("stopped");
			expect(crashedCard?.index).toBe(4);
		} finally {
			for (const [k, v] of Object.entries(savedEnv)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	});
});

describe("radar summary tool", () => {
	test("publishes explicit status and restores its tool on resumed towers", async () => {
		const profile = tmp();
		const saved = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, SITRA_ROLE: process.env.SITRA_ROLE };
		process.env.PI_CODING_AGENT_DIR = profile;
		process.env.SITRA_ROLE = "tower";
		try {
			const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
			const tools = new Map<
				string,
				{ execute(id: string, params: { done: string[]; doing: string[]; next: string[] }): Promise<unknown> }
			>();
			const setActiveTools = vi.fn();
			sitraTower({
				on: (event, fn) => handlers.set(event, fn as never),
				registerTool: (tool) => tools.set(tool.name, tool as never),
				registerCommand: () => {},
				events: { on: () => {} },
				getActiveTools: () => ["read"],
				setActiveTools,
			});
			const value = { done: ["verified-marker"], doing: ["in-progress-marker"], next: [] };
			await tools.get("update_radar_status")?.execute("test", value);
			expect(readTowerSummary(profile)).toMatchObject(value);
			const ctx = { cwd: profile, sessionManager: { getSessionId: () => "tower-status" } };
			handlers.get("before_agent_start")?.(
				{ prompt: "status", messageType: "user", systemPromptOptions: { sections: {} } },
				ctx,
			);
			expect(setActiveTools).toHaveBeenCalledWith(expect.arrayContaining(["read", "update_radar_status"]));
			handlers.get("session_shutdown")?.({}, ctx);
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});

describe("radar refresh cost", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("reads transcripts only through the tail reader it is given", () => {
		const profile = tmp();
		const transcript = join(profile, "huge.jsonl");
		writeFileSync(transcript, "not the tail\n");
		writeSession(profile, {
			id: "lead-huge",
			role: "lead",
			pid: process.pid,
			cwd: "/work/app",
			repo: "/work/app",
			sessionFile: transcript,
			status: "working",
			startedAt: "2026-10-16T10:00:00.000Z",
			updatedAt: "2026-10-16T10:00:00.000Z",
		});
		const asked: string[] = [];
		const tail = JSON.stringify({
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "Only the tail was read." }] },
		});
		const snap = collectRadarSnapshot(profile, {
			nowMs: Date.parse("2026-10-16T10:01:00.000Z"),
			readLines: (file) => {
				asked.push(file);
				return tail;
			},
		});
		expect(asked.length).toBeGreaterThan(0);
		expect(asked.every((f) => f === transcript)).toBe(true);
		expect(snap.workers[0]?.lastLine).toBe("Only the tail was read.");
	});

	test("does not run gh while collecting a refresh snapshot", () => {
		const profile = tmp();
		const repo = join(profile, "repo");
		const bin = join(profile, "bin");
		const marker = join(profile, "gh-called");
		mkdirSync(repo, { recursive: true });
		mkdirSync(bin, { recursive: true });
		writeFileSync(
			join(bin, "gh"),
			`#!/bin/sh
echo called > "${marker}"
echo '[]'
`,
		);
		chmodSync(join(bin, "gh"), 0o755);
		writeSession(profile, {
			id: "lead-gh",
			role: "lead",
			pid: process.pid,
			cwd: repo,
			repo,
			status: "idle",
			startedAt: "2026-10-16T10:00:00.000Z",
			updatedAt: "2026-10-16T10:00:00.000Z",
		});
		const savedPath = process.env.PATH;
		process.env.PATH = `${bin}:${process.env.PATH}`;
		try {
			collectRadarSnapshot(profile, {
				pullRequests: { items: [], notices: [] },
			});
			expect(() => readFileSync(marker, "utf8")).toThrow();
		} finally {
			process.env.PATH = savedPath;
		}
	});

	test("reuses cached folder git lookups on the next unchanged refresh", () => {
		const profile = tmp();
		const repo = join(profile, "repo");
		let gitCalls = 0;
		mkdirSync(repo, { recursive: true });
		writeSession(profile, {
			id: "lead-git",
			role: "lead",
			pid: process.pid,
			cwd: repo,
			repo,
			status: "idle",
			startedAt: "2026-10-16T10:00:00.000Z",
			updatedAt: "2026-10-16T10:00:00.000Z",
		});
		const folders = createFolderLookupCache({
			mainCheckout: (cwd) => {
				gitCalls++;
				return cwd;
			},
			gitBranch: () => {
				gitCalls++;
				return "main";
			},
		});
		let snap = collectRadarSnapshot(profile, { folders });
		collectWorkerRepos(snap.workers, folders);
		gitCalls = 0;
		snap = collectRadarSnapshot(profile, { folders });
		collectWorkerRepos(snap.workers, folders);
		expect(gitCalls).toBe(0);
	});

	test("parses an unchanged transcript tail once across refreshes", () => {
		const profile = tmp();
		const transcript = join(profile, "lead.jsonl");
		writeFileSync(
			transcript,
			`${JSON.stringify({
				type: "message",
				timestamp: "2026-10-16T10:00:00.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "Parsed once." }] },
			})}\n`,
		);
		writeSession(profile, {
			id: "lead-parse",
			role: "lead",
			pid: process.pid,
			cwd: profile,
			repo: profile,
			sessionFile: transcript,
			status: "working",
			startedAt: "2026-10-16T10:00:00.000Z",
			updatedAt: "2026-10-16T10:00:00.000Z",
		});
		let parses = 0;
		const transcripts = createTranscriptCache(
			(file) => readFileSync(file, "utf8"),
			(line) => {
				parses++;
				return JSON.parse(line);
			},
		);
		collectRadarSnapshot(profile, { transcripts });
		collectRadarSnapshot(profile, { transcripts });
		expect(parses).toBe(1);
	});

	test("bursts of refresh requests run at most once per interval, with one trailing refresh", () => {
		vi.useFakeTimers();
		let runs = 0;
		const scheduler = createRefreshScheduler(() => runs++, 1000);
		scheduler.request();
		expect(runs).toBe(1);
		for (let i = 0; i < 50; i++) {
			vi.advanceTimersByTime(2);
			scheduler.request();
		}
		expect(runs).toBe(1);
		vi.advanceTimersByTime(1000);
		expect(runs).toBe(2);
		vi.advanceTimersByTime(5000);
		expect(runs).toBe(2);
		scheduler.request();
		expect(runs).toBe(3);
		scheduler.request();
		scheduler.cancel();
		vi.advanceTimersByTime(5000);
		expect(runs).toBe(3);
	});

	test("redraws only the screen lines that changed", () => {
		const first = frameUpdate(undefined, ["a", "b", "c"]);
		expect(first).toContain("\x1b[1;1Ha\x1b[K");
		expect(first).toContain("\x1b[3;1Hc\x1b[K");
		expect(frameUpdate(["a", "b", "c"], ["a", "b", "c"])).toBe("");
		const one = frameUpdate(["a", "b", "c"], ["a", "B", "c"]);
		expect(one).toContain("\x1b[2;1HB\x1b[K");
		expect(one).not.toContain("\x1b[1;1H");
		expect(one).not.toContain("\x1b[3;1H");
		const shorter = frameUpdate(["a", "b", "c"], ["a"]);
		expect(shorter).toContain("\x1b[2;1H\x1b[2K");
		expect(shorter).toContain("\x1b[3;1H\x1b[2K");
		expect(shorter).not.toContain("\x1b[1;1H");
	});
});
