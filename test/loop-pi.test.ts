import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	briefHash,
	buildBrief,
	createLoopState,
	LOOP_RUN_MARKER,
	type LoopState,
	staleReason,
} from "../extensions/loop.ts";
import sitraLoop, { loopStatePath, readLoopStateFile, writeLoopStateFile } from "../extensions/loop-pi.ts";
import { EXIT_MARKER } from "../extensions/runs.ts";

vi.setConfig({ testTimeout: 30_000 });

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { description: string; handler(args: string, ctx: unknown): Promise<void> }>();
	const tools = new Map<
		string,
		{
			description: string;
			execute(
				id: string,
				params: Record<string, unknown>,
				signal: unknown,
				onUpdate: unknown,
				ctx: unknown,
			): Promise<{ content: { text: string }[]; details: unknown }>;
		}
	>();
	const userMessages: string[] = [];
	sitraLoop({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerCommand: (
			name: string,
			command: { description: string; handler(args: string, ctx: unknown): Promise<void> },
		) => commands.set(name, command),
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
		sendUserMessage: (message: string) => userMessages.push(message),
	} as never);
	return { handlers, commands, tools, userMessages };
}

const ctx = (cwd: string, messages: string[] = []) => ({
	cwd,
	ui: {
		setStatus() {},
		notify: (message: string) => messages.push(message),
	},
});

function gitWorktree(options: { originHead?: boolean } = { originHead: true }): { cwd: string; head: string } {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-work-")));
	execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
	writeFileSync(join(cwd, "README.md"), "test\n");
	execFileSync("git", ["add", "README.md"], { cwd, stdio: "ignore" });
	execFileSync("git", ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "initial"], {
		cwd,
		stdio: "ignore",
	});
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
	execFileSync("git", ["remote", "add", "origin", cwd], { cwd, stdio: "ignore" });
	execFileSync("git", ["update-ref", "refs/remotes/origin/main", head], { cwd, stdio: "ignore" });
	if (options.originHead)
		execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], {
			cwd,
			stdio: "ignore",
		});
	execFileSync("git", ["checkout", "-b", "feature"], { cwd, stdio: "ignore" });
	return { cwd, head };
}

function helperReport(role: string, details: unknown, openQuestions: string[] = []) {
	return {
		status: openQuestions.length ? "needs-input" : "done",
		role,
		summary: `${role} summary`,
		evidence: [`${role}.md:1`],
		openQuestions,
		assumptions: [],
		details,
	};
}

function sessionFileWithEntries(entries: unknown[]): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-session-")));
	const file = join(dir, "session.jsonl");
	writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return file;
}

function sessionFileWithHelperReport(report: unknown): string {
	return sessionFileWithEntries([
		{ type: "message", message: { role: "toolResult", toolName: "helper_report", details: report } },
	]);
}

function failedHelperEntry() {
	return { type: "message", message: { role: "toolResult", toolName: "helper_report", isError: true, details: {} } };
}

function subagentResult(agent: string, sessionFile: string, tokens = { outputTokens: 30, contextTokens: 70 }) {
	return {
		message: {
			role: "custom",
			customType: "subagent_result",
			details: {
				id: "sub-1",
				name: agent,
				agent,
				status: "completed",
				sessionFile,
				...tokens,
			},
		},
	};
}

function moveBase(cwd: string): string {
	execFileSync("git", ["checkout", "main"], { cwd, stdio: "ignore" });
	writeFileSync(join(cwd, `base-${Date.now()}.txt`), "base moved\n");
	execFileSync("git", ["add", "."], { cwd, stdio: "ignore" });
	execFileSync("git", ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "move base"], {
		cwd,
		stdio: "ignore",
	});
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
	execFileSync("git", ["update-ref", "refs/remotes/origin/main", head], { cwd, stdio: "ignore" });
	execFileSync("git", ["checkout", "feature"], { cwd, stdio: "ignore" });
	return head;
}

function commitAll(cwd: string, message: string): string {
	execFileSync("git", ["add", "."], { cwd, stdio: "ignore" });
	execFileSync("git", ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", message], {
		cwd,
		stdio: "ignore",
	});
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
}

function writeLoopLog(
	file: string,
	input: { commit: string; testHashes: { file: string; sha256: string }[]; exitCode: number },
): void {
	writeFileSync(
		file,
		[
			`${LOOP_RUN_MARKER}${JSON.stringify({ commit: input.commit, testHashes: input.testHashes })}`,
			"test output",
			`${EXIT_MARKER}${input.exitCode}`,
		].join("\n"),
	);
}

