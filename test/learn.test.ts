import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { listEntries, listProposals, renderEntry } from "../extensions/grimoire.ts";
import {
	casesFromMoments,
	detectionPrompt,
	draftPrompt,
	learnFromMoment,
	momentFromTranscript,
	parseDraft,
	parseVerdict,
	pauseOutcomes,
	recordMoment,
	recordPause,
	recordPauseFollowUp,
} from "../extensions/learn.ts";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "sitra-learn-")));
const jsonl = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

describe("the moment: what the agent just did when the person spoke", () => {
	test("reads the agent's last reply and recent tool calls from a Pi transcript", () => {
		const text = jsonl([
			{ type: "session", cwd: "/work/app" },
			{ type: "message", message: { role: "user", content: "Fix the flaky eval" } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Running the whole suite." },
						{ type: "toolCall", name: "bash", arguments: { command: "pnpm test" } },
					],
				},
			},
			{ type: "message", message: { role: "toolResult", toolName: "bash", content: "ok" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "All green." }] } },
		]);
		const m = momentFromTranscript(text, { message: "don't run the whole suite", harness: "pi", cwd: "/work/app" });
		expect(m.agentReply).toBe("All green.");
		expect(m.calls).toEqual([{ tool: "bash", input: { command: "pnpm test" } }]);
		expect(m.message).toBe("don't run the whole suite");
		expect(m.harness).toBe("pi");
	});

	test("reads Claude Code transcripts too, and keeps only the most recent calls within limits", () => {
		const rows: unknown[] = [];
		for (let i = 0; i < 30; i++) {
			rows.push({
				type: "assistant",
				message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: `ls ${i}` } }] },
			});
		}
		rows.push({
			type: "assistant",
			message: { role: "assistant", content: [{ type: "text", text: "x".repeat(5000) }] },
		});
		const m = momentFromTranscript(jsonl(rows), { message: "no", harness: "claude", cwd: "/w" });
		expect(m.calls).toHaveLength(12);
		expect(m.calls.at(-1)).toEqual({ tool: "Bash", input: { command: "ls 29" } });
		expect(m.agentReply.length).toBeLessThanOrEqual(2_000);
		expect(momentFromTranscript("not json\n", { message: "hi", harness: "codex", cwd: "/w" }).calls).toEqual([]);
	});
});

describe("asking a model", () => {
	test("the detection prompt carries both sides, and only a clear YES counts", () => {
		const p = detectionPrompt({ agentReply: "I ran the suite.", message: "I said don't." });
		expect(p.system).toMatch(/YES/);
		expect(p.user).toContain("I ran the suite.");
		expect(p.user).toContain("I said don't.");
		expect(parseVerdict("YES")).toBe(true);
		expect(parseVerdict("yes.")).toBe(true);
		expect(parseVerdict("NO")).toBe(false);
		expect(parseVerdict("I think YES or NO")).toBe(false);
		expect(parseVerdict("")).toBe(false);
	});

	test("the draft prompt shows what Grimoire already holds, and drafts are validated", () => {
		const p = draftPrompt(
			{
				message: "open it as a draft",
				agentReply: "Opened the PR.",
				calls: [{ tool: "bash", input: { command: "gh pr create" } }],
			},
			"- [decision] Review in draft PRs (kinds/decisions/x.md)",
		);
		expect(p.user).toContain("Review in draft PRs");
		expect(p.user).toContain("gh pr create");
		expect(p.system).toMatch(/"skip"/);

		const good = parseDraft(
			'Here: {"kind":"setup","title":"Open PRs as drafts","summary":"Always pass --draft.","body":"The person wants drafts.","when":["command:gh pr create","made up"],"tags":["git"]}',
		);
		expect(good).toMatchObject({ kind: "setup", title: "Open PRs as drafts", when: ["command:gh pr create"] });
		expect(parseDraft('{"skip":"already covered by kinds/decisions/x.md"}')).toEqual({
			skip: "already covered by kinds/decisions/x.md",
		});
		expect(parseDraft('{"kind":"rumor","title":"t","summary":"s","body":"b"}')).toBeUndefined();
		expect(parseDraft("no json here")).toBeUndefined();
	});
});

