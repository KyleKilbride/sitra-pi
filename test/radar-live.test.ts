import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	collectRadarSnapshot,
	type RadarSnapshot,
	type RunLiveness,
	type RunProcessIdentity,
	type RunSummary,
	type WorkerCard,
} from "../extensions/radar.ts";
import { initialRadarState, liveStatus } from "../extensions/radar-model.ts";
import { parseMailSnapshot } from "../extensions/radar-store.ts";
import { buildRadarLayout } from "../extensions/radar-view.ts";
import { EXIT_MARKER, HEADER_MARKER, paneCommand, type RunMeta, readRun, readRunHeader } from "../extensions/runs.ts";

const NOW = Date.parse("2026-10-21T16:00:00Z");
const tmp = () => mkdtempSync(join(tmpdir(), "sitra-radar-live-"));
const currentProcessIdentity = () => {
	try {
		const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
		const start = stat
			.slice(stat.lastIndexOf(") ") + 2)
			.trim()
			.split(/\s+/)[19];
		if (start) return { kind: "proc", value: start };
	} catch {}
	const start = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8" })
		.trim()
		.replace(/\s+/g, " ");
	return { kind: "ps-lstart", value: start };
};

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
			paneCommand("echo hello", log, {
				label: "unit tests",
				project: "app",
				branch: "feat/x",
				agent: "lead",
				sessionId: "session-1",
			} satisfies RunMeta),
		]);
		const text = readFileSync(log, "utf8");
		const header = readRunHeader(text.split("\n")[0] ?? "");
		expect(header?.pid).toBeGreaterThan(1);
		expect((header as { pidStart?: string } | undefined)?.pidStart).toMatch(/\S/);
		expect((header as { pidStartKind?: string } | undefined)?.pidStartKind).toMatch(/^(proc|ps-lstart)$/);
		expect(header?.meta).toEqual({
			label: "unit tests",
			project: "app",
			branch: "feat/x",
			agent: "lead",
			sessionId: "session-1",
		});
		expect(readRun(text)).toMatchObject({ done: true, exitCode: 0, tail: "hello" });
	});
	test("a log without a header has no owner", () => {
		expect(readRunHeader("plain")).toBeUndefined();
	});
	test("macOS ps start times are parsed from run headers", () => {
		expect(
			readRunHeader(
				'__SITRA_RUN__={"pid":123,"pidStart":"Wed Oct 21 17:31:40 2026","pidStartKind":"ps-lstart","meta":{"label":"tests"}}',
			),
		).toMatchObject({
			pid: 123,
			pidStart: "Wed Oct 21 17:31:40 2026",
			pidStartKind: "ps-lstart",
			meta: { label: "tests" },
		});
	});

	const profileWithRuns = () => {
		const profile = tmp();
		const dir = join(profile, "runs");
		mkdirSync(dir, { recursive: true });
		const liveIdentity = currentProcessIdentity();
		const header = (pid: number, identity = liveIdentity) =>
			`__SITRA_RUN__={"pid":${pid},"pidStart":"${identity.value}","pidStartKind":"${identity.kind}","meta":{"label":"evals","project":"app","branch":"feat/y"}}\n`;
		writeFileSync(join(dir, "2026-10-21T15-55-00-000Z-live.log"), `${header(process.pid)}running…\n`);
		writeFileSync(
			join(dir, "2026-10-21T15-50-00-000Z-dead.log"),
			`${header(2 ** 22 - 3, { kind: "proc", value: "1" })}died mid-run\n`,
		);
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
	test("nonce exit parsing uses the first header even when the tail omits it", () => {
		const profile = tmp();
		const dir = join(profile, "runs");
		mkdirSync(dir, { recursive: true });
		const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
		writeFileSync(
			join(dir, "2026-10-21T15-59-00-000Z-long.log"),
			`${HEADER_MARKER}${JSON.stringify({ pid: process.pid, pidStart: currentProcessIdentity().value, pidStartKind: currentProcessIdentity().kind, meta: { label: "long", nonce: "abc", command: "x".repeat(3000) } })}\n${body}\n${EXIT_MARKER}abc=0\n`,
		);
		const snap = collectRadarSnapshot(profile, { nowMs: NOW });
		expect(snap.runs[0]).toMatchObject({ label: "long", state: "passed", done: true, exitCode: 0 });
	});
	test("an invalid run header affects only that run", () => {
		const profile = tmp();
		const dir = join(profile, "runs");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "2026-10-21T15-59-00-000Z-bad.log"), `${HEADER_MARKER}{bad}\n${EXIT_MARKER}0\n`);
		writeFileSync(join(dir, "2026-10-21T15-58-00-000Z-good.log"), `legacy ok\n${EXIT_MARKER}0\n`);
		const snap = collectRadarSnapshot(profile, { nowMs: NOW });
		expect(snap.runs).toHaveLength(2);
		expect(snap.runs.find((run) => run.label === "bad")).toMatchObject({ state: "unknown", done: false });
		expect(snap.runs.find((run) => run.label === "good")).toMatchObject({ state: "passed", done: true });
	});
	test("a reused pid with a different process start token is stopped", () => {
		const profile = tmp();
		const dir = join(profile, "runs");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "2026-10-21T15-57-00-000Z-reused.log"),
			`__SITRA_RUN__={"pid":${process.pid},"pidStart":"definitely-not-this-process","pidStartKind":"proc","meta":{"label":"reused pid","project":"app","agent":"lead","sessionId":"session-1"}}\nwork still pending\n`,
		);
		const snap = collectRadarSnapshot(profile, { nowMs: NOW });
		expect(snap.runs[0]).toMatchObject({
			state: "stopped",
			project: "app",
			agent: "lead",
			sessionId: "session-1",
		});
	});
	test("macOS ps start identity is used to decide whether a run is still running", () => {
		const profile = tmp();
		const dir = join(profile, "runs");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "2026-10-21T15-56-00-000Z-mac.log"),
			'__SITRA_RUN__={"pid":123,"pidStart":"Wed Oct 21 17:31:40 2026","pidStartKind":"ps-lstart","meta":{"label":"mac run","project":"app"}}\nwork still pending\n',
		);
		const identities: unknown[] = [];
		const snap = collectRadarSnapshot(profile, {
			nowMs: NOW,
			pidAlive: (_: number, identity?: RunProcessIdentity): RunLiveness => {
				identities.push(identity);
				return identity?.kind === "ps-lstart" && identity.value === "Wed Oct 21 17:31:40 2026" ? "running" : "stopped";
			},
		});
		expect(snap.runs[0]).toMatchObject({ state: "running", project: "app" });
		expect(identities).toEqual([{ kind: "ps-lstart", value: "Wed Oct 21 17:31:40 2026" }]);
	});
	test("a new-format unfinished run with no start identity is unknown, not running", () => {
		const profile = tmp();
		const dir = join(profile, "runs");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "2026-10-21T15-56-30-000Z-no-identity.log"),
			`__SITRA_RUN__={"pid":${process.pid},"meta":{"label":"no identity","project":"app"}}\nwork still pending\n`,
		);
		const snap = collectRadarSnapshot(profile, {
			nowMs: NOW,
			pidAlive: (): RunLiveness => "unknown",
		});
		expect(snap.runs[0]).toMatchObject({ state: "unknown", project: "app" });
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
	test("finished runs are not treated as finished work", () => {
		const snap: RadarSnapshot = {
			...base,
			runs: [
				run("ok", "passed", { exitCode: 0 }),
				run("bad", "failed", { exitCode: 1 }),
				run("old", "passed", { exitCode: 0, updatedAt: "2026-10-20T09:00:00Z" }),
			],
		};
		const done = liveStatus(snap, NOW).done.join("\n");
		expect(done).not.toContain("label-ok");
		expect(done).not.toContain("label-bad");
		expect(done).not.toContain("label-old");
	});
	test("finished test runs do not count as finished work", () => {
		const snap: RadarSnapshot = {
			...base,
			runs: [run("ok", "passed", { exitCode: 0, project: "app", label: "unit tests" })],
		};
		expect(liveStatus(snap, NOW).done.join("\n")).not.toContain("unit tests");
	});
	test("open pull requests are live status items", () => {
		const status = liveStatus(
			{
				...base,
				pullRequests: [
					{
						id: "app#23",
						project: "app",
						number: 23,
						title: "Radar live status",
						branch: "krskl/radar-live-status",
						url: "https://example.test/pr/23",
						isDraft: true,
					},
				],
			} as RadarSnapshot,
			NOW,
		);
		expect(status.next.join("\n")).toContain("PR #23 draft");
		expect(status.next.join("\n")).toContain("Radar live status");
	});
	test("tower notes are shown above live items and exact duplicate notes are not repeated", () => {
		const snap: RadarSnapshot = {
			...base,
			workers: [worker(1, "working", { nowLine: "fixing the cabin filter" })],
			summary: {
				done: ["tower finished item"],
				doing: ["repo-1 (branch-1) — fixing the cabin filter", "tower top note"],
				next: [],
				updatedAt: "2026-10-21T15:55:00Z",
			},
		};
		const status = liveStatus(snap, NOW);
		expect(status.doing[0]).toBe("repo-1 (branch-1) — fixing the cabin filter");
		expect(status.doing[1]).toBe("tower top note");
		expect(status.doing.filter((line) => line.includes("fixing the cabin filter"))).toHaveLength(1);
		expect(status.done[0]).toBe("tower finished item");
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
	test("mail rows show incoming first, then who, subject and delivery on a single line", () => {
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
		expect(lines[0]).toContain("subject-a");
		expect(lines[0]).toContain("peer/agent");
		expect(lines[1]).toContain("subject-b");
		expect(lines[1]).toContain("delivery unknown");
	});
	test("mail rows use structured subject, preview and delivery instead of reading meaning from state text", () => {
		const items = parseMailSnapshot({
			items: [
				{
					id: "sent",
					peer: "teammate",
					direction: "out",
					state: "confirmed by legacy text but structured delivery says no",
					delivery: { confirmed: false, status: "queued" },
					subject: "Real subject",
					summary: "Body first line that must not become the subject",
					preview: "one line preview",
					body: "Body first line that must not become the subject\nsecond line",
					updatedAt: "2026-10-21T15:59:00Z",
				},
				{
					id: "in",
					peer: "worker",
					direction: "in",
					state: "received",
					delivery: { confirmed: true, status: "received" },
					subject: "Incoming subject",
					preview: "incoming preview",
					updatedAt: "2026-10-20T15:59:00Z",
				},
			],
		}).items;
		expect(items.map((item) => item.id)).toEqual(["in", "sent"]);
		const layout = buildRadarLayout(
			{ ...base, mail: items },
			{ cols: 120, rows: 30, nowMs: NOW, state: { ...initialRadarState(), view: "mail" } },
		);
		const text = layout.body.join("\n");
		expect(text).toContain("Incoming subject");
		expect(text).toContain("Real subject");
		expect(text).toContain("one line preview");
		expect(text).toContain("[queued]");
		expect(text).toContain("date unknown");
		expect(text).not.toContain("Body first line that must not become the subject");
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
			run("r1", "running", {
				project: "app",
				branch: "feat/y",
				label: "evals",
				agent: "lead",
				sessionId: "lead-1",
			}),
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
		expect(text).toContain("lead");
		expect(text).toContain("lead-1");
		expect(text).toContain("stopped");
		expect(layout.header.join("\n")).toContain("1 active");
	});
});