function sha256sum(cwd: string, file: string): string {
	const [hash] = execFileSync("sha256sum", [file], { cwd, encoding: "utf8" }).split(/\s+/);
	if (!hash) throw new Error(`sha256sum produced no hash for ${file}`);
	return hash;
}

function approvedLoop(profile: string, cwd: string) {
	const state: LoopState = {
		...createLoopState({
			worktree: cwd,
			branch: "feature",
			baseRef: "origin/main",
			baseHead: execFileSync("git", ["rev-parse", "origin/main"], { cwd, encoding: "utf8" }).trim(),
			goal: "Add the runner",
			limits: ["No full suite."],
			done: ["Verifier passes."],
		}),
		stage: "brief-approved",
		advisorRuns: {
			intent: { status: "done", summary: "intent", evidence: [], openQuestions: [], assumptions: [] },
			codebase: { status: "done", summary: "codebase", evidence: [], openQuestions: [], assumptions: [] },
			testDesign: { status: "done", summary: "tests", evidence: [], openQuestions: [], assumptions: [] },
			architecture: { status: "done", summary: "architecture", evidence: [], openQuestions: [], assumptions: [] },
		},
		plan: { author: "lead", text: "Plan" },
		approval: { approvedBy: "person", approvedAt: "2026-10-22T00:00:00.000Z", summary: "Approved." },
	};
	writeLoopStateFile(loopStatePath(profile, cwd, "feature"), {
		...state,
		frozenBriefHash: briefHash(buildBrief(state)),
	});
}

afterEach(() => vi.unstubAllEnvs());

describe("loop state files", () => {
	test("stores one JSON file per worktree and branch under the private profile", () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		const path = loopStatePath(profile, "/repo", "main");
		expect(path.startsWith(join(profile, "loops"))).toBe(true);
		expect(path.endsWith(".json")).toBe(true);
		expect(loopStatePath(profile, "/repo", "main")).toBe(path);
		expect(loopStatePath(profile, "/repo", "feature")).not.toBe(path);
	});

	test("validates state on read and fails loudly for invalid or unreadable files", () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-state-")));
		const file = join(dir, "state.json");
		writeFileSync(
			file,
			JSON.stringify(
				createLoopState({
					worktree: "/repo",
					branch: "main",
					baseRef: "origin/main",
					baseHead: "base",
					goal: "goal",
					limits: [],
					done: [],
				}),
			),
		);
		expect(readLoopStateFile(file).stage).toBe("advise");

		writeFileSync(file, JSON.stringify({ version: 1, stage: "advise" }));
		expect(() => readLoopStateFile(file)).toThrow(/invalid loop state/);

		rmSync(file);
		mkdirSync(file);
		expect(() => readLoopStateFile(file)).toThrow(/could not read loop state/);
	});
});