describe("learning from a moment", () => {
	const moment = {
		id: "2026-10-20T10-00-00-abc",
		at: "2026-10-20T10:00:00.000Z",
		harness: "pi" as const,
		cwd: "/work/app",
		message: "I told you to open it as a draft",
		agentReply: "Opened the pull request.",
		calls: [{ tool: "bash", input: { command: "gh pr create --fill" } }],
	};

	test("a correction becomes a proposal quoting the person, and the moment is kept as a test case", async () => {
		const dir = tmp();
		recordMoment(dir, moment);
		const asked: string[] = [];
		const result = await learnFromMoment(dir, moment.id, async (system) => {
			asked.push(system);
			return asked.length === 1
				? "YES"
				: '{"kind":"setup","title":"Open pull requests as drafts","summary":"Pass --draft.","body":"Opened a ready PR.","when":["command:gh pr create"]}';
		});
		expect(result.verdict).toBe("correction");
		expect(result.proposal).toMatch(/^proposals\//);
		const [p] = listProposals(dir);
		expect(p?.title).toBe("Open pull requests as drafts");
		expect(p?.proposedBy).toBe("sitra-learn");
		expect(p?.when).toEqual(["command:gh pr create"]);
		expect(p?.evidence).toContain("I told you to open it as a draft");
		expect(p?.evidence).toContain(moment.id);

		const again = await learnFromMoment(dir, moment.id, async () => "YES");
		expect(again.verdict).toBe("already-done");
		expect(listProposals(dir)).toHaveLength(1);
	});

	test("not a correction: nothing proposed; a draft that says it's covered: nothing proposed; a failing model: nothing broken", async () => {
		const dir = tmp();
		recordMoment(dir, moment);
		expect((await learnFromMoment(dir, moment.id, async () => "NO")).verdict).toBe("other");
		const dir2 = tmp();
		recordMoment(dir2, moment);
		let n = 0;
		const covered = await learnFromMoment(dir2, moment.id, async () => (++n === 1 ? "YES" : '{"skip":"covered"}'));
		expect(covered).toMatchObject({ verdict: "correction", skipped: "covered" });
		expect(listProposals(dir2)).toEqual([]);
		const dir3 = tmp();
		recordMoment(dir3, moment);
		const failed = await learnFromMoment(dir3, moment.id, async () => {
			throw new Error("model down");
		});
		expect(failed.verdict).toBe("error");
		expect(listProposals(dir3)).toEqual([]);
		expect((await learnFromMoment(dir3, "missing", async () => "YES")).verdict).toBe("error");
	});

	test("corrections become replayable cases; an accepted proposal becomes the case's expected entry", async () => {
		const dir = tmp();
		recordMoment(dir, moment);
		let n = 0;
		await learnFromMoment(dir, moment.id, async () =>
			++n === 1 ? "YES" : '{"kind":"setup","title":"Drafts","summary":"s","body":"b","when":["command:gh pr create"]}',
		);
		expect(casesFromMoments(dir)).toEqual([
			{ id: moment.id, harness: "pi", cwd: "/work/app", calls: moment.calls, expect: [] },
		]);
		const [p] = listProposals(dir);
		const accepted = join(dir, "kinds", "setups");
		mkdirSync(accepted, { recursive: true });
		writeFileSync(
			join(accepted, (p?.file ?? "").replace("proposals/", "")),
			readFileSync(join(dir, p?.file ?? ""), "utf8"),
		);
		expect(casesFromMoments(dir)[0]?.expect).toEqual([`kinds/setups/${(p?.file ?? "").replace("proposals/", "")}`]);
	});
});

describe("did a pause help", () => {
	test("each pause is followed by the agent's next call: the same call means repeated, anything else means changed", () => {
		const dir = tmp();
		const rule = "kinds/setups/drafts.md";
		writeFileSync(join(dir, "x"), "");
		const later = { turn: "2" };
		recordPause(dir, "s1", [rule], { tool: "bash", input: { command: "gh pr create" } }, { turn: "1" });
		recordPauseFollowUp(dir, "s1", { tool: "bash", input: { command: "gh pr create" } }, later);
		recordPause(dir, "s2", [rule], { tool: "bash", input: { command: "gh pr create" } }, { turn: "1" });
		recordPauseFollowUp(dir, "s2", { tool: "bash", input: { command: "gh pr create --draft" } }, later);
		recordPauseFollowUp(dir, "s2", { tool: "bash", input: { command: "ls" } }, later);
		recordPauseFollowUp(dir, "s3", { tool: "bash", input: { command: "ls" } }, later);
		expect(pauseOutcomes(dir)).toEqual([{ file: rule, pauses: 2, changed: 1, repeated: 1 }]);
		expect(existsSync(join(dir, ".sitra", "pauses.jsonl"))).toBe(true);
	});

	test("an approved entry's renderEntry still round-trips with when, for the learn proposals", () => {
		const dir = tmp();
		mkdirSync(join(dir, "kinds", "setups"), { recursive: true });
		writeFileSync(
			join(dir, "kinds", "setups", "a.md"),
			renderEntry({ kind: "setup", title: "A", body: "b", date: "2026-10-20", when: ["tool:bash"] }),
		);
		expect(listEntries(dir)[0]?.when).toEqual(["tool:bash"]);
	});
});

describe("capturing moments in Pi, Claude Code and Codex", () => {
	test("Pi records a moment for each message the person sends (not for helpers or system-started turns), and records pause outcomes", async () => {
		const { default: sitraKnowledge } = await import("../extensions/knowledge.ts");
		const dir = tmp();
		const session = join(dir, "session.jsonl");
		writeFileSync(
			session,
			jsonl([
				{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "I opened the PR." }] } },
			]),
		);
		mkdirSync(join(dir, "kinds", "setups"), { recursive: true });
		writeFileSync(
			join(dir, "kinds", "setups", "drafts.md"),
			renderEntry({
				kind: "setup",
				title: "Drafts",
				body: "Pass --draft.",
				date: "2026-10-20",
				when: ["command:gh pr create"],
			}),
		);
		const saved = { ...process.env };
		Object.assign(process.env, { SITRA_GRIMOIRE: dir, SITRA_LEARN_SPAWN: "0" });
		delete process.env.PI_SUBAGENT_NAME;
		delete process.env.SITRA_GRIMOIRE_LEARN;
		try {
			const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
			sitraKnowledge({
				on: (n: string, h: (event: unknown, ctx: unknown) => unknown) => handlers.set(n, h),
				registerTool() {},
				registerCommand() {},
				sendUserMessage() {},
			} as never);
			const ctx = {
				cwd: "/work/app",
				hasUI: false,
				ui: { setStatus() {}, notify() {} },
				sessionManager: { getSessionFile: () => session, getSessionId: () => "s1" },
			};
			const start = (event: object) =>
				handlers.get("before_agent_start")?.({ systemPromptOptions: { sections: {} }, ...event }, ctx);
			start({ messageType: "user", prompt: "I said open it as a draft" });
			start({ messageType: "custom", message: {} });
			const moments = join(dir, ".sitra", "moments");
			const files = (await import("node:fs")).readdirSync(moments);
			expect(files).toHaveLength(1);
			const m = JSON.parse(readFileSync(join(moments, files[0] ?? ""), "utf8"));
			expect(m).toMatchObject({ harness: "pi", message: "I said open it as a draft", agentReply: "I opened the PR." });

			const call = (command: string) =>
				handlers.get("tool_call")?.({ type: "tool_call", toolCallId: "1", toolName: "bash", input: { command } }, ctx);
			handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 0 }, ctx);
			expect(call("gh pr create")).toMatchObject({ block: true });
			call("ls");
			expect(pauseOutcomes(dir)).toEqual([]);
			handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 1 }, ctx);
			call("gh pr create --draft");
			expect(pauseOutcomes(dir)).toEqual([{ file: "kinds/setups/drafts.md", pauses: 1, changed: 1, repeated: 0 }]);

			process.env.SITRA_GRIMOIRE_LEARN = "0";
			start({ messageType: "user", prompt: "another" });
			expect((await import("node:fs")).readdirSync(moments)).toHaveLength(1);
		} finally {
			for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
			Object.assign(process.env, saved);
		}
	});

	test("the prompt hook records a moment from the transcript and stays silent; the learn command decides it", async () => {
		const { runGrimoireCli } = await import("../cli/grimoire.ts");
		const dir = tmp();
		const transcript = join(dir, "t.jsonl");
		writeFileSync(
			transcript,
			jsonl([
				{
					type: "assistant",
					message: {
						role: "assistant",
						content: [{ type: "tool_use", name: "Bash", input: { command: "gh pr create" } }],
					},
				},
				{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Opened it." }] } },
			]),
		);
		const out: string[] = [];
		const deps = {
			home: tmp(),
			env: { SITRA_LEARN_SPAWN: "0" },
			repoRoot: "/opt/sitra",
			cwd: "/w",
			readStdin: () =>
				JSON.stringify({
					session_id: "c1",
					cwd: "/w",
					prompt: "draft, I said",
					transcript_path: transcript,
					hook_event_name: "UserPromptSubmit",
				}),
			log: (l: string) => out.push(l),
			ask: async (system: string) =>
				system.includes("Reply with exactly YES")
					? "YES"
					: '{"kind":"setup","title":"Drafts please","summary":"s","body":"b","when":["command:gh pr create"]}',
		};
		expect(runGrimoireCli(["hook", "claude", "prompt", "--dir", dir], deps)).toBe(0);
		expect(out.join("")).toBe("");
		expect(casesFromMoments(dir)).toEqual([]);
		await runGrimoireCli(["learn", "--dir", dir], deps);
		await new Promise((r) => setTimeout(r, 50));
		expect(listProposals(dir).map((p) => p.title)).toEqual(["Drafts please"]);
		expect(casesFromMoments(dir)[0]?.calls).toEqual([{ tool: "Bash", input: { command: "gh pr create" } }]);
		expect(runGrimoireCli(["hook", "claude", "prompt", "--dir", dir], { ...deps, readStdin: () => "nonsense" })).toBe(
			0,
		);
	});
});

