import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { listProposals } from "../extensions/grimoire.ts";
import { briefHash, buildBrief, createLoopState, type LoopState, staleReason } from "../extensions/loop.ts";
import sitraLoop, { loopStatePath, readLoopStateFile, writeLoopStateFile } from "../extensions/loop-pi.ts";
import { EXIT_MARKER, HEADER_MARKER, readRunHeader } from "../extensions/runs.ts";

vi.setConfig({ testTimeout: 30_000 });

const FORGED_LOOP_MARKER = "__SITRA_LOOP_CHECK__=";

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

function sessionFileWithVerifierReport(report: unknown, task: string): string {
	const marker = "Verifier dispatchId: ";
	const dispatchStart = task.indexOf(marker);
	const dispatchId =
		dispatchStart >= 0
			? task
					.slice(dispatchStart + marker.length)
					.split("\n")[0]
					?.trim()
			: undefined;
	const withDispatch =
		report && typeof report === "object" && dispatchId
			? { ...(report as Record<string, unknown>), dispatchId }
			: report;
	return sessionFileWithEntries([
		{ type: "message", message: { role: "user", content: [{ type: "text", text: task }] } },
		{ type: "message", message: { role: "toolResult", toolName: "helper_report", details: withDispatch } },
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
			`${FORGED_LOOP_MARKER}${JSON.stringify({ commit: input.commit, testHashes: input.testHashes })}`,
			"test output",
			`${EXIT_MARKER}${input.exitCode}`,
		].join("\n"),
	);
}

function writeHeaderLoopLog(
	file: string,
	input: {
		commit: string;
		testHashes: ({ file: string; sha256: string } | { file: string; missing: true })[];
		exitCode: number;
		command?: string;
	},
): void {
	writeFileSync(
		file,
		[
			`${HEADER_MARKER}${JSON.stringify({
				pid: 12345,
				pidStart: "1",
				pidStartKind: "proc",
				meta: {
					...(input.command ? { command: input.command } : {}),
					loop: { commit: input.commit, testHashes: input.testHashes },
				},
			})}`,
			`${FORGED_LOOP_MARKER}${JSON.stringify({ commit: "forged", testHashes: [] })}`,
			"test output",
			`${EXIT_MARKER}${input.exitCode}`,
		].join("\n"),
	);
}

function writeRunIdLog(profile: string, runId: string, contents: string): string {
	const file = join(profile, "runs", `${runId}.log`);
	mkdirSync(join(profile, "runs"), { recursive: true });
	writeFileSync(file, contents);
	return file;
}

