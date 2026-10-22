import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type HelperReport, renderHelperReport } from "../extensions/helper-report.ts";
import sitraLead from "../extensions/lead.ts";
import { createLoopState, type LoopState } from "../extensions/loop.ts";
import { loopStatePath, writeLoopStateFile } from "../extensions/loop-pi.ts";
import { readRunHeader } from "../extensions/runs.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
	const handlers = new Map<string, Handler>();
	const tools = new Map<
		string,
		{
			description: string;
			promptSnippet?: string;
			parameters: {
				type?: string;
				properties?: Record<string, { type?: string }>;
			};
			execute: (
				id: string,
				params: Record<string, unknown>,
				signal: unknown,
				onUpdate: unknown,
				ctx: unknown,
			) => Promise<{ content: { text: string }[]; details: unknown }>;
		}
	>();
	sitraLead({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
		events: { on() {}, emit() {} },
		sendMessage() {},
	} as never);
	return { handlers, tools };
}

const content = (text: string) => [{ type: "text", text }];

afterEach(() => vi.unstubAllEnvs());

function installFakeHerdr(options: { waitFails?: boolean; waitFailures?: number; splitPaneIds?: string[] } = {}): {
	cwd: string;
	calls(): string[][];
} {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sitra-lead-herdr-")));
	const bin = join(cwd, "bin");
	const calls = join(cwd, "herdr-calls.jsonl");
	const state = join(cwd, "herdr-state.json");
	mkdirSync(bin, { recursive: true });
	const herdrPath = join(bin, "herdr");
	writeFileSync(
		herdrPath,
		`#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.HERDR_FAKE_CALLS, JSON.stringify(args) + "\\n");
let state = { splitCount: 0, waitCount: 0 };
try {
  state = JSON.parse(readFileSync(process.env.HERDR_FAKE_STATE, "utf8"));
} catch {}
const saveState = () => writeFileSync(process.env.HERDR_FAKE_STATE, JSON.stringify(state));
if (args[0] === "pane" && args[1] === "split") {
  const ids = JSON.parse(process.env.HERDR_FAKE_SPLIT_PANE_IDS);
  const pane_id = ids[Math.min(state.splitCount, ids.length - 1)];
  state.splitCount += 1;
  saveState();
  console.log(JSON.stringify({ pane_id }));
  process.exit(0);
}
if (args[0] === "pane" && args[1] === "wait-output") {
  state.waitCount += 1;
  saveState();
  if (state.waitCount <= Number(process.env.HERDR_FAKE_WAIT_FAILURES || "0")) {
    process.exit(124);
  }
}
process.exit(0);
`,
	);
	chmodSync(herdrPath, 0o755);
	vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
	vi.stubEnv("HERDR_ENV", "1");
	vi.stubEnv("HERDR_PANE_ID", "pane-current");
	vi.stubEnv("HERDR_FAKE_CALLS", calls);
	vi.stubEnv("HERDR_FAKE_STATE", state);
	vi.stubEnv("HERDR_FAKE_SPLIT_PANE_IDS", JSON.stringify(options.splitPaneIds ?? ["pane-fresh"]));
	vi.stubEnv("HERDR_FAKE_WAIT_FAILURES", String(options.waitFailures ?? (options.waitFails ? 1_000_000 : 0)));
	vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "profile"));
	return {
		cwd,
		calls: () =>
			readFileSync(calls, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as string[]),
	};
}

function gitWorktree(): { cwd: string; head: string } {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sitra-lead-loop-")));
	execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
	writeFileSync(join(cwd, "README.md"), "test\n");
	writeFileSync(join(cwd, "loop.test.ts"), "expect(true).toBe(true)\n");
	execFileSync("git", ["add", "."], { cwd, stdio: "ignore" });
	execFileSync("git", ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "initial"], {
		cwd,
		stdio: "ignore",
	});
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
	execFileSync("git", ["remote", "add", "origin", cwd], { cwd, stdio: "ignore" });
	execFileSync("git", ["update-ref", "refs/remotes/origin/main", head], { cwd, stdio: "ignore" });
	execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], {
		cwd,
		stdio: "ignore",
	});
	execFileSync("git", ["checkout", "-b", "feature"], { cwd, stdio: "ignore" });
	return { cwd, head };
}