describe("fixes from review", () => {
	const base = {
		at: "2026-10-20T10:00:00.000Z",
		harness: "pi" as const,
		cwd: "/w",
		message: "you did it wrong",
		agentReply: "done",
		calls: [],
	};

	test("a learner that died leaves no lasting lock, and old locks never starve newer moments", async () => {
		const dir = tmp();
		const { learnAll } = await import("../cli/grimoire.ts");
		for (let i = 0; i < 11; i++) recordMoment(dir, { ...base, id: `m${String(i).padStart(2, "0")}` });
		mkdirSync(join(dir, ".sitra", "learning"), { recursive: true });
		for (let i = 0; i < 10; i++)
			writeFileSync(join(dir, ".sitra", "learning", `m${String(i).padStart(2, "0")}`), "999999999-dead");
		let calls = 0;
		await learnAll(
			dir,
			async () => {
				calls++;
				return "NO";
			},
			() => {},
		);
		expect(calls).toBe(10);
		const busy = tmp();
		for (let i = 0; i < 11; i++) recordMoment(busy, { ...base, id: `m${String(i).padStart(2, "0")}` });
		mkdirSync(join(busy, ".sitra", "learning"), { recursive: true });
		for (let i = 0; i < 10; i++) {
			writeFileSync(join(busy, ".sitra", "learning", `m${String(i).padStart(2, "0")}`), `${process.ppid}-live`);
		}
		let busyCalls = 0;
		await learnAll(
			busy,
			async () => {
				busyCalls++;
				return "NO";
			},
			() => {},
			1,
		);
		expect(busyCalls).toBe(1);
	});

	test("taking over a dead learner's claim gives exactly one owner, and a release only frees your own claim", async () => {
		const { claimMoment, releaseMoment } = await import("../extensions/learn.ts");
		const dir = tmp();
		mkdirSync(join(dir, ".sitra", "learning"), { recursive: true });
		writeFileSync(join(dir, ".sitra", "learning", "x"), "999999999-dead");
		const a = claimMoment(dir, "x");
		const b = claimMoment(dir, "x");
		expect([a, b].filter(Boolean)).toHaveLength(1);
		writeFileSync(join(dir, ".sitra", "learning", "half"), "");
		expect(claimMoment(dir, "half")).toBe(false);
		const { readdirSync: ls } = await import("node:fs");
		expect(ls(join(dir, ".sitra", "learning")).filter((f) => f.includes("."))).toEqual([]);
		writeFileSync(join(dir, ".sitra", "learning", "y"), `${process.ppid}-someone-else`);
		releaseMoment(dir, "y");
		expect(existsSync(join(dir, ".sitra", "learning", "y"))).toBe(true);
	});

	test("a message that isn't a correction keeps nothing but its verdict", async () => {
		const dir = tmp();
		recordMoment(dir, { ...base, id: "p1", message: "here is TOKEN_EXAMPLE for you" });
		await learnFromMoment(dir, "p1", async () => "NO");
		const saved = readFileSync(join(dir, ".sitra", "moments", "p1.json"), "utf8");
		expect(saved).not.toContain("TOKEN_EXAMPLE");
		expect(JSON.parse(saved)).toEqual({ id: "p1", at: base.at, harness: "pi", verdict: "other" });
	});

	test("Codex transcripts: assistant output_text, function calls with JSON arguments, custom tool calls", () => {
		const text = jsonl([
			{
				type: "response_item",
				payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"gh pr create --fill"}' },
			},
			{ type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: "text(1)" } },
			{
				type: "response_item",
				payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Opened PR." }] },
			},
			{
				type: "response_item",
				payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
			},
		]);
		const odd = jsonl([
			{
				type: "response_item",
				payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":[{"toString":null}]}' },
			},
			{ type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: { toString: null } } },
			{
				type: "response_item",
				payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Still here." }] },
			},
		]);
		expect(momentFromTranscript(odd, { message: "x", harness: "codex", cwd: "/w" }).agentReply).toBe("Still here.");
		const m = momentFromTranscript(text, { message: "draft!", harness: "codex", cwd: "/w" });
		expect(m.agentReply).toBe("Opened PR.");
		expect(m.calls).toEqual([
			{ tool: "Bash", input: { cmd: "gh pr create --fill", command: "gh pr create --fill" } },
			{ tool: "exec", input: { input: "text(1)" } },
		]);
	});

	test("the duplicate check sees the root, waiting proposals and rejected ones", async () => {
		const dir = tmp();
		mkdirSync(join(dir, "root"));
		writeFileSync(
			join(dir, "root", "README.md"),
			`# Root\n${"Some context.\n".repeat(1100)}Never add emojis to commits.\n`,
		);
		mkdirSync(join(dir, "rejected"));
		writeFileSync(
			join(dir, "rejected", "r.md"),
			renderEntry({ kind: "lesson", title: "Rejected idea", body: "b", date: "2026-10-01" }),
		);
		mkdirSync(join(dir, "proposals"));
		writeFileSync(
			join(dir, "proposals", "p.md"),
			renderEntry({ kind: "lesson", title: "Waiting idea", body: "b", date: "2026-10-01" }),
		);
		recordMoment(dir, { ...base, id: "d1" });
		const prompts: string[] = [];
		await learnFromMoment(dir, "d1", async (_s, user) => {
			prompts.push(user);
			return prompts.length === 1 ? "YES" : '{"skip":"covered"}';
		});
		expect(prompts[1]).toContain("Never add emojis to commits.");
		expect(prompts[1]).toContain("Waiting idea");
		expect(prompts[1]).toContain("Rejected idea");
	});

	test("calls from the same turn as a pause never count as the agent's reaction to it", () => {
		const dir = tmp();
		recordPause(dir, "s", ["kinds/a.md"], { tool: "bash", input: { command: "a" } }, { turn: "t1" });
		recordPauseFollowUp(dir, "s", { tool: "bash", input: { command: "b" } }, { turn: "t1" });
		expect(pauseOutcomes(dir)).toEqual([]);
		recordPauseFollowUp(dir, "s", { tool: "bash", input: { command: "a" } }, { turn: "t2" });
		expect(pauseOutcomes(dir)).toEqual([{ file: "kinds/a.md", pauses: 1, changed: 0, repeated: 1 }]);
		const noTurn = tmp();
		const t0 = 1_000_000;
		recordPause(noTurn, "s", ["kinds/a.md"], { tool: "bash", input: { command: "a" } }, { now: t0 });
		recordPauseFollowUp(noTurn, "s", { tool: "bash", input: { command: "b" } }, { now: t0 + 200 });
		expect(pauseOutcomes(noTurn)).toEqual([]);
		recordPauseFollowUp(noTurn, "s", { tool: "bash", input: { command: "b" } }, { now: t0 + 5_000 });
		expect(pauseOutcomes(noTurn)[0]?.changed).toBe(1);
	});

	test("parallel pauses in one session each get an outcome, and key order doesn't make a repeat look like a change", () => {
		const dir = tmp();
		recordPause(dir, "s", ["kinds/a.md"], { tool: "bash", input: { command: "a", cwd: "/w" } }, { turn: "1" });
		recordPause(dir, "s", ["kinds/b.md"], { tool: "bash", input: { command: "b" } }, { turn: "1" });
		recordPauseFollowUp(dir, "s", { tool: "bash", input: { cwd: "/w", command: "a" } }, { turn: "2" });
		expect(pauseOutcomes(dir)).toEqual([
			{ file: "kinds/a.md", pauses: 1, changed: 0, repeated: 1 },
			{ file: "kinds/b.md", pauses: 1, changed: 1, repeated: 0 },
		]);
	});
});

