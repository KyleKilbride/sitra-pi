import { describe, expect, test } from "vitest";
import type { HelperReport } from "../extensions/helper-report.ts";
import {
	advisorKey,
	answerLoopQuestion,
	applyAdvisorReport,
	applyLeadPlan,
	applyVerifierReport,
	approveBrief,
	blockForAdvisorIntakeFailure,
	blockForStaleState,
	briefHash,
	buildBrief,
	createLoopState,
	nextLoopEffects,
	recordBuildEvidence,
	staleReason,
	startBuild,
	startLoop,
	validateLoopState,
	verifierTask,
} from "../extensions/loop.ts";

const context = { worktree: "/repo", branch: "feature", baseRef: "origin/main", baseHead: "base-a" };
const testHashes = [{ file: "test/loop.test.ts", sha256: "abc123" }];

function approvedState() {
	let state = createLoopState({ ...context, goal: "Add the loop runner.", limits: ["No full suite."], done: [] });
	state = applyAdvisorReport(state, report("intent"), { outputTokens: 1, contextTokens: 0 }).state;
	state = applyAdvisorReport(state, report("codebase"), { outputTokens: 1, contextTokens: 0 }).state;
	state = applyAdvisorReport(state, report("test-design"), { outputTokens: 1, contextTokens: 0 }).state;
	state = applyLeadPlan(state, "Keep transitions pure and Pi wiring thin.").state;
	state = applyAdvisorReport(state, report("architecture"), { outputTokens: 1, contextTokens: 0 }).state;
	return approveBrief(state, {
		approvedBy: "person",
		approvedAt: "2026-10-22T00:00:00.000Z",
		summary: "Approved for build.",
	}).state;
}

const run = (
	overrides: Partial<{
		log: string;
		done: boolean;
		exitCode: number;
		commit: string;
		testHashes: typeof testHashes;
	}> = {},
) => ({
	log: overrides.log ?? "/tmp/run.log",
	done: overrides.done ?? true,
	exitCode: overrides.exitCode ?? 0,
	loop: {
		commit: overrides.commit ?? "commit-a",
		testHashes: overrides.testHashes ?? testHashes,
	},
});

const report = (role: HelperReport["role"], extra: Partial<HelperReport> = {}): HelperReport => ({
	status: "done",
	role,
	summary: `${role} done`,
	evidence: [`${role}.md:1`],
	openQuestions: [],
	assumptions: [],
	details:
		role === "intent"
			? { questions: [], doneCandidates: ["done means shipped"], ambiguities: [] }
			: role === "codebase"
				? { files: ["extensions/loop.ts"], existingTests: [], facts: [], boundaries: [], owners: [] }
				: role === "test-design"
					? {
							acceptanceTests: [
								{
									name: "loop",
									proves: "runner",
									targetFile: "test/loop.test.ts",
									command: "pnpm vitest run test/loop.test.ts",
								},
							],
						}
					: role === "architecture"
						? {
								fitsExistingArchitecture: true,
								boundaryConcerns: [],
								needlessLayersOrCode: [],
								simplerShape: [],
								checklistEntriesUsed: [],
								checklist: { state: "absent", path: "/profile/agents/checklists/architecture.md" },
							}
						: undefined,
	...extra,
});

describe("loop schema and start", () => {
	test("starts only from an explicit event and dispatches intent/codebase in parallel", () => {
		const result = startLoop({
			...context,
			goal: "Add the loop runner.",
			limits: ["No full suite."],
			done: ["Brief is approved."],
			grimoire: { state: "ok", dir: "/profile/grimoire" },
		});

		expect(result.state.stage).toBe("advise");
		expect(result.effects).toMatchObject([{ type: "dispatch-advisors", roles: ["intent", "codebase"] }]);
		expect(validateLoopState(result.state)).toMatchObject({ ok: true });
	});

	test("missing Grimoire continues with empty knowledge, unreadable Grimoire blocks with one question", () => {
		const missing = startLoop({
			...context,
			goal: "Add the loop runner.",
			limits: [],
			done: [],
			grimoire: { state: "missing", dir: "/profile/grimoire", reason: "not created yet" },
		});
		expect(missing.state.stage).toBe("advise");
		expect(missing.effects).toMatchObject([{ type: "dispatch-advisors", roles: ["intent", "codebase"] }]);

		const unreadable = startLoop({
			...context,
			goal: "Add the loop runner.",
			limits: [],
			done: [],
			grimoire: { state: "unreadable", dir: "/profile/grimoire", reason: "permission denied" },
		});
		expect(unreadable.state.stage).toBe("blocked");
		expect(unreadable.state.questions).toHaveLength(1);
		expect(unreadable.state.questions[0]?.text).toContain("Grimoire");
		expect(unreadable.effects).toMatchObject([{ type: "ask-person", reason: "grimoire-unreadable" }]);
	});
});