let nextRunId = 1;
function sha256File(file: string): string {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function recordBuildWithLogs(
	tools: ReturnType<typeof fakePi>["tools"],
	profile: string,
	redLog: string,
	greenLog: string,
	cwd: string,
) {
	const redRunId = `red-${nextRunId++}`;
	const greenRunId = `green-${nextRunId++}`;
	const redRunLog = writeRunIdLog(profile, redRunId, readFileSync(redLog, "utf8"));
	const greenRunLog = writeRunIdLog(profile, greenRunId, readFileSync(greenLog, "utf8"));
	const path = loopStatePath(profile, cwd, "feature");
	const state = readLoopStateFile(path);
	const redHeader = readRunHeader(readFileSync(redRunLog, "utf8").split("\n")[0] ?? "");
	const greenHeader = readRunHeader(readFileSync(greenRunLog, "utf8").split("\n")[0] ?? "");
	writeLoopStateFile(path, {
		...state,
		build: {
			...state.build,
			evidence: [
				...(state.build.evidence ?? []),
				{
					runId: redRunId,
					sha256: sha256File(redRunLog),
					phase: "red",
					commit: redHeader?.meta.loop?.commit ?? "missing-red-commit",
					command: redHeader?.meta.command ?? "pnpm test",
					log: redRunLog,
				},
				{
					runId: greenRunId,
					sha256: sha256File(greenRunLog),
					phase: "green",
					commit: greenHeader?.meta.loop?.commit ?? "missing-green-commit",
					command: greenHeader?.meta.command ?? "pnpm test",
					log: greenRunLog,
				},
			],
		},
	});
	return tools.get("loop_record_build")?.execute("1", { redRunId, greenRunId }, undefined, undefined, ctx(cwd));
}

async function prepareVerifierLoop(
	profile: string,
	cwd: string,
	commands: ReturnType<typeof fakePi>["commands"],
	tools: ReturnType<typeof fakePi>["tools"],
) {
	approvedLoop(profile, cwd);
	writeFileSync(join(cwd, "loop.test.ts"), "red\n");
	const redCommit = commitAll(cwd, "add tests");
	writeFileSync(join(cwd, "impl.ts"), "green\n");
	const greenCommit = commitAll(cwd, "implement");
	await commands.get("loop")?.handler("build", ctx(cwd));
	const hash = sha256sum(cwd, "loop.test.ts");
	const redLog = join(profile, "red.log");
	const greenLog = join(profile, "green.log");
	writeHeaderLoopLog(redLog, {
		commit: redCommit,
		testHashes: [{ file: "loop.test.ts", sha256: hash }],
		exitCode: 1,
	});
	writeHeaderLoopLog(greenLog, {
		commit: greenCommit,
		testHashes: [{ file: "loop.test.ts", sha256: hash }],
		exitCode: 0,
	});
	await recordBuildWithLogs(tools, profile, redLog, greenLog, cwd);
	const path = loopStatePath(profile, cwd, "feature");
	return { path, verifierTask: readLoopStateFile(path).verifierRequest?.task ?? "", greenLog };
}

function status(cwd: string): string {
	return execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
}

function sha256sum(cwd: string, file: string): string {
	const [hash] = execFileSync("sha256sum", [file], { cwd, encoding: "utf8" }).split(/\s+/);
	if (!hash) throw new Error(`sha256sum produced no hash for ${file}`);
	return hash;
}

function approvedLoop(profile: string, cwd: string, command = "pnpm test") {
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
			testDesign: {
				status: "done",
				summary: "tests",
				evidence: [],
				openQuestions: [],
				assumptions: [],
				acceptanceTestFiles: ["loop.test.ts"],
				acceptanceTestCommands: [command],
			},
			architecture: { status: "done", summary: "architecture", evidence: [], openQuestions: [], assumptions: [] },
		},
		plan: { author: "lead", text: "Plan" },
		approval: { approvedBy: "person", approvedAt: "2026-10-22T00:00:00.000Z", summary: "Approved." },
	};
	const frozenBrief = buildBrief(state);
	writeLoopStateFile(loopStatePath(profile, cwd, "feature"), {
		...state,
		frozenBrief,
		frozenBriefHash: briefHash(frozenBrief),
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
		/usage: \/loop start \[--base <ref>\] <task> \| \/loop answer <answer> \| \/loop plan <plan> \| \/loop approve <summary> \| \/loop build \| \/loop record-build <json> \| \/loop resume \| \/loop abandon \[reason\] \| \/loop confirm-new-info \| \/loop deny-new-info \[reason\] \| \/loop status/;

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

	test("/loop abandon reports the same clear no-loop error before reading missing state", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands } = fakePi();
		const { cwd } = gitWorktree();

		await expect(commands.get("loop")?.handler("abandon superseded", ctx(cwd))).rejects.toThrow(
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

	test("loop_status includes the documented per-loop metrics line without writing", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { tools } = fakePi();
		const { cwd } = gitWorktree();
		const state: LoopState = {
			...createLoopState({
				worktree: cwd,
				branch: "feature",
				baseRef: "origin/main",
				baseHead: execFileSync("git", ["rev-parse", "origin/main"], { cwd, encoding: "utf8" }).trim(),
				goal: "Add metrics",
				limits: [],
				done: [],
			}),
			stage: "done",
			advisorRuns: {
				intent: {
					status: "done",
					summary: "intent",
					evidence: [],
					openQuestions: [],
					assumptions: [],
					outputTokens: 500,
					contextTokens: 500,
				},
				codebase: {
					status: "done",
					summary: "codebase",
					evidence: [],
					openQuestions: [],
					assumptions: [],
					outputTokens: 1000,
					contextTokens: 1000,
				},
			},
			rework: [
				{ class: "context-missed", evidence: ["a"], proposalPath: "proposals/a.md" },
				{ class: "wrong-intent", evidence: ["b"], proposalPath: "proposals/b.md" },
				{ class: "check-gap", evidence: ["c"], proposalPath: "proposals/c.md" },
			],
		};
		const path = loopStatePath(profile, cwd, "feature");
		writeLoopStateFile(path, state);
		const before = readFileSync(path, "utf8");

		const result = await tools.get("loop_status")?.execute("1", {}, undefined, undefined, ctx(cwd));
		expect(result?.content[0]?.text).toContain(
			"loops: first-pass 0/1 · rounds 4 · avoidable rework context 1 intent 1 check 1 · tokens 3k",
		);
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	test("loop_status reports invalid active and abandoned metric files without throwing", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { tools } = fakePi();
		const { cwd } = gitWorktree();
		const state = createLoopState({
			worktree: cwd,
			branch: "feature",
			baseRef: "origin/main",
			baseHead: execFileSync("git", ["rev-parse", "origin/main"], { cwd, encoding: "utf8" }).trim(),
			goal: "Metrics tolerate bad files",
			limits: [],
			done: [],
		});
		writeLoopStateFile(loopStatePath(profile, cwd, "feature"), state);
		mkdirSync(join(profile, "loops", "abandoned"), { recursive: true });
		writeFileSync(join(profile, "loops", "bad-active.json"), "{}");
		writeFileSync(join(profile, "loops", "abandoned", "bad-abandoned.json"), "{");

		const result = await tools.get("loop_status")?.execute("1", {}, undefined, undefined, ctx(cwd));

		expect(result?.content[0]?.text).toContain(
			"loop metrics unreadable: bad-active.json, abandoned/bad-abandoned.json",
		);
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

	test("/loop resume re-emits a pending advisor request and the matching report advances", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, handlers, userMessages } = fakePi();
		const { cwd } = gitWorktree();
		await commands.get("loop")?.handler("start Add the runner", ctx(cwd));
		await handlers.get("message_end")?.(
			subagentResult(
				"intent-advisor",
				sessionFileWithHelperReport(helperReport("intent", { questions: [], doneCandidates: [], ambiguities: [] })),
			),
			ctx(cwd),
		);
		userMessages.length = 0;

		await commands.get("loop")?.handler("resume", ctx(cwd));

		expect(userMessages.join("\n")).toContain("codebase-advisor");
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
		expect(readLoopStateFile(loopStatePath(profile, cwd, "feature")).advisorRuns.codebase?.summary).toBe(
			"codebase summary",
		);
	});

	test("loop_status lists awaited advisors, report state, and the exact dispatch task", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, tools } = fakePi();
		const { cwd } = gitWorktree();
		await commands.get("loop")?.handler("start Add the runner", ctx(cwd));

		const result = await tools.get("loop_status")?.execute("1", {}, undefined, undefined, ctx(cwd));

		expect(result?.content[0]?.text).toContain("awaited advisors:");
		expect(result?.content[0]?.text).toContain("intent-advisor: not started");
		expect(result?.content[0]?.text).toContain("codebase-advisor: not started");
		expect(result?.content[0]?.text).toContain("must be started with this exact runner task");
		expect(result?.content[0]?.text).toContain("Goal: Add the runner");
		expect(result?.content[0]?.text).toContain("Find repository facts, files, tests, boundaries and owners.");
	});

	test("loop_status tracks advisor start, report, and redispatch from structured state", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, handlers, tools } = fakePi();
		const { cwd } = gitWorktree();
		await commands.get("loop")?.handler("start Add the runner", ctx(cwd));
		let status = await tools.get("loop_status")?.execute("0", {}, undefined, undefined, ctx(cwd));
		const initialStatus = status?.content[0]?.text ?? "";
		const intentTask = initialStatus
			.split(
				"intent-advisor has not reported through helper_report. If the lead wrote a summary instead, that does not count; it must be started with this exact runner task:\n",
			)[1]
			?.split("\n- codebase-advisor:")[0];
		const codebaseTask = initialStatus.split(
			"codebase-advisor has not reported through helper_report. If the lead wrote a summary instead, that does not count; it must be started with this exact runner task:\n",
		)[1];
		expect(intentTask).toBeTruthy();
		expect(codebaseTask).toBeTruthy();

		await handlers.get("tool_call")?.(
			{ toolName: "subagent", input: { agent: "intent-advisor", task: "summary" } },
			ctx(cwd),
		);
		status = await tools.get("loop_status")?.execute("1", {}, undefined, undefined, ctx(cwd));
		expect(status?.content[0]?.text).toContain("intent-advisor: not started");

		await handlers.get("tool_call")?.(
			{ toolName: "subagent", input: { agent: "intent-advisor", task: intentTask } },
			ctx(cwd),
		);
		status = await tools.get("loop_status")?.execute("2", {}, undefined, undefined, ctx(cwd));
		expect(status?.content[0]?.text).toContain("intent-advisor: started, awaiting helper_report");

		await handlers.get("message_end")?.(
			subagentResult(
				"intent-advisor",
				sessionFileWithHelperReport(
					helperReport("intent", {
						questions: [{ id: "q1", text: "Keep state under profile?", recommended: "Yes.", dependsOn: [] }],
						doneCandidates: [],
						ambiguities: [],
					}),
				),
			),
			ctx(cwd),
		);
		status = await tools.get("loop_status")?.execute("3", {}, undefined, undefined, ctx(cwd));
		expect(status?.content[0]?.text).toContain("intent-advisor: reported through helper_report");

		await handlers.get("tool_call")?.(
			{ toolName: "subagent", input: { agent: "codebase-advisor", task: codebaseTask } },
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
		await commands.get("loop")?.handler("answer yes, profile state", ctx(cwd));
		status = await tools.get("loop_status")?.execute("4", {}, undefined, undefined, ctx(cwd));
		expect(status?.content[0]?.text).toContain("intent-advisor: not started");
	});

	test("advisor intake failure clears started state before redispatch", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, handlers, tools } = fakePi();
		const { cwd } = gitWorktree();
		await commands.get("loop")?.handler("start Add the runner", ctx(cwd));
		const intentTask = [
			"Goal: Add the runner",
			"Limits:",
			"- (none)",
			"Done lines:",
			"- (none)",
			"Answers so far:",
			"- (none)",
			"Current questions:",
			"- (none)",
		].join("\n");
		const codebaseTask = [
			"Goal: Add the runner",
			"Limits:",
			"- (none)",
			"Done lines:",
			"- (none)",
			"Answers so far:",
			"- (none)",
			"Find repository facts, files, tests, boundaries and owners.",
		].join("\n");
		await handlers.get("tool_call")?.(
			{
				toolName: "subagent",
				input: {
					children: [
						{ agent: "intent-advisor", task: intentTask },
						{ agent: "codebase-advisor", task: codebaseTask },
					],
				},
			},
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
		await handlers.get("message_end")?.(subagentResult("intent-advisor", join(profile, "missing.jsonl")), ctx(cwd));
		expect(readLoopStateFile(loopStatePath(profile, cwd, "feature")).stage).toBe("blocked");

		await commands.get("loop")?.handler("answer retry intent", ctx(cwd));

		const status = await tools.get("loop_status")?.execute("1", {}, undefined, undefined, ctx(cwd));
		expect(status?.content[0]?.text).toContain("intent-advisor: not started");
	});

	test("subagent tool calls outside git proceed without loop lookup errors", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { handlers } = fakePi();
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sitra-not-git-")));

		expect(() =>
			handlers.get("tool_call")?.({ toolName: "subagent", input: { agent: "scout", task: "inspect files" } }, ctx(cwd)),
		).not.toThrow();
	});

	test("subagent tool calls in a fresh git repo with no loop proceed without HEAD lookup errors", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { handlers } = fakePi();
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sitra-unborn-git-")));
		execFileSync("git", ["init"], { cwd, stdio: "ignore" });

		expect(() =>
			handlers.get("tool_call")?.({ toolName: "subagent", input: { agent: "scout", task: "inspect files" } }, ctx(cwd)),
		).not.toThrow();
	});

	test("subagent results surface git errors once a loop exists", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, handlers } = fakePi();
		const { cwd } = gitWorktree({ originHead: false });
		await commands.get("loop")?.handler("start --base origin/main Add the runner", ctx(cwd));
		execFileSync("git", ["update-ref", "-d", "refs/remotes/origin/main"], { cwd, stdio: "ignore" });

		await handlers.get("message_end")?.(
			subagentResult(
				"intent-advisor",
				sessionFileWithHelperReport(helperReport("intent", { questions: [], doneCandidates: [], ambiguities: [] })),
			),
			ctx(cwd),
		);

		const state = readLoopStateFile(loopStatePath(profile, cwd, "feature"));
		expect(state.stage).toBe("blocked");
		expect(state.block).toMatchObject({ kind: "git" });
		expect(state.questions.at(-1)?.text).toContain("origin/main");
	});

	test("loop_submit_plan lets the lead submit the plan with the same validation as /loop plan", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { tools } = fakePi();
		const { cwd } = gitWorktree();
		const state: LoopState = {
			...createLoopState({
				worktree: cwd,
				branch: "feature",
				baseRef: "origin/main",
				baseHead: execFileSync("git", ["rev-parse", "origin/main"], { cwd, encoding: "utf8" }).trim(),
				goal: "Let the lead submit plans",
				limits: ["No new guardrails."],
				done: [],
			}),
			stage: "plan" as const,
			dispatchedAdvisors: [],
			advisorRuns: {
				intent: { status: "done", summary: "intent", evidence: [], openQuestions: [], assumptions: [] },
				codebase: { status: "done", summary: "codebase", evidence: [], openQuestions: [], assumptions: [] },
				testDesign: { status: "done", summary: "tests", evidence: [], openQuestions: [], assumptions: [] },
			},
		};
		writeLoopStateFile(loopStatePath(profile, cwd, "feature"), state);

		const result = await tools
			.get("loop_submit_plan")
			?.execute("1", { plan: "  Keep the runner state pure and Pi wiring thin.  " }, undefined, undefined, ctx(cwd));

		const planned = readLoopStateFile(loopStatePath(profile, cwd, "feature"));
		expect(result?.content[0]?.text).toContain("stage: architecture-review");
		expect(planned.stage).toBe("architecture-review");
		expect(planned.plan).toEqual({ author: "lead", text: "Keep the runner state pure and Pi wiring thin." });
		expect(planned.dispatchedAdvisors).toEqual(["architecture"]);

		await expect(
			tools.get("loop_submit_plan")?.execute("2", { plan: "Second plan should fail." }, undefined, undefined, ctx(cwd)),
		).rejects.toThrow(/cannot apply a lead plan while stage is architecture-review/);
	});

	test("no registered tool or agent-message path can approve a loop brief", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { handlers, tools } = fakePi();
		const { cwd } = gitWorktree();
		const state: LoopState = {
			...createLoopState({
				worktree: cwd,
				branch: "feature",
				baseRef: "origin/main",
				baseHead: execFileSync("git", ["rev-parse", "origin/main"], { cwd, encoding: "utf8" }).trim(),
				goal: "Keep approve human only",
				limits: [],
				done: [],
			}),
			stage: "architecture-review",
			dispatchedAdvisors: [],
			advisorRuns: {
				intent: { status: "done", summary: "intent", evidence: [], openQuestions: [], assumptions: [] },
				codebase: { status: "done", summary: "codebase", evidence: [], openQuestions: [], assumptions: [] },
				testDesign: { status: "done", summary: "tests", evidence: [], openQuestions: [], assumptions: [] },
				architecture: { status: "done", summary: "architecture", evidence: [], openQuestions: [], assumptions: [] },
			},
			plan: { author: "lead", text: "Plan" },
		};
		const path = loopStatePath(profile, cwd, "feature");

		for (const [name, tool] of tools) {
			writeLoopStateFile(path, state);
			try {
				await tool.execute(
					"tool-call",
					name === "loop_record_build"
						? { redRunId: "missing-red", greenRunId: "missing-green" }
						: name === "loop_submit_plan"
							? { plan: "Try to approve by tool." }
							: {},
					undefined,
					undefined,
					ctx(cwd),
				);
			} catch {
				// Tool failures are fine; the approval gate is the invariant.
			}
			const afterTool = readLoopStateFile(path);
			expect(afterTool.stage, name).toBe("architecture-review");
			expect(afterTool.approval, name).toBeUndefined();
		}

		writeLoopStateFile(path, state);
		await handlers.get("message_end")?.(
			{ message: { role: "assistant", content: "/loop approve Approved." } },
			ctx(cwd),
		);

		const after = readLoopStateFile(path);
		expect(after.stage).toBe("architecture-review");
		expect(after.approval).toBeUndefined();
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

	test("/loop abandon archives a blocked loop, loop_status reports no loop, and start works again", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, handlers, tools } = fakePi();
		const notifications: { message: string; type?: "info" | "warning" | "error" }[] = [];
		const { cwd } = gitWorktree();
		const loopCtx = {
			...ctx(cwd),
			ui: {
				setStatus() {},
				notify: (message: string, type?: "info" | "warning" | "error") => notifications.push({ message, type }),
			},
		};
		await commands.get("loop")?.handler("start Add the runner", loopCtx);
		await handlers.get("message_end")?.(
			subagentResult("intent-advisor", join(profile, "missing-session.jsonl")),
			loopCtx,
		);
		const path = loopStatePath(profile, cwd, "feature");
		const blocked = readLoopStateFile(path);
		expect(blocked.stage).toBe("blocked");

		await commands.get("loop")?.handler("abandon superseded by manual fix", loopCtx);

		expect(existsSync(path)).toBe(false);
		const abandonedDir = join(profile, "loops", "abandoned");
		const archived = readdirSync(abandonedDir);
		expect(archived).toHaveLength(1);
		const abandoned = JSON.parse(readFileSync(join(abandonedDir, archived[0] ?? ""), "utf8")) as {
			stage: string;
			goal: string;
			abandonedAt?: string;
			abandonReason?: string;
		};
		expect(abandoned).toMatchObject({
			stage: "blocked",
			goal: "Add the runner",
			abandonReason: "superseded by manual fix",
		});
		expect(abandoned.abandonedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(notifications).toEqual([{ message: `Abandoned loop on feature in ${cwd}.`, type: "info" }]);
		await expect(tools.get("loop_status")?.execute("1", {}, undefined, undefined, loopCtx)).rejects.toThrow(
			`no loop on feature in ${cwd}; start one with /loop start <task>`,
		);

		await commands.get("loop")?.handler("start Start again", loopCtx);
		expect(readLoopStateFile(path).goal).toBe("Start again");
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
		expect(stale.questions.find((question) => question.answer === "A1")?.id).toMatch(/^advisor-questions-/);
		await commands.get("loop")?.handler("answer refresh stale", ctx(cwd));
		const resumed = readLoopStateFile(path);
		expect(resumed.stage).toBe("advise");
		expect(resumed.block).toBeUndefined();
		expect(resumed.questions.find((question) => question.answer === "A1")?.id).toMatch(/^advisor-questions-/);
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
		const redCommit = commitAll(cwd, "add tests");
		writeFileSync(join(cwd, "impl.ts"), "green\n");
		const greenCommit = commitAll(cwd, "implement");
		await commands.get("loop")?.handler("build", ctx(cwd));
		expect(readLoopStateFile(loopStatePath(profile, cwd, "feature")).stage).toBe("build");
		const redLog = join(profile, "red.log");
		const greenLog = join(profile, "green.log");
		const hashBefore = readLoopStateFile(loopStatePath(profile, cwd, "feature")).build.testHashes;
		expect(hashBefore).toEqual([]);

		const expectedHash = sha256sum(cwd, "loop.test.ts");
		writeHeaderLoopLog(redLog, {
			commit: redCommit,
			testHashes: [{ file: "loop.test.ts", sha256: expectedHash }],
			exitCode: 1,
		});
		writeHeaderLoopLog(greenLog, {
			commit: greenCommit,
			testHashes: [{ file: "loop.test.ts", sha256: expectedHash }],
			exitCode: 0,
		});
		const result = await recordBuildWithLogs(tools, profile, redLog, greenLog, cwd);
		expect(result?.content[0]?.text).toContain("stage: verify");
		const state = readLoopStateFile(loopStatePath(profile, cwd, "feature"));
		expect(state.stage).toBe("verify");
		expect(state.build.testHashes).toEqual([{ file: "loop.test.ts", sha256: expectedHash }]);
		expect(userMessages.join("\n")).toContain("Start verifier");
		expect(userMessages.join("\n")).toContain("maxVerifierRerunMs: 120000");
		expect(userMessages.join("\n")).not.toContain("## Context from the lead's conversation");
	});

	test("loop_run_evidence runs the command in a temporary worktree at the named commit and loop_record_build accepts the logs", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, tools } = fakePi();
		const { cwd } = gitWorktree();
		approvedLoop(profile, cwd, "test -f impl.ts");
		writeFileSync(join(cwd, "loop.test.ts"), "red\n");
		const redCommit = commitAll(cwd, "add tests alone");
		writeFileSync(join(cwd, "impl.ts"), "green\n");
		const greenCommit = commitAll(cwd, "implement");
		const worktreesBefore = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8" });
		await commands.get("loop")?.handler("build", ctx(cwd));

		const red = await tools.get("loop_run_evidence")?.execute(
			"red",
			{
				phase: "red",
				commit: redCommit,
				command: "test -f impl.ts",
			},
			undefined,
			undefined,
			ctx(cwd),
		);
		const green = await tools
			.get("loop_run_evidence")
			?.execute(
				"green",
				{ phase: "green", commit: greenCommit, command: "test -f impl.ts" },
				undefined,
				undefined,
				ctx(cwd),
			);

		expect(status(cwd)).toBe("");
		expect(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8" })).toBe(worktreesBefore);
		expect(red?.content[0]?.text).toContain("phase: red");
		expect(red?.content[0]?.text).toContain("exit: 1");
		expect(green?.content[0]?.text).toContain("phase: green");
		expect(green?.content[0]?.text).toContain("exit: 0");
		const redDetails = red?.details as { runId: string; log: string; exitCode: number };
		const greenDetails = green?.details as { runId: string; log: string; exitCode: number };
		const expectedHash = sha256sum(cwd, "loop.test.ts");
		const redHeader = readRunHeader(readFileSync(redDetails.log, "utf8").split("\n")[0] ?? "");
		const greenHeader = readRunHeader(readFileSync(greenDetails.log, "utf8").split("\n")[0] ?? "");
		expect(redHeader?.meta.loop).toEqual({
			commit: redCommit,
			testHashes: [{ file: "loop.test.ts", sha256: expectedHash }],
		});
		expect(greenHeader?.meta.loop).toEqual({
			commit: greenCommit,
			testHashes: [{ file: "loop.test.ts", sha256: expectedHash }],
		});

		const result = await tools
			.get("loop_record_build")
			?.execute(
				"record",
				{ redRunId: redDetails.runId, greenRunId: greenDetails.runId },
				undefined,
				undefined,
				ctx(cwd),
			);

		expect(result?.content[0]?.text).toContain("stage: verify");
		const state = readLoopStateFile(loopStatePath(profile, cwd, "feature"));
		expect(state.stage).toBe("verify");
		expect(state.build).toMatchObject({
			redCommit,
			commit: greenCommit,
			redRunLog: redDetails.log,
			greenRunLog: greenDetails.log,
		});
	});

	test("loop_run_evidence rejects commands that are not in the frozen test-design brief", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, tools } = fakePi();
		const { cwd } = gitWorktree();
		approvedLoop(profile, cwd, "pnpm vitest run loop.test.ts");
		writeFileSync(join(cwd, "loop.test.ts"), "red\n");
		const redCommit = commitAll(cwd, "add tests alone");
		await commands.get("loop")?.handler("build", ctx(cwd));

		await expect(
			tools
				.get("loop_run_evidence")
				?.execute("red", { phase: "red", commit: redCommit, command: "false" }, undefined, undefined, ctx(cwd)),
		).rejects.toThrow(/not an agreed loop acceptance command/);
	});

	test("loop_record_build accepts only runner-recorded evidence ids and matching log hashes", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, tools } = fakePi();
		const { cwd } = gitWorktree();
		approvedLoop(profile, cwd, "test -f loop.test.ts");
		writeFileSync(join(cwd, "loop.test.ts"), "red\n");
		const redCommit = commitAll(cwd, "add tests alone");
		writeFileSync(join(cwd, "impl.ts"), "green\n");
		const greenCommit = commitAll(cwd, "implement");
		await commands.get("loop")?.handler("build", ctx(cwd));
		const hash = sha256sum(cwd, "loop.test.ts");
		const redLog = join(profile, "red.log");
		const greenLog = join(profile, "green.log");
		writeHeaderLoopLog(redLog, {
			commit: redCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 1,
			command: "test -f loop.test.ts",
		});
		writeHeaderLoopLog(greenLog, {
			commit: greenCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 0,
			command: "test -f loop.test.ts",
		});
		writeRunIdLog(profile, "forged-red", readFileSync(redLog, "utf8"));
		writeRunIdLog(profile, "forged-green", readFileSync(greenLog, "utf8"));

		const forged = await tools
			.get("loop_record_build")
			?.execute("forged", { redRunId: "forged-red", greenRunId: "forged-green" }, undefined, undefined, ctx(cwd));
		expect(forged?.content[0]?.text).toContain(
			"reason: red evidence run id forged-red was not recorded by loop_run_evidence",
		);

		const red = await tools
			.get("loop_run_evidence")
			?.execute(
				"red",
				{ phase: "red", commit: redCommit, command: "test -f loop.test.ts" },
				undefined,
				undefined,
				ctx(cwd),
			);
		const green = await tools
			.get("loop_run_evidence")
			?.execute(
				"green",
				{ phase: "green", commit: greenCommit, command: "test -f loop.test.ts" },
				undefined,
				undefined,
				ctx(cwd),
			);
		const redDetails = red?.details as { runId: string; log: string };
		const greenDetails = green?.details as { runId: string };
		writeFileSync(redDetails.log, `${readFileSync(redDetails.log, "utf8")}\nextra forged output\n`);

		const tampered = await tools
			.get("loop_record_build")
			?.execute(
				"tampered",
				{ redRunId: redDetails.runId, greenRunId: greenDetails.runId },
				undefined,
				undefined,
				ctx(cwd),
			);
		expect(tampered?.content[0]?.text).toContain(`reason: red evidence run id ${redDetails.runId} log hash changed`);
	});

	test("loop_run_evidence does not block the event loop and cleans up the worktree on timeout", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, tools } = fakePi();
		const { cwd } = gitWorktree();
		approvedLoop(profile, cwd, "node -e 'setTimeout(() => process.exit(0), 200)'");
		writeFileSync(join(cwd, "loop.test.ts"), "red\n");
		const redCommit = commitAll(cwd, "add tests alone");
		await commands.get("loop")?.handler("build", ctx(cwd));
		const before = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8" });
		let timerFired = false;
		const run = tools.get("loop_run_evidence")?.execute(
			"red",
			{
				phase: "red",
				commit: redCommit,
				command: "node -e 'setTimeout(() => process.exit(0), 200)'",
			},
			undefined,
			undefined,
			ctx(cwd),
		);
		await new Promise((resolve) =>
			setTimeout(() => {
				timerFired = true;
				resolve(undefined);
			}, 25),
		);
		expect(timerFired).toBe(true);
		await run;

		approvedLoop(profile, cwd, "sleep 5");
		await commands.get("loop")?.handler("build", ctx(cwd));
		await expect(
			tools
				.get("loop_run_evidence")
				?.execute(
					"timeout",
					{ phase: "red", commit: redCommit, command: "sleep 5", timeoutMs: 25 },
					undefined,
					undefined,
					ctx(cwd),
				),
		).rejects.toThrow(/timed out/);
		expect(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8" })).toBe(before);
	});

	test("loop_record_build trusts only first-line run headers and rejects hand-written loop markers", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, tools } = fakePi();
		const { cwd } = gitWorktree();
		approvedLoop(profile, cwd);
		writeFileSync(join(cwd, "loop.test.ts"), "expect(true).toBe(true)\n");
		const redCommit = commitAll(cwd, "add tests");
		writeFileSync(join(cwd, "impl.ts"), "green\n");
		const greenCommit = commitAll(cwd, "implement");
		await commands.get("loop")?.handler("build", ctx(cwd));
		const hash = sha256sum(cwd, "loop.test.ts");
		const redLog = join(profile, "red.log");
		const greenLog = join(profile, "green.log");
		writeHeaderLoopLog(redLog, {
			commit: redCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 1,
		});
		writeHeaderLoopLog(greenLog, {
			commit: greenCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 0,
		});
		await recordBuildWithLogs(tools, profile, redLog, greenLog, cwd);
		expect(readLoopStateFile(loopStatePath(profile, cwd, "feature")).stage).toBe("verify");

		approvedLoop(profile, cwd);
		await commands.get("loop")?.handler("build", ctx(cwd));
		writeLoopLog(redLog, { commit: redCommit, testHashes: [{ file: "loop.test.ts", sha256: hash }], exitCode: 1 });
		writeLoopLog(greenLog, { commit: greenCommit, testHashes: [{ file: "loop.test.ts", sha256: hash }], exitCode: 0 });
		await recordBuildWithLogs(tools, profile, redLog, greenLog, cwd);
		const rejected = readLoopStateFile(loopStatePath(profile, cwd, "feature"));
		expect(rejected.stage).toBe("blocked");
		expect(rejected.questions.at(-1)?.text).toContain("run header");
	});

	test("loop_record_build records by run id from the private runs directory, not arbitrary log paths", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, tools } = fakePi();
		const { cwd } = gitWorktree();
		approvedLoop(profile, cwd);
		writeFileSync(join(cwd, "loop.test.ts"), "red\n");
		const redCommit = commitAll(cwd, "add tests");
		writeFileSync(join(cwd, "impl.ts"), "green\n");
		const greenCommit = commitAll(cwd, "implement");
		await commands.get("loop")?.handler("build", ctx(cwd));
		const hash = sha256sum(cwd, "loop.test.ts");
		const redLog = join(profile, "red-source.log");
		const greenLog = join(profile, "green-source.log");
		writeHeaderLoopLog(redLog, {
			commit: redCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 1,
		});
		writeHeaderLoopLog(greenLog, {
			commit: greenCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 0,
		});
		writeRunIdLog(profile, "red-run", readFileSync(redLog, "utf8"));
		writeRunIdLog(profile, "green-run", readFileSync(greenLog, "utf8"));

		const result = await tools
			.get("loop_record_build")
			?.execute("1", { redRunId: "red-run", greenRunId: "green-run" }, undefined, undefined, ctx(cwd));
		expect(result?.content[0]?.text).toContain("stage: blocked");
		expect(result?.content[0]?.text).toContain(
			"reason: red evidence run id red-run was not recorded by loop_run_evidence",
		);

		await expect(
			tools
				.get("loop_record_build")
				?.execute("1", { redRunLog: redLog, greenRunLog: greenLog }, undefined, undefined, ctx(cwd)),
		).rejects.toThrow(/run id/);
	});

	test("loop_record_build requires a clean worktree and a tests-only red ancestor", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, tools } = fakePi();
		const { cwd } = gitWorktree();
		approvedLoop(profile, cwd);
		writeFileSync(join(cwd, "loop.test.ts"), "red\n");
		const redCommit = commitAll(cwd, "add tests");
		writeFileSync(join(cwd, "impl.ts"), "green\n");
		const greenCommit = commitAll(cwd, "implement");
		await commands.get("loop")?.handler("build", ctx(cwd));
		const hash = sha256sum(cwd, "loop.test.ts");
		const redLog = join(profile, "red.log");
		const greenLog = join(profile, "green.log");
		writeHeaderLoopLog(redLog, {
			commit: redCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 1,
		});
		writeHeaderLoopLog(greenLog, {
			commit: greenCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 0,
		});
		writeFileSync(join(cwd, "impl.ts"), "dirty\n");
		await recordBuildWithLogs(tools, profile, redLog, greenLog, cwd);
		expect(readLoopStateFile(loopStatePath(profile, cwd, "feature")).stage).toBe("blocked");

		execFileSync("git", ["checkout", "--", "impl.ts"], { cwd, stdio: "ignore" });
		approvedLoop(profile, cwd);
		await commands.get("loop")?.handler("build", ctx(cwd));
		const badRedCommit = greenCommit;
		writeHeaderLoopLog(redLog, {
			commit: badRedCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 1,
		});
		await recordBuildWithLogs(tools, profile, redLog, greenLog, cwd);
		const blocked = readLoopStateFile(loopStatePath(profile, cwd, "feature"));
		expect(blocked.stage).toBe("blocked");
		expect(blocked.questions.at(-1)?.text).toContain("tests-only");
		expect(status(cwd)).toBe("");
	});

	test("loop_record_build returns structured build-evidence block reasons and a retry can record without a person answer", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, tools } = fakePi();
		const { cwd } = gitWorktree();
		approvedLoop(profile, cwd);
		writeFileSync(join(cwd, "loop.test.ts"), "red\n");
		const redCommit = commitAll(cwd, "add tests");
		writeFileSync(join(cwd, "impl.ts"), "green\n");
		const greenCommit = commitAll(cwd, "implement");
		await commands.get("loop")?.handler("build", ctx(cwd));
		const hash = sha256sum(cwd, "loop.test.ts");
		const redLog = join(profile, "red.log");
		const greenLog = join(profile, "green.log");
		writeHeaderLoopLog(redLog, {
			commit: greenCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 1,
		});
		writeHeaderLoopLog(greenLog, {
			commit: greenCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 0,
		});

		const blockedResult = await recordBuildWithLogs(tools, profile, redLog, greenLog, cwd);

		expect(blockedResult?.content[0]?.text).toContain("stage: blocked");
		expect(blockedResult?.content[0]?.text).toContain("reason: red run commit is HEAD, not a tests-only ancestor");
		expect(blockedResult?.content[0]?.text).toContain(
			"satisfy: Use the tests-only commit for red evidence, not the build commit.",
		);
		let state = readLoopStateFile(loopStatePath(profile, cwd, "feature"));
		expect(state.stage).toBe("blocked");
		expect(state.block).toMatchObject({
			kind: "build-evidence",
			resumeStage: "build",
			problems: [
				{
					reason: "red run commit is HEAD, not a tests-only ancestor",
					satisfy: "Use the tests-only commit for red evidence, not the build commit.",
				},
			],
		});
		for (const problem of state.block?.problems ?? []) {
			expect(blockedResult?.content[0]?.text).toContain(`reason: ${problem.reason}`);
			expect(blockedResult?.content[0]?.text).toContain(`satisfy: ${problem.satisfy}`);
		}

		writeHeaderLoopLog(redLog, {
			commit: redCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 1,
		});
		const retried = await recordBuildWithLogs(tools, profile, redLog, greenLog, cwd);

		expect(retried?.content[0]?.text).toContain("stage: verify");
		state = readLoopStateFile(loopStatePath(profile, cwd, "feature"));
		expect(state.stage).toBe("verify");
		expect(state.block).toBeUndefined();
		expect(state.build.redCommit).toBe(redCommit);
	});

	test("a non-evidence problem added to an evidence block prevents lead-only retry", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, tools } = fakePi();
		const { cwd } = gitWorktree();
		approvedLoop(profile, cwd);
		writeFileSync(join(cwd, "loop.test.ts"), "red\n");
		const redCommit = commitAll(cwd, "add tests");
		writeFileSync(join(cwd, "impl.ts"), "green\n");
		const greenCommit = commitAll(cwd, "implement");
		await commands.get("loop")?.handler("build", ctx(cwd));
		const hash = sha256sum(cwd, "loop.test.ts");
		const redLog = join(profile, "red.log");
		const greenLog = join(profile, "green.log");
		writeHeaderLoopLog(redLog, {
			commit: greenCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 1,
		});
		writeHeaderLoopLog(greenLog, {
			commit: greenCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 0,
		});
		const path = loopStatePath(profile, cwd, "feature");
		const baseHead = readLoopStateFile(path).baseHead;
		await recordBuildWithLogs(tools, profile, redLog, greenLog, cwd);
		execFileSync("git", ["update-ref", "-d", "refs/remotes/origin/main"], { cwd, stdio: "ignore" });

		const gitBlocked = await recordBuildWithLogs(tools, profile, redLog, greenLog, cwd);

		let state = readLoopStateFile(loopStatePath(profile, cwd, "feature"));
		expect(gitBlocked?.content[0]?.text).toContain("block: git");
		expect(state.block).toMatchObject({ kind: "git" });

		execFileSync("git", ["update-ref", "refs/remotes/origin/main", baseHead], { cwd, stdio: "ignore" });
		writeHeaderLoopLog(redLog, {
			commit: redCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 1,
		});
		await expect(recordBuildWithLogs(tools, profile, redLog, greenLog, cwd)).rejects.toThrow(
			/cannot record build evidence while stage is blocked/,
		);
		state = readLoopStateFile(loopStatePath(profile, cwd, "feature"));
		expect(state.stage).toBe("blocked");
		expect(state.block).toMatchObject({ kind: "git" });
	});

	test("red evidence commit must contain only frozen acceptance test file changes from base", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, tools } = fakePi();
		const { cwd } = gitWorktree();
		approvedLoop(profile, cwd);
		writeFileSync(join(cwd, "loop.test.ts"), "red\n");
		writeFileSync(join(cwd, "impl.ts"), "implementation too early\n");
		const redCommit = commitAll(cwd, "add tests and implementation");
		writeFileSync(join(cwd, "impl.ts"), "green\n");
		const greenCommit = commitAll(cwd, "finish implementation");
		await commands.get("loop")?.handler("build", ctx(cwd));
		const hash = sha256sum(cwd, "loop.test.ts");
		const redLog = join(profile, "red.log");
		const greenLog = join(profile, "green.log");
		writeHeaderLoopLog(redLog, {
			commit: redCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 1,
		});
		writeHeaderLoopLog(greenLog, {
			commit: greenCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 0,
		});

		const blocked = await recordBuildWithLogs(tools, profile, redLog, greenLog, cwd);

		expect(blocked?.content[0]?.text).toContain("reason: red commit changes non-acceptance files: impl.ts");
		expect(blocked?.content[0]?.text).toContain(
			"satisfy: Split the red commit so its diff from base touches only: loop.test.ts.",
		);
	});

	test("/loop answer emits an unblock notice with the stage, answer, and next action", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, tools, userMessages } = fakePi();
		const { cwd } = gitWorktree();
		approvedLoop(profile, cwd);
		writeFileSync(join(cwd, "loop.test.ts"), "red\n");
		const redCommit = commitAll(cwd, "add tests");
		writeFileSync(join(cwd, "impl.ts"), "green\n");
		const greenCommit = commitAll(cwd, "implement");
		await commands.get("loop")?.handler("build", ctx(cwd));
		const hash = sha256sum(cwd, "loop.test.ts");
		const redLog = join(profile, "red.log");
		const greenLog = join(profile, "green.log");
		writeHeaderLoopLog(redLog, {
			commit: redCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 0,
		});
		writeHeaderLoopLog(greenLog, {
			commit: greenCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 0,
		});
		await recordBuildWithLogs(tools, profile, redLog, greenLog, cwd);
		expect(readLoopStateFile(loopStatePath(profile, cwd, "feature")).stage).toBe("blocked");
		userMessages.length = 0;

		await commands.get("loop")?.handler("answer rerun red with a failing tests-only commit", ctx(cwd));

		const message = userMessages.join("\n");
		expect(readLoopStateFile(loopStatePath(profile, cwd, "feature")).stage).toBe("build");
		expect(message).toContain("LOOPS stage: build");
		expect(message).toContain("person answered: rerun red with a failing tests-only commit");
		expect(message).toContain("next expected action: start new red and green runs with loop_run_evidence");
		expect(message).not.toContain("next expected action: record red and green evidence with loop_record_build");
	});

	test("/loop build tells the lead the runner-owned red and green evidence recipe", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, userMessages } = fakePi();
		const { cwd } = gitWorktree();
		approvedLoop(profile, cwd);

		await commands.get("loop")?.handler("build", ctx(cwd));

		const message = userMessages.join("\n");
		expect(message).toContain("commit the acceptance tests alone");
		expect(message).toContain("run red evidence at that commit");
		expect(message).toContain("implement");
		expect(message).toContain("run green evidence at the build commit");
		expect(message).toContain("loop_run_evidence");
	});

	test("/loop answer unblock notice points to /loop approve when brief approval is next", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, userMessages } = fakePi();
		const { cwd } = gitWorktree();
		const state: LoopState = {
			...createLoopState({
				worktree: cwd,
				branch: "feature",
				baseRef: "origin/main",
				baseHead: execFileSync("git", ["rev-parse", "origin/main"], { cwd, encoding: "utf8" }).trim(),
				goal: "Approve after architecture",
				limits: [],
				done: [],
			}),
			stage: "blocked",
			block: {
				kind: "questions",
				questionId: "architecture-q",
				resumeStage: "architecture-review",
				pendingAdvisors: [],
			},
			questions: [
				{
					id: "architecture-q",
					text: "Architecture blocker?",
					recommended: "Answer it.",
					dependsOn: [],
				},
			],
			dispatchedAdvisors: [],
			advisorRuns: {
				intent: { status: "done", summary: "intent", evidence: [], openQuestions: [], assumptions: [] },
				codebase: { status: "done", summary: "codebase", evidence: [], openQuestions: [], assumptions: [] },
				testDesign: { status: "done", summary: "tests", evidence: [], openQuestions: [], assumptions: [] },
				architecture: { status: "done", summary: "architecture", evidence: [], openQuestions: [], assumptions: [] },
			},
			plan: { author: "lead", text: "Plan" },
		};
		writeLoopStateFile(loopStatePath(profile, cwd, "feature"), state);

		await commands.get("loop")?.handler("answer checklist is fine", ctx(cwd));

		const message = userMessages.join("\n");
		expect(message).toContain("next expected action: person types /loop approve");
		expect(message).not.toContain("next expected action: wait for the person's next /loop answer");
	});

	test("recording build evidence blocks loudly when a recorded hash no longer matches the test file", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, tools } = fakePi();
		const { cwd } = gitWorktree();
		approvedLoop(profile, cwd);
		writeFileSync(join(cwd, "loop.test.ts"), "red\n");
		const redCommit = commitAll(cwd, "add tests");
		writeFileSync(join(cwd, "impl.ts"), "green\n");
		const greenCommit = commitAll(cwd, "implement");
		await commands.get("loop")?.handler("build", ctx(cwd));
		const originalHash = sha256sum(cwd, "loop.test.ts");
		const redLog = join(profile, "red.log");
		const greenLog = join(profile, "green.log");
		writeHeaderLoopLog(redLog, {
			commit: redCommit,
			testHashes: [{ file: "loop.test.ts", sha256: originalHash }],
			exitCode: 1,
		});
		writeHeaderLoopLog(greenLog, {
			commit: greenCommit,
			testHashes: [{ file: "loop.test.ts", sha256: originalHash }],
			exitCode: 0,
		});
		writeFileSync(join(cwd, "loop.test.ts"), "changed after logs\n");
		await recordBuildWithLogs(tools, profile, redLog, greenLog, cwd);
		const state = readLoopStateFile(loopStatePath(profile, cwd, "feature"));
		expect(state.stage).toBe("blocked");
		expect(state.block).toMatchObject({ kind: "build-evidence", resumeStage: "build" });
		expect(state.questions.at(-1)?.text).toContain("red run");
	});

	test("verifier helper_report moves verify to done or classify and rejects stale accepted logs", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, handlers, tools } = fakePi();
		const { cwd } = gitWorktree();
		approvedLoop(profile, cwd);
		writeFileSync(join(cwd, "loop.test.ts"), "ok\n");
		const redCommit = commitAll(cwd, "add tests");
		writeFileSync(join(cwd, "impl.ts"), "green\n");
		const greenCommit = commitAll(cwd, "implement");
		await commands.get("loop")?.handler("build", ctx(cwd));
		const hash = sha256sum(cwd, "loop.test.ts");
		const redLog = join(profile, "red.log");
		const greenLog = join(profile, "green.log");
		writeHeaderLoopLog(redLog, {
			commit: redCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 1,
		});
		writeHeaderLoopLog(greenLog, {
			commit: greenCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 0,
		});
		await recordBuildWithLogs(tools, profile, redLog, greenLog, cwd);

		await handlers.get("message_end")?.(
			subagentResult(
				"verifier",
				sessionFileWithVerifierReport(
					helperReport("verifier", {
						checksRun: [],
						rerunChecks: [],
						acceptedLogs: [{ log: greenLog, reason: "exact commit and test hashes" }],
						testHashesChecked: ["loop.test.ts"],
						goalMatched: true,
					}),
					readLoopStateFile(loopStatePath(profile, cwd, "feature")).verifierRequest?.task ?? "",
				),
			),
			ctx(cwd),
		);
		expect(readLoopStateFile(loopStatePath(profile, cwd, "feature")).stage).toBe("done");

		approvedLoop(profile, cwd);
		await commands.get("loop")?.handler("build", ctx(cwd));
		await recordBuildWithLogs(tools, profile, redLog, greenLog, cwd);
		writeHeaderLoopLog(greenLog, {
			commit: "stale",
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 0,
		});
		await handlers.get("message_end")?.(
			subagentResult(
				"verifier",
				sessionFileWithVerifierReport(
					helperReport("verifier", {
						checksRun: [],
						rerunChecks: [],
						acceptedLogs: [{ log: greenLog, reason: "looks green" }],
						testHashesChecked: ["loop.test.ts"],
						goalMatched: true,
					}),
					readLoopStateFile(loopStatePath(profile, cwd, "feature")).verifierRequest?.task ?? "",
				),
			),
			ctx(cwd),
		);
		const blocked = readLoopStateFile(loopStatePath(profile, cwd, "feature"));
		expect(blocked.stage).toBe("blocked");
		expect(blocked.block).toMatchObject({ kind: "intake-failed" });
		expect(blocked.rejectedVerifierReports).toEqual([
			expect.objectContaining({
				summary: "verifier summary",
				reason: expect.stringContaining("tied to commit stale"),
			}),
		]);
		const status = await tools.get("loop_status")?.execute("1", {}, undefined, undefined, ctx(cwd));
		expect(status?.content[0]?.text).toContain("rejected verifier reports:");
		expect(status?.content[0]?.text).toContain("verifier summary");

		approvedLoop(profile, cwd);
		await commands.get("loop")?.handler("build", ctx(cwd));
		writeHeaderLoopLog(greenLog, {
			commit: greenCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 0,
		});
		await recordBuildWithLogs(tools, profile, redLog, greenLog, cwd);
		await handlers.get("message_end")?.(
			subagentResult(
				"verifier",
				sessionFileWithVerifierReport(
					{
						...helperReport("verifier", {
							checksRun: [],
							rerunChecks: [],
							acceptedLogs: [],
							testHashesChecked: ["loop.test.ts"],
							goalMatched: false,
							missClass: "execution-slip",
						}),
						summary: "Verifier found a miss.",
					},
					readLoopStateFile(loopStatePath(profile, cwd, "feature")).verifierRequest?.task ?? "",
				),
			),
			ctx(cwd),
		);
		const missed = readLoopStateFile(loopStatePath(profile, cwd, "feature"));
		expect(missed.stage).toBe("blocked");
		expect(missed.block).toMatchObject({ kind: "rework-learning", resumeStage: "brief-approved" });
		expect(missed.rework[0]).toMatchObject({
			class: "execution-slip",
			proposalPath: expect.stringMatching(/^proposals\//),
		});
		expect(missed.verification).toMatchObject({ status: "missed", summary: "Verifier found a miss." });
	});

	test.each([
		{
			name: "unreadable verifier session file",
			sessionFile: (profile: string) => join(profile, "missing-verifier-session.jsonl"),
			reason: "could not read helper session file",
			sessionFileShown: true,
		},
		{
			name: "invalid helper_report fields",
			sessionFile: (_profile: string) =>
				sessionFileWithHelperReport({
					status: "done",
					role: "verifier",
					summary: "Invalid verifier report.",
					evidence: [],
					openQuestions: [],
					assumptions: [],
					details: { checksRun: [] },
				}),
			reason: "invalid helper_report",
			sessionFileShown: true,
		},
		{
			name: "parsed report rejected by verifier intake",
			sessionFile: (_profile: string, verifierTask: string) =>
				sessionFileWithVerifierReport(
					{
						status: "done",
						summary: "Base report without verifier role.",
						evidence: [],
						openQuestions: [],
						assumptions: [],
					},
					verifierTask,
				),
			reason: "verifier report is missing role",
			summary: "Base report without verifier role.",
		},
		{
			name: "accepted run log cannot be parsed",
			sessionFile: (profile: string, verifierTask: string) => {
				const badLog = join(profile, "bad-run.log");
				writeFileSync(badLog, `${HEADER_MARKER}{\n`);
				return sessionFileWithVerifierReport(
					helperReport("verifier", {
						checksRun: [],
						rerunChecks: [],
						acceptedLogs: [{ log: badLog, reason: "claimed valid" }],
						testHashesChecked: ["loop.test.ts"],
						goalMatched: true,
					}),
					verifierTask,
				);
			},
			reason: "invalid run header",
			summary: "verifier summary",
		},
	])("records rejected verifier reports in loop_status for $name", async (scenario) => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, handlers, tools } = fakePi();
		const { cwd } = gitWorktree();
		const prepared = await prepareVerifierLoop(profile, cwd, commands, tools);
		const sessionFile = scenario.sessionFile(profile, prepared.verifierTask);

		await handlers.get("message_end")?.(subagentResult("verifier", sessionFile), ctx(cwd));

		const blocked = readLoopStateFile(prepared.path);
		expect(blocked.stage).toBe("blocked");
		expect(blocked.rejectedVerifierReports).toHaveLength(1);
		expect(blocked.rejectedVerifierReports?.[0]?.reason).toContain(scenario.reason);
		if (scenario.summary) expect(blocked.rejectedVerifierReports?.[0]?.summary).toBe(scenario.summary);
		if (scenario.sessionFileShown) expect(blocked.rejectedVerifierReports?.[0]?.sessionFile).toBe(sessionFile);
		const status = await tools.get("loop_status")?.execute("1", {}, undefined, undefined, ctx(cwd));
		expect(status?.content[0]?.text).toContain("rejected verifier reports:");
		expect(status?.content[0]?.text).toContain(scenario.reason);
		if (scenario.summary) expect(status?.content[0]?.text).toContain(scenario.summary);
		if (scenario.sessionFileShown) expect(status?.content[0]?.text).toContain(sessionFile);
	});

	test("records rejected verifier reports in loop_status when verifier result has no sessionFile", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, handlers, tools } = fakePi();
		const { cwd } = gitWorktree();
		const prepared = await prepareVerifierLoop(profile, cwd, commands, tools);

		await handlers.get("message_end")?.(
			{ message: { customType: "subagent_result", details: { agent: "verifier" } } },
			ctx(cwd),
		);

		const blocked = readLoopStateFile(prepared.path);
		expect(blocked.stage).toBe("blocked");
		expect(blocked.rejectedVerifierReports).toEqual([
			expect.objectContaining({ reason: "subagent_result is missing sessionFile" }),
		]);
		const status = await tools.get("loop_status")?.execute("1", {}, undefined, undefined, ctx(cwd));
		expect(status?.content[0]?.text).toContain("rejected verifier reports:");
		expect(status?.content[0]?.text).toContain("subagent_result is missing sessionFile");
	});

	test("verifier misses write Grimoire proposals only and ask before one rework build", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, handlers, tools, userMessages } = fakePi();
		const { cwd } = gitWorktree();
		approvedLoop(profile, cwd);
		writeFileSync(join(cwd, "loop.test.ts"), "red\n");
		const redCommit = commitAll(cwd, "add tests");
		writeFileSync(join(cwd, "impl.ts"), "green\n");
		const greenCommit = commitAll(cwd, "implement");
		await commands.get("loop")?.handler("build", ctx(cwd));
		const hash = sha256sum(cwd, "loop.test.ts");
		const redLog = join(profile, "red.log");
		const greenLog = join(profile, "green.log");
		writeHeaderLoopLog(redLog, {
			commit: redCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 1,
		});
		writeHeaderLoopLog(greenLog, {
			commit: greenCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 0,
		});
		await recordBuildWithLogs(tools, profile, redLog, greenLog, cwd);

		await handlers.get("message_end")?.(
			subagentResult(
				"verifier",
				sessionFileWithVerifierReport(
					{
						...helperReport("verifier", {
							checksRun: [],
							rerunChecks: [],
							acceptedLogs: [],
							testHashesChecked: ["loop.test.ts"],
							goalMatched: false,
							missClass: "context-missed",
						}),
						summary: "Verifier found a context miss.",
						evidence: ["extensions/loop.ts:1"],
					},
					readLoopStateFile(loopStatePath(profile, cwd, "feature")).verifierRequest?.task ?? "",
				),
			),
			ctx(cwd),
		);

		const state = readLoopStateFile(loopStatePath(profile, cwd, "feature"));
		const proposals = listProposals(join(profile, "grimoire"));
		expect(state.stage).toBe("blocked");
		expect(state.block).toMatchObject({ kind: "rework-learning", resumeStage: "brief-approved" });
		expect(state.rework).toEqual([
			{ class: "context-missed", evidence: ["extensions/loop.ts:1"], proposalPath: proposals[0]?.file },
		]);
		expect(proposals).toHaveLength(1);
		expect(proposals[0]).toMatchObject({
			kind: "lesson",
			proposedBy: "sitra-loops",
			tags: ["loops", "rework", "context-missed"],
		});
		expect(existsSync(join(profile, "grimoire", "kinds"))).toBe(false);
		expect(userMessages.join("\n")).toContain("LOOPS needs one answer before continuing");
	});

	test("verifier intake requires clean worktree and the recorded verifier dispatch", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, handlers, tools } = fakePi();
		const { cwd } = gitWorktree();
		approvedLoop(profile, cwd);
		writeFileSync(join(cwd, "loop.test.ts"), "red\n");
		const redCommit = commitAll(cwd, "add tests");
		writeFileSync(join(cwd, "impl.ts"), "green\n");
		const greenCommit = commitAll(cwd, "implement");
		await commands.get("loop")?.handler("build", ctx(cwd));
		const hash = sha256sum(cwd, "loop.test.ts");
		const redLog = join(profile, "red.log");
		const greenLog = join(profile, "green.log");
		writeHeaderLoopLog(redLog, {
			commit: redCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 1,
		});
		writeHeaderLoopLog(greenLog, {
			commit: greenCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 0,
		});
		await recordBuildWithLogs(tools, profile, redLog, greenLog, cwd);
		const verifierTask = readLoopStateFile(loopStatePath(profile, cwd, "feature")).verifierRequest?.task ?? "";
		writeFileSync(join(cwd, "impl.ts"), "dirty\n");
		await handlers.get("message_end")?.(
			subagentResult(
				"verifier",
				sessionFileWithVerifierReport(
					helperReport("verifier", {
						checksRun: [],
						rerunChecks: [],
						acceptedLogs: [],
						testHashesChecked: ["loop.test.ts"],
						goalMatched: true,
					}),
					verifierTask,
				),
			),
			ctx(cwd),
		);
		const dirty = readLoopStateFile(loopStatePath(profile, cwd, "feature"));
		expect(dirty.stage).toBe("blocked");
		expect(dirty.block).toMatchObject({ kind: "stale", resumeStage: "build" });

		execFileSync("git", ["checkout", "--", "impl.ts"], { cwd, stdio: "ignore" });
		writeLoopStateFile(loopStatePath(profile, cwd, "feature"), {
			...dirty,
			stage: "verify",
			block: undefined,
			verifierRequest: undefined,
		});
		const before = readFileSync(loopStatePath(profile, cwd, "feature"), "utf8");
		await handlers.get("message_end")?.(
			subagentResult(
				"verifier",
				sessionFileWithVerifierReport(
					helperReport("verifier", {
						checksRun: [],
						rerunChecks: [],
						acceptedLogs: [],
						testHashesChecked: ["loop.test.ts"],
						goalMatched: true,
					}),
					verifierTask,
				),
			),
			ctx(cwd),
		);
		expect(readFileSync(loopStatePath(profile, cwd, "feature"), "utf8")).toBe(before);
	});

	test("verifier intake blocks reports whose dispatchId does not match the recorded dispatch", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, handlers, tools } = fakePi();
		const { cwd } = gitWorktree();
		approvedLoop(profile, cwd);
		writeFileSync(join(cwd, "loop.test.ts"), "red\n");
		const redCommit = commitAll(cwd, "add tests");
		writeFileSync(join(cwd, "impl.ts"), "green\n");
		const greenCommit = commitAll(cwd, "implement");
		await commands.get("loop")?.handler("build", ctx(cwd));
		const hash = sha256sum(cwd, "loop.test.ts");
		const redLog = join(profile, "red.log");
		const greenLog = join(profile, "green.log");
		writeHeaderLoopLog(redLog, {
			commit: redCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 1,
		});
		writeHeaderLoopLog(greenLog, {
			commit: greenCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 0,
		});
		await recordBuildWithLogs(tools, profile, redLog, greenLog, cwd);
		const path = loopStatePath(profile, cwd, "feature");
		const verifyState = readLoopStateFile(path);
		const verifierReport = helperReport("verifier", {
			checksRun: [],
			rerunChecks: [],
			acceptedLogs: [],
			testHashesChecked: ["loop.test.ts"],
			goalMatched: true,
		});

		await handlers.get("message_end")?.(
			subagentResult("verifier", sessionFileWithVerifierReport(verifierReport, "different task")),
			ctx(cwd),
		);
		const blocked = readLoopStateFile(path);
		expect(blocked.stage).toBe("blocked");
		expect(blocked.block).toMatchObject({ kind: "intake-failed", resumeStage: "verify" });
		expect(blocked.questions.at(-1)?.text).toContain("missing dispatchId");

		writeLoopStateFile(path, verifyState);
		await handlers.get("message_end")?.(
			subagentResult(
				"verifier",
				sessionFileWithVerifierReport(verifierReport, verifyState.verifierRequest?.task ?? ""),
			),
			ctx(cwd),
		);
		expect(readLoopStateFile(path).stage).toBe("done");
	});

	test("/loop resume re-emits a pending verifier request with the same dispatchId and the matching report advances", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, handlers, tools, userMessages } = fakePi();
		const { cwd } = gitWorktree();
		approvedLoop(profile, cwd);
		writeFileSync(join(cwd, "loop.test.ts"), "red\n");
		const redCommit = commitAll(cwd, "add tests");
		writeFileSync(join(cwd, "impl.ts"), "green\n");
		const greenCommit = commitAll(cwd, "implement");
		await commands.get("loop")?.handler("build", ctx(cwd));
		const hash = sha256sum(cwd, "loop.test.ts");
		const redLog = join(profile, "red.log");
		const greenLog = join(profile, "green.log");
		writeHeaderLoopLog(redLog, {
			commit: redCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 1,
		});
		writeHeaderLoopLog(greenLog, {
			commit: greenCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 0,
		});
		await recordBuildWithLogs(tools, profile, redLog, greenLog, cwd);
		const path = loopStatePath(profile, cwd, "feature");
		const dispatchId = readLoopStateFile(path).verifierRequest?.dispatchId;
		userMessages.length = 0;

		await commands.get("loop")?.handler("resume", ctx(cwd));

		const resumed = userMessages.join("\n");
		expect(resumed).toContain("Start verifier");
		expect(resumed).toContain(`Verifier dispatchId: ${dispatchId}`);
		await handlers.get("message_end")?.(
			subagentResult(
				"verifier",
				sessionFileWithVerifierReport(
					helperReport("verifier", {
						checksRun: [],
						rerunChecks: [],
						acceptedLogs: [{ log: greenLog, reason: "exact commit and test hashes" }],
						testHashesChecked: ["loop.test.ts"],
						goalMatched: true,
					}),
					readLoopStateFile(path).verifierRequest?.task ?? "",
				),
			),
			ctx(cwd),
		);
		expect(readLoopStateFile(path).stage).toBe("done");
	});

	test("record-build blocks clearly when run metadata says a frozen test file was missing", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, tools } = fakePi();
		const { cwd } = gitWorktree();
		approvedLoop(profile, cwd);
		writeFileSync(join(cwd, "loop.test.ts"), "red\n");
		const redCommit = commitAll(cwd, "add tests");
		writeFileSync(join(cwd, "impl.ts"), "green\n");
		const greenCommit = commitAll(cwd, "implement");
		await commands.get("loop")?.handler("build", ctx(cwd));
		const greenHash = sha256sum(cwd, "loop.test.ts");
		const redLog = join(profile, "red.log");
		const greenLog = join(profile, "green.log");
		writeHeaderLoopLog(redLog, {
			commit: redCommit,
			testHashes: [{ file: "loop.test.ts", missing: true }],
			exitCode: 1,
		});
		writeHeaderLoopLog(greenLog, {
			commit: greenCommit,
			testHashes: [{ file: "loop.test.ts", sha256: greenHash }],
			exitCode: 0,
		});
		await recordBuildWithLogs(tools, profile, redLog, greenLog, cwd);
		const blocked = readLoopStateFile(loopStatePath(profile, cwd, "feature"));
		expect(blocked.stage).toBe("blocked");
		expect(blocked.questions.at(-1)?.text).toContain("loop.test.ts was missing");
	});

	test("loop_status reports test-hash and diff staleness without writing", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, tools } = fakePi();
		const { cwd } = gitWorktree();
		approvedLoop(profile, cwd);
		writeFileSync(join(cwd, "loop.test.ts"), "red\n");
		const redCommit = commitAll(cwd, "add tests");
		writeFileSync(join(cwd, "impl.ts"), "green\n");
		const greenCommit = commitAll(cwd, "implement");
		await commands.get("loop")?.handler("build", ctx(cwd));
		const hash = sha256sum(cwd, "loop.test.ts");
		const redLog = join(profile, "red.log");
		const greenLog = join(profile, "green.log");
		writeHeaderLoopLog(redLog, {
			commit: redCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 1,
		});
		writeHeaderLoopLog(greenLog, {
			commit: greenCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 0,
		});
		await recordBuildWithLogs(tools, profile, redLog, greenLog, cwd);
		const path = loopStatePath(profile, cwd, "feature");
		writeFileSync(join(cwd, "loop.test.ts"), "changed\n");
		commitAll(cwd, "change test after verifier dispatch");
		const before = readFileSync(path, "utf8");
		const result = await tools.get("loop_status")?.execute("1", {}, undefined, undefined, ctx(cwd));
		expect(result?.content[0]?.text).toContain("stale: test hashes");
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	test.each([
		["committed test edit", "loop.test.ts", "expect('changed').toBe('changed')\n"],
		["committed implementation edit", "impl.ts", "changed implementation\n"],
	])("stale verify can resume to build and record fresh evidence after %s", async (_name, changedFile, contents) => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, handlers, tools } = fakePi();
		const { cwd } = gitWorktree();
		approvedLoop(profile, cwd);
		writeFileSync(join(cwd, "loop.test.ts"), "red\n");
		let redCommit = commitAll(cwd, "add tests");
		writeFileSync(join(cwd, "impl.ts"), "green\n");
		let greenCommit = commitAll(cwd, "implement");
		await commands.get("loop")?.handler("build", ctx(cwd));
		let hash = sha256sum(cwd, "loop.test.ts");
		const redLog = join(profile, "red.log");
		const greenLog = join(profile, "green.log");
		writeHeaderLoopLog(redLog, {
			commit: redCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 1,
		});
		writeHeaderLoopLog(greenLog, {
			commit: greenCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 0,
		});
		await recordBuildWithLogs(tools, profile, redLog, greenLog, cwd);
		const verifierTask = readLoopStateFile(loopStatePath(profile, cwd, "feature")).verifierRequest?.task ?? "";

		writeFileSync(join(cwd, changedFile), contents);
		commitAll(cwd, `change ${changedFile}`);
		await handlers.get("message_end")?.(
			subagentResult(
				"verifier",
				sessionFileWithVerifierReport(
					helperReport("verifier", {
						checksRun: [],
						rerunChecks: [],
						acceptedLogs: [],
						testHashesChecked: ["loop.test.ts"],
						goalMatched: true,
					}),
					verifierTask,
				),
			),
			ctx(cwd),
		);
		const stale = readLoopStateFile(loopStatePath(profile, cwd, "feature"));
		expect(stale.stage).toBe("blocked");
		expect(stale.block).toMatchObject({ kind: "stale", resumeStage: "build" });
		await commands.get("loop")?.handler("answer rebuild", ctx(cwd));
		let resumed = readLoopStateFile(loopStatePath(profile, cwd, "feature"));
		expect(resumed.stage).toBe("build");
		expect(resumed.build.testHashes).toEqual([]);
		expect(resumed.verifierRequest).toBeUndefined();

		execFileSync("git", ["reset", "--hard", "origin/main"], { cwd, stdio: "ignore" });
		writeFileSync(join(cwd, "loop.test.ts"), `fresh red ${changedFile}\n`);
		redCommit = commitAll(cwd, `fresh tests ${changedFile}`);
		writeFileSync(join(cwd, "impl.ts"), `fresh green ${changedFile}\n`);
		greenCommit = commitAll(cwd, `fresh implementation ${changedFile}`);
		hash = sha256sum(cwd, "loop.test.ts");
		writeHeaderLoopLog(redLog, {
			commit: redCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 1,
		});
		writeHeaderLoopLog(greenLog, {
			commit: greenCommit,
			testHashes: [{ file: "loop.test.ts", sha256: hash }],
			exitCode: 0,
		});
		await recordBuildWithLogs(tools, profile, redLog, greenLog, cwd);
		resumed = readLoopStateFile(loopStatePath(profile, cwd, "feature"));
		expect(resumed.stage).toBe("verify");
		expect(resumed.verifierRequest).toBeDefined();
	});
});