function addLinkedWorktree(repo: string): string {
	const linked = join(repo, ".worktrees", "linked");
	execFileSync("git", ["worktree", "add", "-q", "-b", "linked", linked], { cwd: repo, stdio: "ignore" });
	return linked;
}

function runGeneratedScript(profile: string, runId: string): void {
	execFileSync("bash", [join(profile, "runs", `${runId}.sh`)]);
}

const SLOW_GIT_TEST_TIMEOUT = 30_000;

describe("helper_report", () => {
	test("only helper sessions get a schema-validated report tool", async () => {
		const { tools } = fakePi();
		expect(tools.has("helper_report")).toBe(false);

		vi.stubEnv("PI_SUBAGENT_NAME", "scout");
		const helper = fakePi();
		const tool = helper.tools.get("helper_report");
		expect(tool).toBeDefined();
		expect(tool?.description).not.toMatch(/Kyle|Sam/);
		expect(tool?.promptSnippet).not.toMatch(/Kyle|Sam/);
		expect(tool?.parameters.type).toBe("object");
		expect(Object.keys(tool?.parameters.properties ?? {}).length).toBeGreaterThan(0);
		expect(tool?.parameters.properties?.evidence?.type).toBe("array");
		expect(tool?.parameters.properties?.openQuestions?.type).toBe("array");
		expect(tool?.parameters.properties?.assumptions?.type).toBe("array");
		const result = await tool?.execute(
			"1",
			{
				status: "done",
				summary: "Found the parser tests.",
				evidence: ["test/parser.test.ts"],
				openQuestions: [],
				assumptions: ["No app run was needed."],
			},
			undefined,
			undefined,
			{},
		);
		expect(result?.content[0]?.text).toContain("sitra-helper-report-v1");
		expect(result?.content[0]?.text).not.toContain("Return exactly this block as your final reply");
		expect(result?.content[0]?.text).not.toMatch(/Kyle|Sam/);
		expect(result?.details).toMatchObject({ status: "done", summary: "Found the parser tests." });
	});

	test("invalid helper_report arguments fail loudly", async () => {
		vi.stubEnv("PI_SUBAGENT_NAME", "scout");
		const { tools } = fakePi();
		await expect(
			tools.get("helper_report")?.execute(
				"1",
				{
					status: "done-ish",
					summary: "Found the parser tests.",
					evidence: ["test/parser.test.ts"],
					openQuestions: [],
					assumptions: [],
				},
				undefined,
				undefined,
				{},
			),
		).rejects.toThrow(/invalid helper_report/);
	});

	test("lead context leaves teammate prose alone until the runner owns report transport", () => {
		const { handlers } = fakePi();
		const report: HelperReport = {
			status: "needs-input",
			summary: "The API contract is ambiguous.",
			evidence: ["docs/api.md"],
			openQuestions: ["Which status code should empty results use?"],
			assumptions: ["The endpoint is public."],
		};
		const messages = [
			{ role: "toolResult", toolName: "subagent", content: content(renderHelperReport(report)) },
			{ role: "toolResult", toolName: "subagent", content: content("All good, no details.") },
		];
		const rewritten = handlers.get("context")?.({ messages }, {}) as { messages: typeof messages } | undefined;
		expect(rewritten).toBeUndefined();
		expect(messages[0]?.content[0]?.text).toBe(renderHelperReport(report));
		expect(messages[1]?.content[0]?.text).toBe("All good, no details.");
	});
});

