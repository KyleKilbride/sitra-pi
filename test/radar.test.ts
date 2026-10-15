import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { rememberProject, writeProposal } from "../extensions/kb.ts";
import {
	brailleSparkline,
	collectRadarSnapshot,
	renderRadarFrame,
	renderSprite,
	type VisualState,
	visibleWidth,
} from "../extensions/radar.ts";
import { EXIT_MARKER } from "../extensions/runs.ts";
import { type SessionRecord, writeSession } from "../extensions/sessions.ts";
import sitraTower from "../extensions/tower.ts";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "sitra-radar-")));

describe("braille sparklines", () => {
	test("encodes zero activity as blank braille cells and rising activity into rising dot rows", () => {
		expect(brailleSparkline([0, 0, 0, 0], 2)).toBe("⠀⠀");
		const rising = brailleSparkline([0, 1, 2, 3, 4, 4], 3);
		expect([...rising]).toHaveLength(3);
		expect(rising.endsWith("⣿")).toBe(true);
		expect(rising[0]).not.toBe("⣿");
	});
});

describe("half-block pixel sprites", () => {
	test("draws a 4-row half-block pixel character for every state and animates across ticks", () => {
		const states: VisualState[] = ["working", "waiting_for_user", "error_loop", "idle", "stopped"];
		for (const state of states) {
			const frame0 = renderSprite(state, 0);
			const frame1 = renderSprite(state, 1);
			expect(frame0).toHaveLength(4);
			expect(frame1).toHaveLength(4);
			for (const row of frame0) {
				expect(visibleWidth(row)).toBe(10);
			}
			expect(frame0.join("\n")).not.toBe(frame1.join("\n"));
		}
		expect(renderSprite("working", 0).join("\n")).not.toBe(renderSprite("waiting_for_user", 0).join("\n"));
		expect(renderSprite("error_loop", 0).join("\n")).not.toBe(renderSprite("idle", 0).join("\n"));
	});
});

describe("radar snapshot and frame", () => {
	test("collects workers, teammates, error loops, runs, kb proposals and peer mail into a bounded frame", () => {
		const profile = tmp();
		const repo = tmp();
		rememberProject(profile, repo);
		writeProposal(join(repo, ".pi", "knowledge"), {
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
			JSON.stringify([
				{
					id: "task-1",
					peer: "operator/main",
					direction: "in",
					state: "WORKING",
					summary: "Provisioning karl-bot client ID with Infra",
					updatedAt: "2026-10-15T16:30:00.000Z",
				},
			]),
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

		const frame = renderRadarFrame(snap, { cols: 88, rows: 34, tick: 0 });
		const lines = frame.split("\n");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(88);
		}
		expect(frame).toContain("Ron");
		expect(frame).toContain("travelagent-ai");
		expect(frame).toContain("flights-scout");
		expect(frame).toContain("wF:p1");
		expect(frame).toContain("unit-tests");
		expect(frame).toContain("operator/main");
	});

	test("tower auto-opens the radar in a right-hand herdr pane on start and reuses it on /radar", async () => {
		const profile = tmp();
		const bin = tmp();
		const logFile = join(bin, "herdr-calls.log");
		writeFileSync(
			join(bin, "herdr"),
			`#!/bin/sh
echo "$@" >> "${logFile}"
if [ "$1" = "pane" ] && [ "$2" = "split" ]; then
  echo '{"result":{"pane_id":"wR:p2"}}'
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

			const calls = readFileSync(logFile, "utf8").trim().split("\n");
			expect(calls.filter((c) => c.startsWith("pane split --current --direction right"))).toHaveLength(1);
			expect(calls.some((c) => c === "pane run wR:p2 sitra radar")).toBe(true);

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
});
