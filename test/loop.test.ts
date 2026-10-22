import { describe, expect, test } from "vitest";
import type { HelperReport } from "../extensions/helper-report.ts";
import {
	advisorKey,
	answerLoopQuestion,
	applyAdvisorReport,
	applyLeadPlan,
	approveBrief,
	blockForStaleState,
	briefHash,
	buildBrief,
	createLoopState,
	nextLoopEffects,
	staleReason,
	startLoop,
	validateLoopState,
} from "../extensions/loop.ts";

const context = { worktree: "/repo", branch: "main", baseHead: "base-a" };

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

		state = applyAdvisorReport(state, report("intent"), { tokenCount: 111 }).state;
		expect(nextLoopEffects(state)).toEqual([]);

		state = applyAdvisorReport(state, report("codebase"), { tokenCount: 222 }).state;
		expect(nextLoopEffects(state)).toMatchObject([{ type: "dispatch-advisors", roles: ["test-design"] }]);

		state = applyAdvisorReport(
			state,
			report("test-design", {
				status: "needs-input",
				openQuestions: ["Should the CLI command be /loop start?"],
			}),
			{ tokenCount: 333 },
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

	test("groups several ready questions into one person question", () => {
		let state = createLoopState({ ...context, goal: "Add the loop runner.", limits: [], done: [] });
		state = applyAdvisorReport(
			state,
			report("intent", {
				openQuestions: ["Which command starts the graph?"],
				details: {
					questions: [
						{
							id: "q1",
							text: "Should the runner ask before build?",
							recommended: "Yes, ask before build.",
							dependsOn: [],
						},
					],
					doneCandidates: [],
					ambiguities: [],
				},
			}),
			{ tokenCount: 1 },
		).state;
		state = applyAdvisorReport(state, report("codebase", { openQuestions: ["Should state live in the profile?"] }), {
			tokenCount: 2,
		}).state;
		expect(state.stage).toBe("needs-person");
		expect(state.questions).toHaveLength(1);
		expect(state.questions[0]?.text).toContain("Should the runner ask before build?");
		expect(state.questions[0]?.text).toContain("Which command starts the graph?");
		expect(state.questions[0]?.text).toContain("Should state live in the profile?");
	});

	test("moves from completed advisors to lead plan, architecture review, and explicit brief approval", () => {
		let state = createLoopState({ ...context, goal: "Add the loop runner.", limits: [], done: [] });
		state = applyAdvisorReport(state, report("intent"), { tokenCount: 1 }).state;
		state = applyAdvisorReport(state, report("codebase"), { tokenCount: 2 }).state;
		state = applyAdvisorReport(state, report("test-design"), { tokenCount: 3 }).state;
		expect(state.stage).toBe("plan");
		expect(nextLoopEffects(state)).toMatchObject([{ type: "write-lead-plan" }]);

		const planned = applyLeadPlan(state, "Keep Pi wiring thin and transition logic pure.");
		state = planned.state;
		expect(state.stage).toBe("architecture-review");
		expect(planned.effects).toMatchObject([{ type: "dispatch-advisors", roles: ["architecture"] }]);

		state = applyAdvisorReport(state, report("architecture"), { tokenCount: 4 }).state;
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
		state = applyAdvisorReport(state, report("intent"), { tokenCount: 1 }).state;
		state = applyAdvisorReport(state, report("codebase"), { tokenCount: 2 }).state;
		state = applyAdvisorReport(state, report("test-design"), { tokenCount: 3 }).state;
		state = applyLeadPlan(state, "Plan").state;
		state = applyAdvisorReport(
			state,
			report("architecture", { status: "blocked", openQuestions: ["Is the private checklist readable?"] }),
			{ tokenCount: 4 },
		).state;
		expect(state.stage).toBe("needs-person");
		expect(state.questions).toHaveLength(1);
	});

	test("a blocked architecture report with no open question still asks the person", () => {
		let state = createLoopState({ ...context, goal: "Add the loop runner.", limits: [], done: [] });
		state = applyAdvisorReport(state, report("intent"), { tokenCount: 1 }).state;
		state = applyAdvisorReport(state, report("codebase"), { tokenCount: 2 }).state;
		state = applyAdvisorReport(state, report("test-design"), { tokenCount: 3 }).state;
		state = applyLeadPlan(state, "Plan").state;
		state = applyAdvisorReport(state, report("architecture", { status: "blocked", summary: "Checklist unreadable." }), {
			tokenCount: 4,
		}).state;
		expect(state.stage).toBe("needs-person");
		expect(state.questions[0]?.text).toContain("Checklist unreadable.");
	});

	test("rejects reports outside the active stage or from undispatched advisors", () => {
		let state = createLoopState({ ...context, goal: "Add the loop runner.", limits: [], done: [] });
		expect(() => applyAdvisorReport({ ...state, stage: "blocked" }, report("intent"), { tokenCount: 1 })).toThrow(
			/cannot apply advisor report/,
		);
		expect(() => applyAdvisorReport(state, report("test-design"), { tokenCount: 1 })).toThrow(/not dispatched/);
		state = applyAdvisorReport(state, report("intent"), { tokenCount: 1 }).state;
		expect(() => applyAdvisorReport(state, report("architecture"), { tokenCount: 1 })).toThrow(/not dispatched/);
	});
});

describe("stale state and validation", () => {
	test("blocks stale state when branch/base changes or the frozen brief hash is no longer current", () => {
		let state = createLoopState({ ...context, goal: "Add the loop runner.", limits: [], done: [] });
		expect(staleReason(state, context)).toBeUndefined();
		expect(staleReason(state, { ...context, branch: "feature" })).toContain("branch changed");
		expect(staleReason(state, { ...context, baseHead: "base-b" })).toContain("base head changed");

		state = {
			...state,
			stage: "brief-approved",
			plan: { author: "lead", text: "Original plan" },
			advisorRuns: {
				intent: { status: "done", summary: "Intent", evidence: [], openQuestions: [], assumptions: [], tokenCount: 1 },
				codebase: {
					status: "done",
					summary: "Codebase",
					evidence: [],
					openQuestions: [],
					assumptions: [],
					tokenCount: 1,
				},
				testDesign: {
					status: "done",
					summary: "Tests",
					evidence: [],
					openQuestions: [],
					assumptions: [],
					tokenCount: 1,
				},
				architecture: {
					status: "done",
					summary: "Architecture",
					evidence: [],
					openQuestions: [],
					assumptions: [],
					tokenCount: 1,
				},
			},
			frozenBriefHash: "not-current",
		};
		expect(staleReason(state, context)).toContain("frozen brief hash");
	});

	test("a freshly approved brief is not stale, and stale blocks can be left by answering", () => {
		let state = createLoopState({ ...context, goal: "Add the loop runner.", limits: [], done: [] });
		state = applyAdvisorReport(state, report("intent"), { tokenCount: 1 }).state;
		state = applyAdvisorReport(state, report("codebase"), { tokenCount: 2 }).state;
		state = applyAdvisorReport(state, report("test-design"), { tokenCount: 3 }).state;
		state = applyLeadPlan(state, "Plan").state;
		state = applyAdvisorReport(state, report("architecture"), { tokenCount: 4 }).state;
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