describe("advisor transition and ordering", () => {
	test("runs test-design after intent/codebase, asks one grouped question, and reruns only affected advisors after an answer", () => {
		let state = createLoopState({
			...context,
			goal: "Add the loop runner.",
			limits: [],
			done: [],
		});
		expect(nextLoopEffects(state)).toMatchObject([{ type: "dispatch-advisors", roles: ["intent", "codebase"] }]);

		state = applyAdvisorReport(state, report("intent"), { outputTokens: 1, contextTokens: 11 }).state;
		expect(nextLoopEffects(state)).toEqual([]);

		state = applyAdvisorReport(state, report("codebase"), { outputTokens: 2, contextTokens: 22 }).state;
		expect(nextLoopEffects(state)).toMatchObject([{ type: "dispatch-advisors", roles: ["test-design"] }]);

		state = applyAdvisorReport(
			state,
			report("test-design", {
				status: "needs-input",
				openQuestions: ["Should the CLI command be /loop start?"],
			}),
			{ outputTokens: 3, contextTokens: 33 },
		).state;
		expect(state.stage).toBe("needs-person");
		expect(state.questions).toHaveLength(1);
		expect(state.questions[0]?.text).toContain("Should the CLI command be /loop start?");

		const answered = answerLoopQuestion(state, {
			answer: "Yes, use /loop start.",
			current: context,
		});
		state = answered.state;
		expect(state.stage).toBe("advise");
		expect(state.questions[0]?.answer).toBe("Yes, use /loop start.");
		expect(state.advisorRuns.intent?.summary).toBe("intent done");
		expect(state.advisorRuns.codebase?.summary).toBe("codebase done");
		expect(state.advisorRuns.testDesign).toBeUndefined();
		expect(answered.effects).toMatchObject([{ type: "dispatch-advisors", roles: ["test-design"] }]);
	});

	test("keeps answered question history across two question rounds and passes both answers to rerun tasks", () => {
		let state = createLoopState({ ...context, goal: "Add the loop runner.", limits: [], done: [] });
		state = applyAdvisorReport(
			state,
			report("intent", {
				details: {
					questions: [
						{
							id: "q-command",
							text: "Use /loop start?",
							recommended: "Yes, use it.",
							dependsOn: [],
						},
					],
					doneCandidates: [],
					ambiguities: [],
				},
			}),
			{
				outputTokens: 1,
				contextTokens: 2,
			},
		).state;
		state = applyAdvisorReport(state, report("codebase"), { outputTokens: 1, contextTokens: 2 }).state;
		state = answerLoopQuestion(state, { answer: "Yes, use /loop start.", current: context }).state;
		state = applyAdvisorReport(state, report("intent"), { outputTokens: 1, contextTokens: 2 }).state;
		state = applyAdvisorReport(
			state,
			report("test-design", { status: "needs-input", openQuestions: ["Should the red test be first?"] }),
			{ outputTokens: 1, contextTokens: 2 },
		).state;

		const answered = answerLoopQuestion(state, { answer: "Yes, write red first.", current: context });
		expect(answered.state.questions.map((question) => question.answer)).toEqual([
			"Yes, use /loop start.",
			"Yes, write red first.",
		]);
		expect(answered.effects[0]).toMatchObject({ type: "dispatch-advisors", roles: ["test-design"] });
		const task = answered.effects[0]?.type === "dispatch-advisors" ? answered.effects[0].advisors[0]?.task : "";
		expect(task).toContain("Yes, use /loop start.");
		expect(task).toContain("Yes, write red first.");
	});

	test("groups several ready questions into one person question", () => {
		let state = createLoopState({ ...context, goal: "Add the loop runner.", limits: [], done: [] });
		state = applyAdvisorReport(
			state,
			report("intent", {
				details: {
					questions: [
						{
							id: "q1",
							text: "Should the runner ask before build?",
							recommended: "Yes, ask before build.",
							dependsOn: [],
						},
						{
							id: "q2",
							text: "Which command starts the graph?",
							recommended: "Use /loop start.",
							dependsOn: [],
						},
					],
					doneCandidates: [],
					ambiguities: [],
				},
			}),
			{ outputTokens: 1, contextTokens: 0 },
		).state;
		state = applyAdvisorReport(state, report("codebase", { openQuestions: ["Should state live in the profile?"] }), {
			outputTokens: 2,
			contextTokens: 0,
		}).state;
		expect(state.stage).toBe("needs-person");
		expect(state.questions).toHaveLength(1);
		expect(state.questions[0]?.text).toContain("Should the runner ask before build?");
		expect(state.questions[0]?.text).toContain("Which command starts the graph?");
		expect(state.questions[0]?.text).toContain("Should state live in the profile?");
	});

	test("moves from completed advisors to lead plan, architecture review, and explicit brief approval", () => {
		let state = createLoopState({ ...context, goal: "Add the loop runner.", limits: [], done: [] });
		state = applyAdvisorReport(state, report("intent"), { outputTokens: 1, contextTokens: 1 }).state;
		state = applyAdvisorReport(state, report("codebase"), { outputTokens: 1, contextTokens: 1 }).state;
		state = applyAdvisorReport(state, report("test-design"), { outputTokens: 1, contextTokens: 1 }).state;
		expect(state.stage).toBe("plan");
		expect(nextLoopEffects(state)).toMatchObject([{ type: "write-lead-plan" }]);

		const planned = applyLeadPlan(state, "Keep Pi wiring thin and transition logic pure.");
		state = planned.state;
		expect(state.stage).toBe("architecture-review");
		expect(planned.effects).toMatchObject([{ type: "dispatch-advisors", roles: ["architecture"] }]);

		state = applyAdvisorReport(state, report("architecture"), { outputTokens: 4, contextTokens: 0 }).state;
		expect(state.stage).toBe("architecture-review");
		state = approveBrief(state, {
			approvedBy: "person",
			approvedAt: "2026-10-22T00:00:00.000Z",
			summary: "Approved for slice one.",
		}).state;
		expect(state.stage).toBe("brief-approved");
		expect(state.frozenBriefHash).toBe(briefHash(buildBrief(state)));
	});

	test("architecture questions return to needs-person before approval", () => {
		let state = createLoopState({ ...context, goal: "Add the loop runner.", limits: [], done: [] });
		state = applyAdvisorReport(state, report("intent"), { outputTokens: 1, contextTokens: 0 }).state;
		state = applyAdvisorReport(state, report("codebase"), { outputTokens: 2, contextTokens: 0 }).state;
		state = applyAdvisorReport(state, report("test-design"), { outputTokens: 3, contextTokens: 0 }).state;
		state = applyLeadPlan(state, "Plan").state;
		state = applyAdvisorReport(
			state,
			report("architecture", { status: "blocked", openQuestions: ["Is the private checklist readable?"] }),
			{ outputTokens: 4, contextTokens: 0 },
		).state;
		expect(state.stage).toBe("needs-person");
		expect(state.questions).toHaveLength(1);
	});

	test("a blocked architecture report with no open question still asks the person", () => {
		let state = createLoopState({ ...context, goal: "Add the loop runner.", limits: [], done: [] });
		state = applyAdvisorReport(state, report("intent"), { outputTokens: 1, contextTokens: 0 }).state;
		state = applyAdvisorReport(state, report("codebase"), { outputTokens: 2, contextTokens: 0 }).state;
		state = applyAdvisorReport(state, report("test-design"), { outputTokens: 3, contextTokens: 0 }).state;
		state = applyLeadPlan(state, "Plan").state;
		state = applyAdvisorReport(state, report("architecture", { status: "blocked", summary: "Checklist unreadable." }), {
			outputTokens: 4,
			contextTokens: 0,
		}).state;
		expect(state.stage).toBe("needs-person");
		expect(state.questions[0]?.text).toContain("Checklist unreadable.");
	});

	test("intent blocked status and open questions block intake instead of dispatching test-design", () => {
		let state = createLoopState({ ...context, goal: "Add the loop runner.", limits: [], done: [] });
		state = applyAdvisorReport(
			state,
			report("intent", {
				status: "blocked",
				openQuestions: ["Which repo?"],
				details: {
					questions: [
						{
							id: "q-intent",
							text: "Use the existing profile?",
							recommended: "Yes.",
							dependsOn: [],
						},
					],
					doneCandidates: [],
					ambiguities: [],
				},
			}),
			{ outputTokens: 1, contextTokens: 0 },
		).state;
		state = applyAdvisorReport(state, report("codebase"), { outputTokens: 1, contextTokens: 0 }).state;
		expect(state.stage).toBe("needs-person");
		expect(state.block).toMatchObject({ kind: "questions" });
		expect(state.questions.at(-1)?.text).toContain("Which repo?");
		expect(state.questions.at(-1)?.text).toContain("Use the existing profile?");
		expect(state.dispatchedAdvisors).toEqual([]);
	});

	test("rejects reports outside the active stage or from undispatched advisors", () => {
		let state = createLoopState({ ...context, goal: "Add the loop runner.", limits: [], done: [] });
		expect(() =>
			applyAdvisorReport({ ...state, stage: "blocked" }, report("intent"), { outputTokens: 1, contextTokens: 0 }),
		).toThrow(/cannot apply advisor report/);
		expect(() => applyAdvisorReport(state, report("test-design"), { outputTokens: 1, contextTokens: 0 })).toThrow(
			/not dispatched/,
		);
		state = applyAdvisorReport(state, report("intent"), { outputTokens: 1, contextTokens: 0 }).state;
		expect(() => applyAdvisorReport(state, report("architecture"), { outputTokens: 1, contextTokens: 0 })).toThrow(
			/not dispatched/,
		);
	});
});

