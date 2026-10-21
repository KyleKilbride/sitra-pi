import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { collectRadarSnapshot, type RadarSnapshot, type RunSummary, type WorkerCard } from "../extensions/radar.ts";
import { initialRadarState, liveStatus } from "../extensions/radar-model.ts";
import { parseMailSnapshot } from "../extensions/radar-store.ts";
import { buildRadarLayout } from "../extensions/radar-view.ts";
import { EXIT_MARKER, paneCommand, readRun, readRunHeader } from "../extensions/runs.ts";

const NOW = Date.parse("2026-10-21T16:00:00Z");
const tmp = () => mkdtempSync(join(tmpdir(), "sitra-radar-live-"));

const worker = (
	index: number,
	visualState: WorkerCard["visualState"],
	extra: Partial<WorkerCard> = {},
): WorkerCard => ({
	index,
	title: `repo-${index}`,
	subtitle: `branch-${index}`,
	lead: {
		id: `lead-${index}`,
		role: "lead",
		pid: process.pid,
		cwd: "/work/app",
		repo: "/work/app",
		status: "idle",
		startedAt: "2026-10-21T10:00:00Z",
		updatedAt: "2026-10-21T10:00:00Z",
	},
	teammates: [],
	activeHelpers: 0,
	visualState,
	activity: [],
	...extra,
});
const run = (id: string, state: RunSummary["state"], extra: Partial<RunSummary> = {}): RunSummary => ({
	id,
	label: `label-${id}`,
	state,
	done: state !== "running" && state !== "stopped",
	updatedAt: "2026-10-21T15:50:00Z",
	...extra,
});
const base: RadarSnapshot = { towerName: "Tower", workers: [], alerts: [], runs: [], pendingProposals: 0, mail: [] };

describe("runs know who started them and whether they are still alive", () => {
	test("the pane command records the shell pid and who started the run, and the header stays out of the output", () => {
		const log = join(tmp(), "run.log");
		execFileSync("bash", [
			"-c",
			paneCommand("echo hello", log, { label: "unit tests", project: "app", branch: "feat/x" }),
		]);
		const text = readFileSync(log, "utf8");
		const header = readRunHeader(text.split("\n")[0] ?? "");
		expect(header?.pid).toBeGreaterThan(1);
		expect(header?.meta).toEqual({ label: "unit tests", project: "app", branch: "feat/x" });
		expect(readRun(text)).toMatchObject({ done: true, exitCode: 0, tail: "hello" });
	});
	test("a log without a header has no owner", () => {
		expect(readRunHeader("plain")).toBeUndefined();
	});

	const profileWithRuns = () => {
		const profile = tmp();
		const dir = join(profile, "runs");
		mkdirSync(dir, { recursive: true });
		const header = (pid: number) =>
			`__SITRA_RUN__={"pid":${pid},"meta":{"label":"evals","project":"app","branch":"feat/y"}}\n`;
		writeFileSync(join(dir, "2026-10-21T15-55-00-000Z-live.log"), `${header(process.pid)}running…\n`);
		writeFileSync(join(dir, "2026-10-21T15-50-00-000Z-dead.log"), `${header(2 ** 22 - 3)}died mid-run\n`);
		writeFileSync(join(dir, "2026-10-21T15-40-00-000Z-ok.log"), `${header(process.pid)}fine\n${EXIT_MARKER}0\n`);
		const old = join(dir, "2026-10-08T10-00-00-000Z-legacy.log");
		writeFileSync(old, "no header, never finished\n");
		const longAgo = new Date(NOW - 3 * 3600_000);
		utimesSync(old, longAgo, longAgo);
		const recent = join(dir, "2026-10-21T15-58-00-000Z-legacy-recent.log");
		writeFileSync(recent, "no header, still writing\n");
		utimesSync(recent, new Date(NOW - 60_000), new Date(NOW - 60_000));
		return profile;
	};
	test("a run whose process is gone is stopped, not running forever", () => {
		const snap = collectRadarSnapshot(profileWithRuns(), { nowMs: NOW });
		const byLabel = Object.fromEntries(snap.runs.map((r) => [r.id.split("Z-")[1], r]));
		expect(byLabel["live.log"]).toMatchObject({ state: "running", done: false, project: "app", branch: "feat/y" });
		expect(byLabel["dead.log"]).toMatchObject({ state: "stopped", done: false });
		expect(byLabel["ok.log"]).toMatchObject({ state: "passed", done: true, exitCode: 0 });
		expect(byLabel["legacy.log"]).toMatchObject({ state: "stopped" });
		expect(byLabel["legacy-recent.log"]).toMatchObject({ state: "running" });
		expect(byLabel["live.log"]?.label).toBe("evals");
	});
	test("running runs come first, then newest", () => {
		const snap = collectRadarSnapshot(profileWithRuns(), { nowMs: NOW });
		expect(snap.runs[0]?.state).toBe("running");
		const states = snap.runs.map((r) => r.state);
		expect(states.indexOf("running")).toBeLessThan(states.indexOf("passed"));
		expect(states.lastIndexOf("running")).toBeLessThan(states.indexOf("passed"));
	});
});