describe("run_in_pane loop metadata", () => {
	test(
		"writes active build loop commit and frozen test hashes into the run header",
		async () => {
			const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-lead-profile-")));
			vi.stubEnv("PI_CODING_AGENT_DIR", profile);
			const { tools } = fakePi();
			const { cwd, head } = gitWorktree();
			const state: LoopState = {
				...createLoopState({
					worktree: cwd,
					branch: "feature",
					baseRef: "origin/main",
					baseHead: head,
					goal: "Add the runner",
					limits: [],
					done: [],
				}),
				stage: "build",
				advisorRuns: {
					testDesign: {
						status: "done",
						summary: "tests",
						evidence: [],
						openQuestions: [],
						assumptions: [],
						acceptanceTestFiles: ["loop.test.ts"],
					},
				},
				frozenBrief: {
					version: 1,
					goal: "Add the runner",
					limits: [],
					done: [],
					questions: [],
					advisorRuns: {
						testDesign: {
							status: "done",
							summary: "tests",
							evidence: [],
							openQuestions: [],
							assumptions: [],
							acceptanceTestFiles: ["loop.test.ts"],
						},
					},
				},
			};
			writeLoopStateFile(loopStatePath(profile, cwd, "feature"), state);

			const result = await tools
				.get("run_in_pane")
				?.execute("1", { command: "true", label: "loop red" }, undefined, undefined, { cwd });
			const details = result?.details as { log: string; runId: string };
			const log = details.log;
			runGeneratedScript(profile, details.runId);
			const header = readRunHeader(readFileSync(log, "utf8").split("\n")[0] ?? "");
			expect(header?.meta.loop?.commit).toBe(head);
			expect(header?.meta.loop?.testHashes).toEqual([
				{
					file: "loop.test.ts",
					sha256: execFileSync("sha256sum", ["loop.test.ts"], { cwd, encoding: "utf8" }).split(/\s+/)[0],
				},
			]);
			expect(details.runId).toBeTypeOf("string");
		},
		SLOW_GIT_TEST_TIMEOUT,
	);

	test(
		"uses linked worktree state and hashes files in that worktree",
		async () => {
			const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-lead-profile-")));
			vi.stubEnv("PI_CODING_AGENT_DIR", profile);
			const { tools } = fakePi();
			const { cwd, head } = gitWorktree();
			const linked = addLinkedWorktree(cwd);
			writeFileSync(join(linked, "loop.test.ts"), "expect('linked').toBe('linked')\n");
			execFileSync("git", ["add", "loop.test.ts"], { cwd: linked, stdio: "ignore" });
			execFileSync(
				"git",
				["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "linked test"],
				{
					cwd: linked,
					stdio: "ignore",
				},
			);
			const linkedHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: linked, encoding: "utf8" }).trim();
			const state: LoopState = {
				...createLoopState({
					worktree: linked,
					branch: "linked",
					baseRef: "origin/main",
					baseHead: head,
					goal: "Add the runner",
					limits: [],
					done: [],
				}),
				stage: "build",
				frozenBrief: {
					version: 1,
					goal: "Add the runner",
					limits: [],
					done: [],
					questions: [],
					advisorRuns: {
						testDesign: {
							status: "done",
							summary: "tests",
							evidence: [],
							openQuestions: [],
							assumptions: [],
							acceptanceTestFiles: ["loop.test.ts"],
						},
					},
				},
			};
			writeLoopStateFile(loopStatePath(profile, linked, "linked"), state);

			const result = await tools
				.get("run_in_pane")
				?.execute("1", { command: "true", label: "linked red" }, undefined, undefined, { cwd: linked });
			const details = result?.details as { log: string; runId: string };
			runGeneratedScript(profile, details.runId);
			const header = readRunHeader(readFileSync(details.log, "utf8").split("\n")[0] ?? "");
			expect(header?.meta.loop?.commit).toBe(linkedHead);
			expect(header?.meta.loop?.testHashes?.[0]?.sha256).toBe(
				execFileSync("sha256sum", ["loop.test.ts"], { cwd: linked, encoding: "utf8" }).split(/\s+/)[0],
			);
		},
		SLOW_GIT_TEST_TIMEOUT,
	);

	test(
		"surfaces active loop state read failures instead of dropping loop metadata",
		async () => {
			const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-lead-profile-")));
			vi.stubEnv("PI_CODING_AGENT_DIR", profile);
			const { tools } = fakePi();
			const { cwd } = gitWorktree();
			mkdirSync(join(profile, "loops"), { recursive: true });
			writeFileSync(loopStatePath(profile, cwd, "feature"), "{");

			await expect(
				tools.get("run_in_pane")?.execute("1", { command: "true", label: "loop red" }, undefined, undefined, { cwd }),
			).rejects.toThrow(/invalid loop state JSON/);
		},
		SLOW_GIT_TEST_TIMEOUT,
	);

	test(
		"rejects loop build runs on a dirty worktree and names a renamed file with quoted characters",
		async () => {
			const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-lead-profile-")));
			vi.stubEnv("PI_CODING_AGENT_DIR", profile);
			const { tools } = fakePi();
			const { cwd, head } = gitWorktree();
			const state: LoopState = {
				...createLoopState({
					worktree: cwd,
					branch: "feature",
					baseRef: "origin/main",
					baseHead: head,
					goal: "Add the runner",
					limits: [],
					done: [],
				}),
				stage: "build",
				frozenBrief: {
					version: 1,
					goal: "Add the runner",
					limits: [],
					done: [],
					questions: [],
					advisorRuns: {
						testDesign: {
							status: "done",
							summary: "tests",
							evidence: [],
							openQuestions: [],
							assumptions: [],
							acceptanceTestFiles: ["loop.test.ts"],
						},
					},
				},
			};
			writeLoopStateFile(loopStatePath(profile, cwd, "feature"), state);
			const renamed = "renamed loop é.test.ts";
			execFileSync("git", ["mv", "loop.test.ts", renamed], { cwd, stdio: "ignore" });

			let message = "";
			try {
				await tools
					.get("run_in_pane")
					?.execute("1", { command: "true", label: "loop red" }, undefined, undefined, { cwd });
			} catch (error) {
				message = String(error);
			}
			expect(message).toContain("worktree must be clean");
			expect(message).toContain("loop.test.ts");
			expect(message).toContain(renamed);
		},
		SLOW_GIT_TEST_TIMEOUT,
	);

	test(
		"makes runs while the loop is blocked visibly non-evidence",
		async () => {
			const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-lead-profile-")));
			vi.stubEnv("PI_CODING_AGENT_DIR", profile);
			const { tools } = fakePi();
			const { cwd, head } = gitWorktree();
			const state: LoopState = {
				...createLoopState({
					worktree: cwd,
					branch: "feature",
					baseRef: "origin/main",
					baseHead: head,
					goal: "Add the runner",
					limits: [],
					done: [],
				}),
				stage: "blocked",
				block: {
					kind: "questions",
					questionId: "build-evidence",
					resumeStage: "build",
					pendingAdvisors: [],
				},
				questions: [
					{
						id: "build-evidence",
						text: "Need valid build evidence.",
						recommended: "Record fresh runs.",
						dependsOn: [],
					},
				],
			};
			writeLoopStateFile(loopStatePath(profile, cwd, "feature"), state);

			const result = await tools
				.get("run_in_pane")
				?.execute("1", { command: "true", label: "blocked run" }, undefined, undefined, { cwd });
			expect(result?.content[0]?.text).toContain("not recorded as loop evidence: loop is blocked at build");
			const details = result?.details as { log: string; runId: string };
			runGeneratedScript(profile, details.runId);
			const header = readRunHeader(readFileSync(details.log, "utf8").split("\n")[0] ?? "");
			expect(header?.meta.loop).toBeUndefined();
		},
		SLOW_GIT_TEST_TIMEOUT,
	);

	test(
		"ordinary runs during build record missing frozen test files instead of failing",
		async () => {
			const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-lead-profile-")));
			vi.stubEnv("PI_CODING_AGENT_DIR", profile);
			const { tools } = fakePi();
			const { cwd, head } = gitWorktree();
			const state: LoopState = {
				...createLoopState({
					worktree: cwd,
					branch: "feature",
					baseRef: "origin/main",
					baseHead: head,
					goal: "Add the runner",
					limits: [],
					done: [],
				}),
				stage: "build",
				frozenBrief: {
					version: 1,
					goal: "Add the runner",
					limits: [],
					done: [],
					questions: [],
					advisorRuns: {
						testDesign: {
							status: "done",
							summary: "tests",
							evidence: [],
							openQuestions: [],
							assumptions: [],
							acceptanceTestFiles: ["missing.test.ts"],
						},
					},
				},
			};
			writeLoopStateFile(loopStatePath(profile, cwd, "feature"), state);

			const result = await tools
				.get("run_in_pane")
				?.execute("1", { command: "ls", label: "ordinary" }, undefined, undefined, { cwd });
			const details = result?.details as { log: string; runId: string };
			runGeneratedScript(profile, details.runId);
			const header = readRunHeader(readFileSync(details.log, "utf8").split("\n")[0] ?? "");
			expect(header?.meta.loop?.testHashes).toEqual([{ file: "missing.test.ts", missing: true }]);
		},
		SLOW_GIT_TEST_TIMEOUT,
	);
});