describe("the daily tally and repeats", () => {
	const at = (h: number) => new Date(2026, 9, 20, h).toISOString();
	test("caught counts pauses that changed the agent's course; learned and repeats come from corrections; only today", async () => {
		const { tally, repeats, markRepeatSeen } = await import("../extensions/learn.ts");
		const { appendFileSync } = await import("node:fs");
		const dir = tmp();
		mkdirSync(join(dir, ".sitra"), { recursive: true });
		const pause = (h: number, outcome: string) =>
			appendFileSync(
				join(dir, ".sitra", "pauses.jsonl"),
				`${JSON.stringify({ at: at(h), file: "kinds/a.md", outcome })}\n`,
			);
		pause(9, "changed");
		pause(10, "repeated");
		appendFileSync(
			join(dir, ".sitra", "pauses.jsonl"),
			`${JSON.stringify({ at: new Date(2026, 9, 19, 23).toISOString(), file: "x", outcome: "changed" })}\n`,
		);
		const m = { harness: "pi" as const, cwd: "/w", message: "no", agentReply: "", calls: [] };
		recordMoment(dir, { ...m, id: "a", at: at(9), verdict: "correction", proposal: "proposals/x.md" });
		recordMoment(dir, {
			...m,
			id: "b",
			at: at(11),
			message: "you said you'd start it",
			verdict: "correction",
			skipped: "Already covered by 'Own the thread'",
		});
		recordMoment(dir, { ...m, id: "c", at: at(12), verdict: "other" });
		recordMoment(dir, {
			...m,
			id: "d",
			at: new Date(2026, 9, 19, 12).toISOString(),
			verdict: "correction",
			skipped: "old",
		});
		const now = new Date(2026, 9, 20, 18);
		expect(tally(dir, now)).toEqual({ caught: 1, learned: 1, repeats: 1 });
		expect(repeats(dir).map((r) => r.id)).toEqual(["d", "b"]);
		expect(repeats(dir).find((r) => r.id === "b")).toMatchObject({
			message: "you said you'd start it",
			covered: "Already covered by 'Own the thread'",
		});
		markRepeatSeen(dir, "b");
		expect(repeats(dir).map((r) => r.id)).toEqual(["d"]);
		expect(tally(dir, now).repeats).toBe(1);
		expect(tally(tmp(), now)).toEqual({ caught: 0, learned: 0, repeats: 0 });
	});
});