describe("stale state and validation", () => {
	test("blocks stale state when branch/base changes or the frozen brief hash is no longer current", () => {
		let state = createLoopState({ ...context, goal: "Add the loop runner.", limits: [], done: [] });
		expect(staleReason(state, context)).toBeUndefined();
		expect(staleReason(state, { ...context, branch: "other" })).toContain("branch changed");
		expect(staleReason(state, { ...context, baseHead: "base-b" })).toContain("base head changed");

		state = {
			...state,
			stage: "brief-approved",
			plan: { author: "lead", text: "Original plan" },
			advisorRuns: {
				intent: {
					status: "done",
					summary: "Intent",
					evidence: [],
					openQuestions: [],
					assumptions: [],
					outputTokens: 1,
					contextTokens: 0,
				},
				codebase: {
					status: "done",
					summary: "Codebase",
					evidence: [],
					openQuestions: [],
					assumptions: [],
					outputTokens: 1,
					contextTokens: 0,
				},
				testDesign: {
					status: "done",
					summary: "Tests",
					evidence: [],
					openQuestions: [],
					assumptions: [],
					outputTokens: 1,
					contextTokens: 0,
				},
				architecture: {
					status: "done",
					summary: "Architecture",
					evidence: [],
					openQuestions: [],
					assumptions: [],
					outputTokens: 1,
					contextTokens: 0,
				},
			},
			frozenBriefHash: "not-current",
		};
		expect(staleReason(state, context)).toContain("frozen brief hash");
	});

	test("a freshly approved brief is not stale, and stale blocks can be left by answering", () => {
		let state = createLoopState({ ...context, goal: "Add the loop runner.", limits: [], done: [] });
		state = applyAdvisorReport(state, report("intent"), { outputTokens: 1, contextTokens: 0 }).state;
		state = applyAdvisorReport(state, report("codebase"), { outputTokens: 2, contextTokens: 0 }).state;
		state = applyAdvisorReport(state, report("test-design"), { outputTokens: 3, contextTokens: 0 }).state;
		state = applyLeadPlan(state, "Plan").state;
		state = applyAdvisorReport(state, report("architecture"), { outputTokens: 4, contextTokens: 0 }).state;
		state = approveBrief(state, {
			approvedBy: "person",
			approvedAt: "2026-10-22T00:00:00.000Z",
			summary: "Approved.",
		}).state;
		expect(staleReason(state, context)).toBeUndefined();
		const blocked = blockForStaleState(state, { ...context, branch: "feature", baseHead: "base-b" }).state;
		expect(blocked.stage).toBe("blocked");
		expect(blocked.frozenBriefHash).toBe(state.frozenBriefHash);
		const answered = answerLoopQuestion(blocked, {
			answer: "Continue on the new branch and base.",
			current: { ...context, branch: "feature", baseHead: "base-b" },
		}).state;
		expect(answered.stage).toBe("brief-approved");
		expect(answered.branch).toBe("feature");
		expect(answered.baseHead).toBe("base-b");
		expect(staleReason(answered, { ...context, branch: "feature", baseHead: "base-b" })).toBeUndefined();
	});

	test("answering stale mid-advise persists redispatch state so the next report is accepted", () => {
		let state = createLoopState({ ...context, goal: "Add the loop runner.", limits: [], done: [] });
		state = applyAdvisorReport(state, report("intent"), { outputTokens: 1, contextTokens: 0 }).state;
		const blocked = blockForStaleState(state, { ...context, baseHead: "base-b" }).state;
		const answered = answerLoopQuestion(blocked, {
			answer: "Continue.",
			current: { ...context, baseHead: "base-b" },
		}).state;
		expect(answered.dispatchedAdvisors).toEqual(["codebase"]);
		const reported = applyAdvisorReport(answered, report("codebase"), { outputTokens: 1, contextTokens: 0 }).state;
		expect(reported.stage).toBe("advise");
		expect(reported.advisorRuns.codebase?.summary).toBe("codebase done");
	});

	test("answered stale history does not hijack a later normal question round", () => {
		let state = createLoopState({ ...context, goal: "Add the loop runner.", limits: [], done: [] });
		state = applyAdvisorReport(state, report("intent"), { outputTokens: 1, contextTokens: 0 }).state;
		const blocked = blockForStaleState(state, { ...context, baseHead: "base-b" }).state;
		state = answerLoopQuestion(blocked, { answer: "Continue.", current: { ...context, baseHead: "base-b" } }).state;
		state = applyAdvisorReport(state, report("codebase", { openQuestions: ["Keep state under the profile?"] }), {
			outputTokens: 1,
			contextTokens: 0,
		}).state;
		expect(state.stage).toBe("needs-person");
		const answered = answerLoopQuestion(state, {
			answer: "Yes, keep it in the profile.",
			current: { ...context, baseHead: "base-b" },
		}).state;
		expect(answered.stage).toBe("advise");
		expect(answered.questions.at(-1)?.answer).toBe("Yes, keep it in the profile.");
		expect(answered.branch).toBe("feature");
	});

	test("stale blocks append to answered question history", () => {
		let state = createLoopState({ ...context, goal: "Add the loop runner.", limits: [], done: [] });
		state = applyAdvisorReport(state, report("intent"), {
			outputTokens: 1,
			contextTokens: 0,
		}).state;
		state = applyAdvisorReport(state, report("codebase", { openQuestions: ["A1?"] }), {
			outputTokens: 1,
			contextTokens: 0,
		}).state;
		state = answerLoopQuestion(state, { answer: "A1", current: context }).state;
		const blocked = blockForStaleState(state, { ...context, baseHead: "base-b" }).state;
		expect(blocked.questions[0]?.answer).toBe("A1");
		expect(blocked.questions.at(-1)?.id).toBe("stale-state");
	});

	test("an existing block is structural and is not overwritten by later problems", () => {
		let state = createLoopState({ ...context, goal: "Add the loop runner.", limits: [], done: [] });
		state = applyAdvisorReport(state, report("intent"), { outputTokens: 1, contextTokens: 0 }).state;
		const blocked = blockForStaleState(state, { ...context, baseHead: "base-b" }).state;
		const stacked = blockForAdvisorIntakeFailure(blocked, "codebase", "helper report missing").state;
		expect(stacked.block).toMatchObject({ kind: "stale", resumeStage: "advise", pendingAdvisors: ["codebase"] });
		expect(stacked.block?.resumeStage).not.toBe("blocked");
		expect(stacked.block?.resumeStage).not.toBe("needs-person");
		expect(stacked.questions.at(-1)?.text).toContain("Additional problem");
		const answered = answerLoopQuestion(stacked, {
			answer: "Continue.",
			current: { ...context, baseHead: "base-b" },
		}).state;
		expect(answered.stage).toBe("advise");
		expect(answered.block).toBeUndefined();
		expect(answered.dispatchedAdvisors).toEqual(["codebase"]);
	});

	test("validates TypeBox state fields loudly", () => {
		const state = createLoopState({ ...context, goal: "Add the loop runner.", limits: [], done: [] });
		expect(validateLoopState(state)).toMatchObject({ ok: true });
		expect(validateLoopState({ ...state, version: 2 })).toMatchObject({
			ok: false,
			reason: expect.stringContaining("/version"),
		});
		expect(advisorKey("test-design")).toBe("testDesign");
	});
});