describe("Pi wiring", () => {
	const usage =
		/usage: \/loop start \[--base <ref>\] <task> \| \/loop answer <answer> \| \/loop plan <plan> \| \/loop approve <summary> \| \/loop status/;

	test("/loop start is explicit, writes state, and asks for the first advisors", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, userMessages } = fakePi();
		const { cwd, head } = gitWorktree();

		await commands.get("loop")?.handler("start Add the runner", ctx(cwd));

		const files = readFileSync(loopStatePath(profile, cwd, "feature"), "utf8");
		expect(files).toContain("Add the runner");
		expect(files).toContain(head);
		expect(files).toContain("origin/main");
		expect(userMessages.join("\n")).toContain("intent-advisor");
		expect(userMessages.join("\n")).toContain("codebase-advisor");
		await expect(commands.get("loop")?.handler("start Again", ctx(cwd))).rejects.toThrow(/already exists/);
	});

	test("/loop start can use --base when origin HEAD is absent", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands } = fakePi();
		const { cwd } = gitWorktree({ originHead: false });
		await commands.get("loop")?.handler("start --base origin/main Add the runner", ctx(cwd));
		expect(readLoopStateFile(loopStatePath(profile, cwd, "feature")).baseRef).toBe("origin/main");
	});

	test("refuses to start on the base branch", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands } = fakePi();
		const { cwd } = gitWorktree();
		execFileSync("git", ["checkout", "main"], { cwd, stdio: "ignore" });
		await expect(commands.get("loop")?.handler("start Add the runner", ctx(cwd))).rejects.toThrow(/base branch/);
	});

	test("bare /loop reports usage before reading state", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands } = fakePi();
		const { cwd } = gitWorktree();
		mkdirSync(join(profile, "loops"), { recursive: true });
		writeFileSync(loopStatePath(profile, cwd, "feature"), "{");

		await expect(commands.get("loop")?.handler("", ctx(cwd))).rejects.toThrow(usage);
	});

	test("unknown /loop verbs report usage without reading state", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands } = fakePi();
		const { cwd } = gitWorktree();
		mkdirSync(join(profile, "loops"), { recursive: true });
		writeFileSync(loopStatePath(profile, cwd, "feature"), "{");

		await expect(commands.get("loop")?.handler("fix the uploader", ctx(cwd))).rejects.toThrow(usage);
	});

	test("/loop answer reports a clear no-loop error before reading missing state", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands } = fakePi();
		const { cwd } = gitWorktree();

		await expect(commands.get("loop")?.handler("answer yes", ctx(cwd))).rejects.toThrow(
			`no loop on feature in ${cwd}; start one with /loop start <task>`,
		);
	});

	test("/loop status reports a clear no-loop error without writing", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands } = fakePi();
		const { cwd } = gitWorktree();

		await expect(commands.get("loop")?.handler("status", ctx(cwd))).rejects.toThrow(
			`no loop on feature in ${cwd}; start one with /loop start <task>`,
		);
		expect(existsSync(join(profile, "loops"))).toBe(false);
	});

	test("/loop status prints the read-only loop_status summary", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, tools, userMessages } = fakePi();
		const { cwd } = gitWorktree();
		await commands.get("loop")?.handler("start Add the runner", ctx(cwd));
		const path = loopStatePath(profile, cwd, "feature");
		const before = readFileSync(path, "utf8");
		const toolStatus = await tools.get("loop_status")?.execute("1", {}, undefined, undefined, ctx(cwd));
		userMessages.length = 0;
		const notifications: { message: string; type?: "info" | "warning" | "error" }[] = [];
		const statusCtx = {
			cwd,
			ui: {
				setStatus() {},
				notify: (message: string, type?: "info" | "warning" | "error") => notifications.push({ message, type }),
			},
		};

		await commands.get("loop")?.handler("status", statusCtx);

		expect(notifications).toEqual([{ message: toolStatus?.content[0]?.text, type: "info" }]);
		expect(userMessages).toEqual([]);
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	test("/loop status without UI fails clearly instead of starting a fallback", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, userMessages } = fakePi();
		const { cwd } = gitWorktree();
		await commands.get("loop")?.handler("start Add the runner", ctx(cwd));
		userMessages.length = 0;

		await expect(commands.get("loop")?.handler("status", { cwd })).rejects.toThrow(
			"/loop status requires an interactive UI",
		);
		expect(userMessages).toEqual([]);
	});

	test("loop_status reports a clear no-loop error without writing", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { tools } = fakePi();
		const { cwd } = gitWorktree();

		await expect(tools.get("loop_status")?.execute("1", {}, undefined, undefined, ctx(cwd))).rejects.toThrow(
			`no loop on feature in ${cwd}; start one with /loop start <task>`,
		);
		expect(existsSync(join(profile, "loops"))).toBe(false);
	});

	test("loop_status is read-only and reports staleness without writing", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, tools } = fakePi();
		const { cwd } = gitWorktree();
		await commands.get("loop")?.handler("start Add the runner", ctx(cwd));
		const path = loopStatePath(profile, cwd, "feature");
		const state = readLoopStateFile(path);
		writeLoopStateFile(path, { ...state, branch: "old-main" });
		const before = readFileSync(path, "utf8");

		const result = await tools.get("loop_status")?.execute("1", {}, undefined, undefined, ctx(cwd));
		expect(result?.content[0]?.text).toContain("stage: advise");
		expect(result?.content[0]?.text).toContain("stale:");
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	test("subagent_result reads helper_report details from the child session file", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, handlers, userMessages } = fakePi();
		const { cwd } = gitWorktree();
		await commands.get("loop")?.handler("start Add the runner", ctx(cwd));

		expect(handlers.has("subagent_result")).toBe(false);
		await handlers.get("message_end")?.(
			subagentResult(
				"intent-advisor",
				sessionFileWithHelperReport(helperReport("intent", { questions: [], doneCandidates: [], ambiguities: [] })),
			),
			ctx(cwd),
		);
		await handlers.get("message_end")?.(
			subagentResult(
				"codebase-advisor",
				sessionFileWithHelperReport(
					helperReport("codebase", {
						files: ["extensions/loop.ts"],
						existingTests: [],
						facts: [],
						boundaries: [],
						owners: [],
					}),
				),
			),
			ctx(cwd),
		);

		const sessionFile = sessionFileWithEntries([
			failedHelperEntry(),
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "helper_report",
					details: helperReport("test-design", {
						acceptanceTests: [{ name: "x", proves: "y", targetFile: "z", command: "pnpm test" }],
					}),
				},
			},
		]);
		expect(readLoopStateFile(loopStatePath(profile, cwd, "feature")).advisorRuns.intent?.outputTokens).toBe(30);
		expect(userMessages.join("\n")).toContain("test-design-advisor");

		await handlers.get("message_end")?.(subagentResult("test-design-advisor", sessionFile), ctx(cwd));
		expect(readLoopStateFile(loopStatePath(profile, cwd, "feature")).advisorRuns.testDesign?.contextTokens).toBe(70);
	});

	test("ordinary teammate results are ignored when no state or advisor dispatch matches", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, handlers } = fakePi();
		const { cwd } = gitWorktree();
		const result = subagentResult(
			"builder",
			sessionFileWithHelperReport(helperReport("intent", { questions: [], doneCandidates: [], ambiguities: [] })),
		);
		await expect(handlers.get("message_end")?.(result, ctx(cwd))).resolves.toBeUndefined();
		await commands.get("loop")?.handler("start Add the runner", ctx(cwd));
		await expect(handlers.get("message_end")?.(result, ctx(cwd))).resolves.toBeUndefined();
	});

	test("intake failures block with one advisor question and can be answered", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, handlers } = fakePi();
		const { cwd } = gitWorktree();
		await commands.get("loop")?.handler("start Add the runner", ctx(cwd));
		await handlers.get("message_end")?.(
			subagentResult("intent-advisor", join(profile, "missing-session.jsonl")),
			ctx(cwd),
		);
		const blocked = readLoopStateFile(loopStatePath(profile, cwd, "feature"));
		expect(blocked.stage).toBe("blocked");
		expect(blocked.questions).toHaveLength(1);
		expect(blocked.questions[0]?.text).toContain("intent");
		expect(blocked.questions[0]?.text).toContain("could not read");
		await commands.get("loop")?.handler("answer retry intent", ctx(cwd));
		const answered = readLoopStateFile(loopStatePath(profile, cwd, "feature"));
		expect(answered.stage).toBe("advise");
		expect(answered.dispatchedAdvisors).toEqual(["intent"]);
	});

	test("stale blocking through wiring can be left by /loop answer", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands } = fakePi();
		const { cwd, head } = gitWorktree();
		await commands.get("loop")?.handler("start Add the runner", ctx(cwd));
		const path = loopStatePath(profile, cwd, "feature");
		const state = readLoopStateFile(path);
		writeLoopStateFile(path, { ...state, branch: "old-main" });
		await expect(commands.get("loop")?.handler("plan should fail", ctx(cwd))).rejects.toThrow(/stale/);
		const blocked = readLoopStateFile(path);
		expect(blocked.stage).toBe("blocked");
		await commands.get("loop")?.handler("answer continue on current branch", ctx(cwd));
		const answered = readLoopStateFile(path);
		expect(answered.stage).toBe("advise");
		expect(answered.branch).toBe("feature");
		expect(answered.baseHead).toBe(head);
		expect(staleReason(answered, { branch: "feature", baseHead: head })).toBeUndefined();
	});

	test("reports and ordinary answers run stale checks before changing state", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, handlers } = fakePi();
		const { cwd } = gitWorktree();
		await commands.get("loop")?.handler("start Add the runner", ctx(cwd));
		const path = loopStatePath(profile, cwd, "feature");
		const state = readLoopStateFile(path);
		writeLoopStateFile(path, { ...state, branch: "old-feature" });
		await handlers.get("message_end")?.(
			subagentResult(
				"intent-advisor",
				sessionFileWithHelperReport(helperReport("intent", { questions: [], doneCandidates: [], ambiguities: [] })),
			),
			ctx(cwd),
		);
		expect(readLoopStateFile(path).stage).toBe("blocked");

		writeLoopStateFile(path, {
			...state,
			stage: "needs-person",
			branch: "old-feature",
			block: { kind: "questions", questionId: "q1", resumeStage: "advise", pendingAdvisors: ["intent"] },
			questions: [{ id: "q1", text: "Question?", recommended: "Answer.", dependsOn: [] }],
			dispatchedAdvisors: [],
		});
		await commands.get("loop")?.handler("answer ordinary answer", ctx(cwd));
		const staleAnswer = readLoopStateFile(path);
		expect(staleAnswer.block).toMatchObject({ kind: "stale", pendingAdvisors: ["intent"] });
		expect(staleAnswer.questions[0]?.answer).toBe("ordinary answer");
	});

	test("active-loop git base-ref failures persist a git block", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, handlers, tools } = fakePi();
		const { cwd } = gitWorktree({ originHead: false });
		await commands.get("loop")?.handler("start --base origin/main Add the runner", ctx(cwd));
		const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
		execFileSync("git", ["update-ref", "-d", "refs/remotes/origin/main"], { cwd, stdio: "ignore" });
		await commands.get("loop")?.handler("plan cannot run", ctx(cwd));
		const path = loopStatePath(profile, cwd, "feature");
		const state = readLoopStateFile(path);
		expect(state.stage).toBe("blocked");
		expect(state.block).toMatchObject({ kind: "git" });
		expect(state.questions.at(-1)?.text).toContain("origin/main");

		const beforeScout = readFileSync(path, "utf8");
		await handlers.get("message_end")?.(
			subagentResult(
				"scout",
				sessionFileWithHelperReport(helperReport("intent", { questions: [], doneCandidates: [], ambiguities: [] })),
			),
			ctx(cwd),
		);
		expect(readFileSync(path, "utf8")).toBe(beforeScout);

		await commands.get("loop")?.handler("answer not yet fixed", ctx(cwd));
		expect(readLoopStateFile(path).block).toMatchObject({ kind: "git" });
		const beforeStatus = readFileSync(path, "utf8");
		const status = await tools.get("loop_status")?.execute("1", {}, undefined, undefined, ctx(cwd));
		expect(status?.content[0]?.text).toContain("git:");
		expect(readFileSync(path, "utf8")).toBe(beforeStatus);

		execFileSync("git", ["update-ref", "refs/remotes/origin/main", head], { cwd, stdio: "ignore" });
		await commands.get("loop")?.handler("answer fixed now", ctx(cwd));
		const resumed = readLoopStateFile(path);
		expect(resumed.stage).toBe("advise");
		expect(resumed.block).toBeUndefined();
		expect(resumed.dispatchedAdvisors).toEqual(["intent", "codebase"]);
	});

	test("answering a questions block after base moves saves the answer before making a stale block", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, handlers } = fakePi();
		const { cwd } = gitWorktree();
		await commands.get("loop")?.handler("start Add the runner", ctx(cwd));
		await handlers.get("message_end")?.(
			subagentResult(
				"intent-advisor",
				sessionFileWithHelperReport(
					helperReport("intent", {
						questions: [
							{ id: "q1", text: "Use /loop start?", recommended: "Yes.", dependsOn: [] },
							{ id: "q2", text: "Ask before build?", recommended: "Yes.", dependsOn: [] },
						],
						doneCandidates: [],
						ambiguities: [],
					}),
				),
			),
			ctx(cwd),
		);
		await handlers.get("message_end")?.(
			subagentResult(
				"codebase-advisor",
				sessionFileWithHelperReport(
					helperReport("codebase", { files: [], existingTests: [], facts: [], boundaries: [], owners: [] }),
				),
			),
			ctx(cwd),
		);
		const path = loopStatePath(profile, cwd, "feature");
		expect(readLoopStateFile(path).stage).toBe("needs-person");
		moveBase(cwd);
		await commands.get("loop")?.handler("answer A1", ctx(cwd));
		const stale = readLoopStateFile(path);
		expect(stale.stage).toBe("blocked");
		expect(stale.block).toMatchObject({ kind: "stale", pendingAdvisors: ["intent"] });
		expect(stale.questions.find((question) => question.id === "advisor-questions")?.answer).toBe("A1");
		await commands.get("loop")?.handler("answer refresh stale", ctx(cwd));
		const resumed = readLoopStateFile(path);
		expect(resumed.stage).toBe("advise");
		expect(resumed.block).toBeUndefined();
		expect(resumed.questions.find((question) => question.id === "advisor-questions")?.answer).toBe("A1");
		expect(resumed.dispatchedAdvisors).toEqual(["intent"]);
	});

	test("answering an intake-failed block after base moves saves the answer before making a stale block", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, handlers } = fakePi();
		const { cwd } = gitWorktree();
		await commands.get("loop")?.handler("start Add the runner", ctx(cwd));
		await handlers.get("message_end")?.(
			subagentResult("intent-advisor", join(profile, "missing-session.jsonl")),
			ctx(cwd),
		);
		const path = loopStatePath(profile, cwd, "feature");
		expect(readLoopStateFile(path).block).toMatchObject({ kind: "intake-failed" });
		moveBase(cwd);
		await commands.get("loop")?.handler("answer retry intent", ctx(cwd));
		const stale = readLoopStateFile(path);
		expect(stale.block).toMatchObject({ kind: "stale", pendingAdvisors: ["intent"] });
		expect(stale.questions.find((question) => question.id === "advisor-intake-intent")?.answer).toBe("retry intent");
		await commands.get("loop")?.handler("answer refresh stale", ctx(cwd));
		const resumed = readLoopStateFile(path);
		expect(resumed.stage).toBe("advise");
		expect(resumed.block).toBeUndefined();
		expect(resumed.questions.find((question) => question.id === "advisor-intake-intent")?.answer).toBe("retry intent");
		expect(resumed.dispatchedAdvisors).toEqual(["intent"]);
	});

	test("/loop build is explicit and loop_record_build computes hashes from test files before dispatching verifier", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, tools, userMessages } = fakePi();
		const { cwd } = gitWorktree();
		approvedLoop(profile, cwd);
		writeFileSync(join(cwd, "loop.test.ts"), "expect(true).toBe(true)\n");
		const commit = commitAll(cwd, "add tests");
		await commands.get("loop")?.handler("build", ctx(cwd));
		expect(readLoopStateFile(loopStatePath(profile, cwd, "feature")).stage).toBe("build");
		const redLog = join(profile, "red.log");
		const greenLog = join(profile, "green.log");
		const hashBefore = readLoopStateFile(loopStatePath(profile, cwd, "feature")).build.testHashes;
		expect(hashBefore).toEqual([]);

		const expectedHash = sha256sum(cwd, "loop.test.ts");
		writeLoopLog(redLog, { commit, testHashes: [{ file: "loop.test.ts", sha256: expectedHash }], exitCode: 1 });
		writeLoopLog(greenLog, { commit, testHashes: [{ file: "loop.test.ts", sha256: expectedHash }], exitCode: 0 });
		const result = await tools
			.get("loop_record_build")
			?.execute(
				"1",
				{ testFiles: ["loop.test.ts"], redRunLog: redLog, greenRunLog: greenLog },
				undefined,
				undefined,
				ctx(cwd),
			);
		expect(result?.content[0]?.text).toContain("stage: verify");
		const state = readLoopStateFile(loopStatePath(profile, cwd, "feature"));
		expect(state.stage).toBe("verify");
		expect(state.build.testHashes).toEqual([{ file: "loop.test.ts", sha256: expectedHash }]);
		expect(userMessages.join("\n")).toContain("Start verifier");
		expect(userMessages.join("\n")).toContain("maxVerifierRerunMs: 120000");
		expect(userMessages.join("\n")).not.toContain("## Context from the lead's conversation");
	});

	test("recording build evidence blocks loudly when a recorded hash no longer matches the test file", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, tools } = fakePi();
		const { cwd } = gitWorktree();
		approvedLoop(profile, cwd);
		writeFileSync(join(cwd, "loop.test.ts"), "red\n");
		const commit = commitAll(cwd, "add tests");
		await commands.get("loop")?.handler("build", ctx(cwd));
		const originalHash = sha256sum(cwd, "loop.test.ts");
		const redLog = join(profile, "red.log");
		const greenLog = join(profile, "green.log");
		writeLoopLog(redLog, { commit, testHashes: [{ file: "loop.test.ts", sha256: originalHash }], exitCode: 1 });
		writeLoopLog(greenLog, { commit, testHashes: [{ file: "loop.test.ts", sha256: originalHash }], exitCode: 0 });
		writeFileSync(join(cwd, "loop.test.ts"), "changed after logs\n");
		await tools
			.get("loop_record_build")
			?.execute(
				"1",
				{ testFiles: ["loop.test.ts"], redRunLog: redLog, greenRunLog: greenLog },
				undefined,
				undefined,
				ctx(cwd),
			);
		const state = readLoopStateFile(loopStatePath(profile, cwd, "feature"));
		expect(state.stage).toBe("build");
		expect(state.block).toMatchObject({ kind: "questions", resumeStage: "build" });
		expect(state.questions.at(-1)?.text).toContain("red run");
	});

	test("verifier helper_report moves verify to done or classify and rejects stale accepted logs", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, handlers, tools } = fakePi();
		const { cwd } = gitWorktree();
		approvedLoop(profile, cwd);
		writeFileSync(join(cwd, "loop.test.ts"), "ok\n");
		const commit = commitAll(cwd, "add tests");
		await commands.get("loop")?.handler("build", ctx(cwd));
		const hash = sha256sum(cwd, "loop.test.ts");
		const redLog = join(profile, "red.log");
		const greenLog = join(profile, "green.log");
		writeLoopLog(redLog, { commit, testHashes: [{ file: "loop.test.ts", sha256: hash }], exitCode: 1 });
		writeLoopLog(greenLog, { commit, testHashes: [{ file: "loop.test.ts", sha256: hash }], exitCode: 0 });
		await tools
			.get("loop_record_build")
			?.execute(
				"1",
				{ testFiles: ["loop.test.ts"], redRunLog: redLog, greenRunLog: greenLog },
				undefined,
				undefined,
				ctx(cwd),
			);

		await handlers.get("message_end")?.(
			subagentResult(
				"verifier",
				sessionFileWithHelperReport(
					helperReport("verifier", {
						checksRun: [],
						rerunChecks: [],
						acceptedLogs: [{ log: greenLog, reason: "exact commit and test hashes" }],
						testHashesChecked: ["loop.test.ts"],
						goalMatched: true,
					}),
				),
			),
			ctx(cwd),
		);
		expect(readLoopStateFile(loopStatePath(profile, cwd, "feature")).stage).toBe("done");

		approvedLoop(profile, cwd);
		await commands.get("loop")?.handler("build", ctx(cwd));
		await tools
			.get("loop_record_build")
			?.execute(
				"1",
				{ testFiles: ["loop.test.ts"], redRunLog: redLog, greenRunLog: greenLog },
				undefined,
				undefined,
				ctx(cwd),
			);
		writeLoopLog(greenLog, { commit: "stale", testHashes: [{ file: "loop.test.ts", sha256: hash }], exitCode: 0 });
		await handlers.get("message_end")?.(
			subagentResult(
				"verifier",
				sessionFileWithHelperReport(
					helperReport("verifier", {
						checksRun: [],
						rerunChecks: [],
						acceptedLogs: [{ log: greenLog, reason: "looks green" }],
						testHashesChecked: ["loop.test.ts"],
						goalMatched: true,
					}),
				),
			),
			ctx(cwd),
		);
		const blocked = readLoopStateFile(loopStatePath(profile, cwd, "feature"));
		expect(blocked.stage).toBe("verify");
		expect(blocked.block).toMatchObject({ kind: "intake-failed" });

		approvedLoop(profile, cwd);
		await commands.get("loop")?.handler("build", ctx(cwd));
		writeLoopLog(greenLog, { commit, testHashes: [{ file: "loop.test.ts", sha256: hash }], exitCode: 0 });
		await tools
			.get("loop_record_build")
			?.execute(
				"1",
				{ testFiles: ["loop.test.ts"], redRunLog: redLog, greenRunLog: greenLog },
				undefined,
				undefined,
				ctx(cwd),
			);
		await handlers.get("message_end")?.(
			subagentResult(
				"verifier",
				sessionFileWithHelperReport({
					...helperReport("verifier", {
						checksRun: [],
						rerunChecks: [],
						acceptedLogs: [],
						testHashesChecked: ["loop.test.ts"],
						goalMatched: false,
						missClass: "execution-slip",
					}),
					summary: "Verifier found a miss.",
				}),
			),
			ctx(cwd),
		);
		const missed = readLoopStateFile(loopStatePath(profile, cwd, "feature"));
		expect(missed.stage).toBe("classify");
		expect(missed.block).toMatchObject({ kind: "questions", resumeStage: "classify" });
		expect(missed.verification).toMatchObject({ status: "missed", summary: "Verifier found a miss." });
	});
});