describe("run_in_pane herdr pane readiness", () => {
	test("waits for the ready marker in a fresh pane before typing", async () => {
		const fake = installFakeHerdr();
		const { tools } = fakePi();

		await tools
			.get("run_in_pane")
			?.execute("1", { command: "echo ready-order", label: "ready order" }, undefined, undefined, { cwd: fake.cwd });

		const calls = fake.calls();
		expect(calls[0]?.slice(0, 2)).toEqual(["pane", "split"]);
		expect(calls[1]?.slice(0, 3)).toEqual(["pane", "run", "pane-fresh"]);
		expect(calls[1]?.[3]).toContain("printf 'sitra-%s\\n'");
		expect(calls[1]?.[3]).not.toContain("sitra-ready-");
		expect(calls[2]?.slice(0, 3)).toEqual(["pane", "wait-output", "pane-fresh"]);
		expect(calls[2]).toContain("--match");
		expect(calls[2]).toContain("--timeout");
		expect(calls[3]?.slice(0, 3)).toEqual(["pane", "run", "pane-fresh"]);
		expect(calls[3]?.[3]).toMatch(/^bash '.+\.sh'$/);
	});

	test("fails loudly and types nothing when the fresh pane never gets ready", async () => {
		const fake = installFakeHerdr({ waitFails: true });
		const { tools } = fakePi();

		const result = await tools
			.get("run_in_pane")
			?.execute("1", { command: "echo never-run", label: "never ready" }, undefined, undefined, { cwd: fake.cwd });

		expect(result?.content[0]?.text).toContain("pane shell never became ready");
		expect(result?.content[0]?.text).toContain("pane-fresh");
		const runCalls = fake.calls().filter((call) => call[0] === "pane" && call[1] === "run");
		expect(runCalls).toHaveLength(1);
		expect(runCalls[0]?.[3]).toContain("printf 'sitra-%s\\n'");
		expect(runCalls[0]?.[3]).not.toContain("never-run");
	});

	test("after a ready timeout the next run opens a new pane and waits again", async () => {
		const fake = installFakeHerdr({ waitFailures: 1, splitPaneIds: ["pane-first", "pane-second"] });
		const { tools } = fakePi();

		const first = await tools
			.get("run_in_pane")
			?.execute("1", { command: "echo first", label: "first timeout" }, undefined, undefined, { cwd: fake.cwd });
		const second = await tools
			.get("run_in_pane")
			?.execute("2", { command: "echo second", label: "second succeeds" }, undefined, undefined, { cwd: fake.cwd });

		expect(first?.content[0]?.text).toContain("pane shell never became ready");
		expect(first?.content[0]?.text).toContain("left as-is");
		expect(second?.content[0]?.text).toContain('herdr pane pane-second ("second succeeds")');
		const calls = fake.calls();
		expect(calls.filter((call) => call[0] === "pane" && call[1] === "split").length).toBe(2);
		const waits = calls.filter((call) => call[0] === "pane" && call[1] === "wait-output");
		expect(waits.map((call) => call[2])).toEqual(["pane-first", "pane-second"]);
		const commandRuns = calls.filter((call) => call[0] === "pane" && call[1] === "run" && call[3]?.startsWith("bash "));
		expect(commandRuns).toHaveLength(1);
		expect(commandRuns[0]?.[2]).toBe("pane-second");
	});

	test("in a reused pane types without waiting", async () => {
		const fake = installFakeHerdr();
		const { tools } = fakePi();

		await tools
			.get("run_in_pane")
			?.execute("1", { command: "echo first", label: "first" }, undefined, undefined, { cwd: fake.cwd });
		await tools
			.get("run_in_pane")
			?.execute("2", { command: "echo second", label: "second" }, undefined, undefined, { cwd: fake.cwd });

		const calls = fake.calls();
		const secondGet = calls.findIndex((call) => call[0] === "pane" && call[1] === "get");
		expect(secondGet).toBeGreaterThan(-1);
		const afterGet = calls.slice(secondGet + 1);
		expect(afterGet.some((call) => call[1] === "wait-output")).toBe(false);
		expect(afterGet[0]?.slice(0, 3)).toEqual(["pane", "run", "pane-fresh"]);
		expect(afterGet[0]?.[3]).toMatch(/^bash '.+\.sh'$/);
	});
});