describe("build and verify slice", () => {
	test("starts build only after brief approval, records runner-computed test hashes, and writes an isolated verifier task", () => {
		let state = approvedState();
		const started = startBuild(state);
		state = started.state;
		expect(state.stage).toBe("build");
		expect(started.effects).toEqual([]);
		const result = recordBuildEvidence(state, {
			commit: "commit-a",
			diff: "diff --git a/extensions/loop.ts b/extensions/loop.ts",
			testFiles: ["test/loop.test.ts"],
			testHashes,
			redRun: run({ log: "/tmp/red.log", exitCode: 1, commit: "tests-only" }),
			greenRun: run({ log: "/tmp/green.log", exitCode: 0 }),
			maxVerifierRerunMs: 120_000,
		});
		expect(result.state.stage).toBe("verify");
		expect(result.state.build).toMatchObject({
			commit: "commit-a",
			testFiles: ["test/loop.test.ts"],
			testHashes,
			redRunLog: "/tmp/red.log",
			greenRunLog: "/tmp/green.log",
		});
		expect(result.effects).toHaveLength(1);
		expect(result.effects[0]).toMatchObject({ type: "dispatch-verifier", agent: "verifier" });
		const task = result.effects[0]?.type === "dispatch-verifier" ? result.effects[0].task : "";
		expect(task).toContain("Frozen brief:");
		expect(task).toContain("diff --git");
		expect(task).toContain('"sha256": "abc123"');
		expect(task).toContain("/tmp/red.log");
		expect(task).toContain("/tmp/green.log");
		expect(task).toContain("maxVerifierRerunMs: 120000");
		expect(task).not.toContain("builder transcript");
		expect(task).not.toContain("## Context from the lead's conversation");
	});

	test("blocks verify, without reopening the brief, when the red run is missing, passed, unfinished, or not tied to current hashes", () => {
		const state = startBuild(approvedState()).state;
		for (const redRun of [
			undefined,
			run({ exitCode: 0 }),
			run({ done: false, exitCode: 1 }),
			run({ exitCode: 1, testHashes: [{ file: "test/loop.test.ts", sha256: "stale" }] }),
		]) {
			const result = recordBuildEvidence(state, {
				commit: "commit-a",
				diff: "diff",
				testFiles: ["test/loop.test.ts"],
				testHashes,
				redRun,
				greenRun: run({ log: "/tmp/green.log", exitCode: 0 }),
				maxVerifierRerunMs: 120_000,
			});
			expect(result.state.stage).toBe("blocked");
			expect(result.state.block).toMatchObject({ resumeStage: "build" });
			expect(result.effects).toMatchObject([{ type: "ask-person" }]);
		}
	});

	test("allows red evidence from a tests-only ancestor and green evidence from HEAD", () => {
		const state = startBuild(approvedState()).state;
		const result = recordBuildEvidence(state, {
			commit: "impl-head",
			diff: "diff",
			testFiles: ["test/loop.test.ts"],
			testHashes,
			redRun: run({ log: "/tmp/red.log", exitCode: 1, commit: "tests-only" }),
			greenRun: run({ log: "/tmp/green.log", exitCode: 0, commit: "impl-head" }),
			maxVerifierRerunMs: 120_000,
		});
		expect(result.state.stage).toBe("verify");
		expect(result.state.build).toMatchObject({ commit: "impl-head", redCommit: "tests-only" });
	});

	test("blocks build evidence when test files are empty or not in the frozen test-design brief", () => {
		const state = startBuild(approvedState()).state;
		const empty = recordBuildEvidence(state, {
			commit: "commit-a",
			diff: "diff",
			testFiles: [],
			testHashes: [],
			redRun: run({ log: "/tmp/red.log", exitCode: 1, testHashes: [] }),
			greenRun: run({ log: "/tmp/green.log", exitCode: 0, testHashes: [] }),
			maxVerifierRerunMs: 120_000,
		});
		expect(empty.state.stage).toBe("blocked");
		expect(empty.state.block).toMatchObject({ resumeStage: "build" });

		const unagreed = recordBuildEvidence(state, {
			commit: "commit-a",
			diff: "diff",
			testFiles: ["test/not-agreed.test.ts"],
			testHashes: [{ file: "test/not-agreed.test.ts", sha256: "hash" }],
			redRun: run({
				log: "/tmp/red.log",
				exitCode: 1,
				testHashes: [{ file: "test/not-agreed.test.ts", sha256: "hash" }],
			}),
			greenRun: run({
				log: "/tmp/green.log",
				exitCode: 0,
				testHashes: [{ file: "test/not-agreed.test.ts", sha256: "hash" }],
			}),
			maxVerifierRerunMs: 120_000,
		});
		expect(unagreed.state.stage).toBe("blocked");
		expect(unagreed.state.questions.at(-1)?.text).toContain("not in the frozen brief");
	});

	test("treats changed test hashes and changed verifier diff as stale in build and verify", () => {
		let state = startBuild(approvedState()).state;
		state = recordBuildEvidence(state, {
			commit: "commit-a",
			diff: "original diff",
			testFiles: ["test/loop.test.ts"],
			testHashes,
			redRun: run({ log: "/tmp/red.log", exitCode: 1, commit: "tests-only" }),
			greenRun: run({ log: "/tmp/green.log", exitCode: 0 }),
			maxVerifierRerunMs: 120_000,
		}).state;
		expect(staleReason(state, { ...context, testHashes })).toBeUndefined();
		expect(
			staleReason(state, { ...context, testHashes: [{ file: "test/loop.test.ts", sha256: "changed" }] }),
		).toContain("test hashes");
		expect(staleReason(state, { ...context, testHashes, diffHash: "different" })).toContain("diff");
	});

	test("post-approval block questions do not change the frozen brief hash or get re-frozen by stale answers", () => {
		const approved = approvedState();
		const originalHash = approved.frozenBriefHash;
		const blocked = recordBuildEvidence(startBuild(approved).state, {
			commit: "commit-a",
			diff: "diff",
			testFiles: ["test/loop.test.ts"],
			testHashes,
			redRun: undefined,
			greenRun: run({ log: "/tmp/green.log", exitCode: 0 }),
			maxVerifierRerunMs: 120_000,
		}).state;
		expect(blocked.stage).toBe("blocked");
		expect(blocked.frozenBriefHash).toBe(originalHash);
		expect(staleReason(blocked, context)).toBeUndefined();
		const stale = blockForStaleState(blocked, { ...context, baseHead: "base-b" }).state;
		const answered = answerLoopQuestion(stale, {
			answer: "Continue.",
			current: { ...context, baseHead: "base-b" },
		}).state;
		expect(answered.frozenBriefHash).toBe(originalHash);
	});

	test("freezes a brief snapshot at approval instead of filtering post-approval questions by id", () => {
		const approved = approvedState();
		const originalHash = approved.frozenBriefHash;
		const withGitQuestion = {
			...approved,
			questions: [
				...approved.questions,
				{
					id: "git-state",
					text: "Git failed during build.",
					recommended: "Fix git.",
					dependsOn: [],
				},
			],
		};
		expect(briefHash(buildBrief(withGitQuestion))).toBe(originalHash);
		expect(staleReason(withGitQuestion, context)).toBeUndefined();
	});

	test("accepts verifier pass to the single done state and miss or blocked reports to classify with a structural block", () => {
		let state = recordBuildEvidence(startBuild(approvedState()).state, {
			commit: "commit-a",
			diff: "diff",
			testFiles: ["test/loop.test.ts"],
			testHashes,
			redRun: run({ log: "/tmp/red.log", exitCode: 1, commit: "tests-only" }),
			greenRun: run({ log: "/tmp/green.log", exitCode: 0 }),
			maxVerifierRerunMs: 120_000,
		}).state;
		const passed = applyVerifierReport(
			state,
			{
				status: "done",
				role: "verifier",
				summary: "Verified.",
				evidence: ["diff"],
				openQuestions: [],
				assumptions: [],
				details: {
					checksRun: ["pnpm vitest run test/loop.test.ts"],
					rerunChecks: [{ command: "pnpm vitest run test/loop.test.ts", log: "/tmp/rerun.log", reason: "cheap" }],
					acceptedLogs: [{ log: "/tmp/green.log", reason: "tied to commit and hashes" }],
					testHashesChecked: ["test/loop.test.ts"],
					goalMatched: true,
				},
			},
			{ acceptedLogs: [run({ log: "/tmp/green.log", exitCode: 0 })] },
		).state;
		expect(passed.stage).toBe("done");
		expect(nextLoopEffects(passed)).toEqual([]);

		state = { ...state, verification: undefined };
		const missed = applyVerifierReport(
			state,
			{
				status: "done",
				role: "verifier",
				summary: "Goal missed.",
				evidence: ["diff"],
				openQuestions: [],
				assumptions: [],
				details: {
					checksRun: [],
					rerunChecks: [],
					acceptedLogs: [],
					testHashesChecked: ["test/loop.test.ts"],
					goalMatched: false,
					missClass: "execution-slip",
				},
			},
			{ acceptedLogs: [] },
		).state;
		expect(missed.stage).toBe("blocked");
		expect(missed.block).toMatchObject({ kind: "questions", resumeStage: "classify" });
		expect(missed.verification).toMatchObject({ status: "missed", summary: "Goal missed." });

		const blocked = applyVerifierReport(
			{ ...state, verification: undefined },
			{
				status: "blocked",
				role: "verifier",
				summary: "Could not inspect evidence.",
				evidence: [],
				openQuestions: ["Which log should I trust?"],
				assumptions: [],
				details: {
					checksRun: [],
					rerunChecks: [],
					acceptedLogs: [],
					testHashesChecked: [],
					goalMatched: false,
				},
			},
			{ acceptedLogs: [] },
		).state;
		expect(blocked.stage).toBe("blocked");
		expect(blocked.verification).toMatchObject({ status: "blocked" });
	});

	test("rejects verifier reports that accept logs not tied to the exact commit and test hashes", () => {
		const state = recordBuildEvidence(startBuild(approvedState()).state, {
			commit: "commit-a",
			diff: "diff",
			testFiles: ["test/loop.test.ts"],
			testHashes,
			redRun: run({ log: "/tmp/red.log", exitCode: 1, commit: "tests-only" }),
			greenRun: run({ log: "/tmp/green.log", exitCode: 0 }),
			maxVerifierRerunMs: 120_000,
		}).state;
		const result = applyVerifierReport(
			state,
			{
				status: "done",
				role: "verifier",
				summary: "Accepted stale log.",
				evidence: [],
				openQuestions: [],
				assumptions: [],
				details: {
					checksRun: [],
					rerunChecks: [],
					acceptedLogs: [{ log: "/tmp/green.log", reason: "looked green" }],
					testHashesChecked: ["test/loop.test.ts"],
					goalMatched: true,
				},
			},
			{ acceptedLogs: [run({ log: "/tmp/green.log", exitCode: 0, commit: "other" })] },
		);
		expect(result.state.stage).toBe("blocked");
		expect(result.state.block).toMatchObject({ kind: "intake-failed", resumeStage: "verify" });
		expect(result.effects[0]).toMatchObject({ type: "ask-person", reason: "intake-failed" });

		const accepted = applyVerifierReport(
			result.state,
			{
				status: "done",
				role: "verifier",
				summary: "Verified.",
				evidence: [],
				openQuestions: [],
				assumptions: [],
				details: {
					checksRun: [],
					rerunChecks: [],
					acceptedLogs: [],
					testHashesChecked: ["test/loop.test.ts"],
					goalMatched: true,
				},
			},
			{ acceptedLogs: [] },
		);
		expect(accepted.state.stage).toBe("blocked");
		expect(accepted.state.block?.questionId).toBe(result.state.block?.questionId);
	});

	test("stale test or diff evidence during verify resumes at build", () => {
		const state = recordBuildEvidence(startBuild(approvedState()).state, {
			commit: "commit-a",
			diff: "diff",
			testFiles: ["test/loop.test.ts"],
			testHashes,
			redRun: run({ log: "/tmp/red.log", exitCode: 1, commit: "tests-only" }),
			greenRun: run({ log: "/tmp/green.log", exitCode: 0 }),
			maxVerifierRerunMs: 120_000,
		}).state;
		const blocked = blockForStaleState(state, {
			...context,
			testHashes: [{ file: "test/loop.test.ts", sha256: "changed" }],
		}).state;
		expect(blocked.stage).toBe("blocked");
		expect(blocked.block).toMatchObject({ kind: "stale", resumeStage: "build" });
	});

	test("stale reasons are structured and not inferred from message text", () => {
		const state = recordBuildEvidence(startBuild(approvedState()).state, {
			commit: "commit-a",
			diff: "diff",
			testFiles: ["test/loop.test.ts"],
			testHashes,
			redRun: run({ log: "/tmp/red.log", exitCode: 1, commit: "tests-only" }),
			greenRun: run({ log: "/tmp/green.log", exitCode: 0 }),
			maxVerifierRerunMs: 120_000,
		}).state;
		expect(staleReason(state, { ...context, testHashes: [{ file: "test/loop.test.ts", sha256: "changed" }] })).toMatchObject({
			kind: "test-hashes",
		});
		expect(staleReason(state, { ...context, testHashes, diffHash: "changed" })).toMatchObject({ kind: "diff" });
	});

	test("exports the verifier task builder for isolated verifier dispatch", () => {
		expect(verifierTask).toBeTypeOf("function");
	});
});