describe("status is derived from live state, not only from what the tower last wrote", () => {
	test("working workers, running runs and waiting workers show up with who and what", () => {
		const snap: RadarSnapshot = {
			...base,
			workers: [
				worker(1, "working", { nowLine: "fixing the cabin filter" }),
				worker(2, "waiting_for_user", { lead: { ...worker(2, "idle").lead, waitingFor: "which airport" } }),
				worker(3, "idle"),
			],
			runs: [run("r1", "running", { project: "app", branch: "feat/y", label: "evals" })],
		};
		const status = liveStatus(snap, NOW);
		const doing = status.doing.join("\n");
		expect(doing).toContain("repo-1");
		expect(doing).toContain("fixing the cabin filter");
		expect(doing).toContain("repo-2");
		expect(doing).toContain("which airport");
		expect(doing).toContain("evals");
		expect(doing).not.toContain("repo-3");
		expect(status.doing[0]).toContain("repo-2");
	});
	test("recent finished runs are done, old ones are not, failures say so", () => {
		const snap: RadarSnapshot = {
			...base,
			runs: [
				run("ok", "passed", { exitCode: 0 }),
				run("bad", "failed", { exitCode: 1 }),
				run("old", "passed", { exitCode: 0, updatedAt: "2026-10-20T09:00:00Z" }),
			],
		};
		const done = liveStatus(snap, NOW).done.join("\n");
		expect(done).toContain("label-ok");
		expect(done).toContain("label-bad");
		expect(done).not.toContain("label-old");
		expect(done.split("\n").find((l) => l.includes("label-bad"))).not.toBe(
			done.split("\n").find((l) => l.includes("label-ok")),
		);
	});
	test("tower notes are kept and marked old once they go stale; proposals are next", () => {
		const fresh = liveStatus(
			{
				...base,
				pendingProposals: 2,
				summary: { done: ["d"], doing: ["g"], next: ["n"], updatedAt: "2026-10-21T15:55:00Z" },
			},
			NOW,
		);
		expect(fresh.done).toContain("d");
		expect(fresh.doing).toContain("g");
		expect(fresh.next).toContain("n");
		expect(fresh.next.join("\n")).toContain("2");
		expect(fresh.notesUpdatedAt).toBe("2026-10-21T15:55:00.000Z");
		const stale = liveStatus(
			{ ...base, summary: { done: [], doing: ["old claim"], next: [], updatedAt: "2026-10-21T10:00:00Z" } },
			NOW,
		);
		expect(stale.doing.join("\n")).toContain("old claim");
		expect(stale.doing.join("\n")).toContain("6h");
	});
	test("the status page and the pinned box both show live data", () => {
		const snap: RadarSnapshot = { ...base, workers: [worker(1, "working", { nowLine: "live-marker" })] };
		const summary = buildRadarLayout(snap, {
			cols: 100,
			rows: 30,
			nowMs: NOW,
			state: { ...initialRadarState(), view: "summary" },
		});
		expect(summary.body.join("\n")).toContain("live-marker");
		expect(summary.summary.join("\n")).toContain("live-marker");
	});
});

describe("mailbox and runs lists are one readable line each", () => {
	test("mail rows show when, who and the subject on a single line, newest first", () => {
		const mail = [
			{
				id: "a",
				peer: "peer/agent",
				direction: "in" as const,
				state: "received",
				summary: "subject-a",
				updatedAt: "2026-10-21T14:00:00Z",
			},
			{
				id: "b",
				peer: "peer/agent",
				direction: "out" as const,
				state: "delivery uncertain",
				summary: "subject-b",
				updatedAt: "2026-10-21T15:00:00Z",
			},
		];
		const layout = buildRadarLayout(
			{ ...base, mail: parseMailSnapshot({ items: mail }).items },
			{ cols: 100, rows: 30, nowMs: NOW, state: { ...initialRadarState(), view: "mail" } },
		);
		const lines = layout.body.filter((l) => l.includes("subject-"));
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("subject-b");
		expect(lines[0]).toContain("peer/agent");
		expect(lines[0]).toContain("uncertain");
		expect(lines[1]).toContain("subject-a");
	});
	test("messages with an approximate date sort after dated ones and say so", () => {
		const items = parseMailSnapshot({
			items: [
				{
					id: "x",
					peer: "p",
					direction: "out",
					state: "delivery confirmed",
					summary: "guess",
					updatedAt: "2026-10-21T15:59:00Z",
					dateApproximate: true,
				},
				{ id: "y", peer: "p", direction: "in", state: "received", summary: "known", updatedAt: "2026-10-01T09:00:00Z" },
			],
		}).items;
		expect(items.map((i) => i.id)).toEqual(["y", "x"]);
		const layout = buildRadarLayout(
			{ ...base, mail: items },
			{ cols: 100, rows: 30, nowMs: NOW, state: { ...initialRadarState(), view: "mail" } },
		);
		expect(layout.body.find((l) => l.includes("guess"))).toContain("date unknown");
	});
	test("run rows name the project and branch that started them and say when stopped", () => {
		const runs = [
			run("r1", "running", { project: "app", branch: "feat/y", label: "evals" }),
			run("r2", "stopped", { label: "dead", project: "app" }),
		];
		const layout = buildRadarLayout(
			{ ...base, runs },
			{ cols: 100, rows: 30, nowMs: NOW, state: { ...initialRadarState(), view: "runs" } },
		);
		const text = layout.body.join("\n");
		expect(text).toContain("running");
		expect(text).toContain("app");
		expect(text).toContain("feat/y");
		expect(text).toContain("stopped");
		expect(layout.header.join("\n")).toContain("1 active");
	});
});
