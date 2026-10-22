/**
 * Pure LOOPS runner state and transition logic. Pi wiring lives in loop-pi.ts.
 */
import { createHash } from "node:crypto";
import { type Static, Type } from "typebox";
import * as Value from "typebox/value";
import type { GrimoireStoreStatus } from "./grimoire.ts";
import {
	type HelperReport,
	type HelperReportRole,
	LogDecision,
	Question,
	RerunCheck,
	ReworkClass,
	ROLE_HELPER_REPORT_SCHEMAS,
} from "./helper-report.ts";

export const ADVISOR_ROLES = ["intent", "codebase", "test-design", "architecture"] as const;
export type AdvisorRole = (typeof ADVISOR_ROLES)[number];
export type AdvisorKey = "intent" | "codebase" | "testDesign" | "architecture";
const AdvisorRoleSchema = Type.Union([
	Type.Literal("intent"),
	Type.Literal("codebase"),
	Type.Literal("test-design"),
	Type.Literal("architecture"),
]);

export const LOOP_STAGES = [
	"advise",
	"needs-person",
	"plan",
	"architecture-review",
	"brief-approved",
	"build",
	"verify",
	"classify",
	"blocked",
	"done",
] as const;
export type LoopStage = (typeof LOOP_STAGES)[number];
const LoopStageSchema = Type.Union([
	Type.Literal("advise"),
	Type.Literal("needs-person"),
	Type.Literal("plan"),
	Type.Literal("architecture-review"),
	Type.Literal("brief-approved"),
	Type.Literal("build"),
	Type.Literal("verify"),
	Type.Literal("classify"),
	Type.Literal("blocked"),
	Type.Literal("done"),
]);

const Approval = Type.Object(
	{
		approvedBy: Type.String({ minLength: 1 }),
		approvedAt: Type.String({ minLength: 1 }),
		summary: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const AdvisorRun = Type.Object(
	{
		status: Type.Union([Type.Literal("done"), Type.Literal("blocked"), Type.Literal("needs-input")]),
		summary: Type.String(),
		evidence: Type.Array(Type.String()),
		openQuestions: Type.Array(Question),
		assumptions: Type.Array(Type.String()),
		tokenCount: Type.Number(),
	},
	{ additionalProperties: false },
);

const BuildState = Type.Object(
	{
		commit: Type.Optional(Type.String()),
		testFiles: Type.Array(Type.String()),
		testHashes: Type.Array(
			Type.Object({ file: Type.String(), sha256: Type.String() }, { additionalProperties: false }),
		),
		redRunLog: Type.Optional(Type.String()),
		greenRunLog: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const ReworkEntry = Type.Object(
	{
		class: ReworkClass,
		evidence: Type.Array(Type.String()),
		proposalPath: Type.Optional(Type.String()),
		overriddenBy: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const AdvisorRuns = Type.Object(
	{
		intent: Type.Optional(AdvisorRun),
		codebase: Type.Optional(AdvisorRun),
		testDesign: Type.Optional(AdvisorRun),
		architecture: Type.Optional(AdvisorRun),
	},
	{ additionalProperties: false },
);

export const STALE_STATE_QUESTION_ID = "stale-state";

export const LOOP_BRIEF_SCHEMA = Type.Object(
	{
		version: Type.Literal(1),
		goal: Type.String(),
		limits: Type.Array(Type.String()),
		done: Type.Array(Type.String()),
		questions: Type.Array(Question),
		advisorRuns: AdvisorRuns,
		plan: Type.Optional(
			Type.Object({ author: Type.Literal("lead"), text: Type.String() }, { additionalProperties: false }),
		),
		approval: Type.Optional(Approval),
	},
	{ additionalProperties: false },
);

export const LOOP_STATE_SCHEMA = Type.Object(
	{
		version: Type.Literal(1),
		worktree: Type.String(),
		branch: Type.String(),
		baseRef: Type.String(),
		baseHead: Type.String(),
		stage: LoopStageSchema,
		blockedFrom: Type.Optional(LoopStageSchema),
		goal: Type.String(),
		limits: Type.Array(Type.String()),
		done: Type.Array(Type.String()),
		questions: Type.Array(Question),
		dispatchedAdvisors: Type.Array(AdvisorRoleSchema),
		advisorRuns: AdvisorRuns,
		plan: Type.Optional(
			Type.Object({ author: Type.Literal("lead"), text: Type.String() }, { additionalProperties: false }),
		),
		approval: Type.Optional(Approval),
		frozenBriefHash: Type.Optional(Type.String()),
		build: BuildState,
		verification: Type.Optional(
			Type.Object(
				{
					status: Type.Union([Type.Literal("passed"), Type.Literal("missed"), Type.Literal("blocked")]),
					runLogs: Type.Array(Type.String()),
					rerunChecks: Type.Array(RerunCheck),
					acceptedLogs: Type.Array(LogDecision),
					summary: Type.String(),
				},
				{ additionalProperties: false },
			),
		),
		rework: Type.Array(ReworkEntry),
	},
	{ additionalProperties: false },
);

export type LoopQuestion = Static<typeof Question>;
export type Approval = Static<typeof Approval>;
export type AdvisorRun = Static<typeof AdvisorRun>;
export type LoopState = Static<typeof LOOP_STATE_SCHEMA>;
export type LoopBrief = Static<typeof LOOP_BRIEF_SCHEMA>;

export interface AdvisorDispatch {
	role: AdvisorRole;
	task: string;
}

export type LoopEffect =
	| { type: "dispatch-advisors"; roles: AdvisorRole[]; advisors: AdvisorDispatch[] }
	| { type: "ask-person"; reason: string; question: LoopQuestion }
	| { type: "write-lead-plan"; brief: LoopBrief }
	| { type: "brief-approved"; brief: LoopBrief };

export function advisorKey(role: AdvisorRole | HelperReportRole): AdvisorKey {
	if (role === "test-design") return "testDesign";
	if (role === "verifier") throw new Error("verifier reports are out of scope for slice one");
	return role;
}

export function roleForAgent(agent: unknown): AdvisorRole | undefined {
	if (agent === "intent-advisor") return "intent";
	if (agent === "codebase-advisor") return "codebase";
	if (agent === "test-design-advisor") return "test-design";
	if (agent === "architecture-advisor") return "architecture";
	return undefined;
}

function schemaError(schema: typeof LOOP_STATE_SCHEMA | typeof LOOP_BRIEF_SCHEMA, input: unknown): string {
	const [first] = Value.Errors(schema, input);
	const where = first?.instancePath ? `${first.instancePath}: ` : "";
	return `${where}${first?.message ?? "does not match schema"}`;
}

export function validateLoopState(input: unknown): { ok: true; state: LoopState } | { ok: false; reason: string } {
	if (!Value.Check(LOOP_STATE_SCHEMA, input)) return { ok: false, reason: schemaError(LOOP_STATE_SCHEMA, input) };
	return { ok: true, state: input as LoopState };
}

export function createLoopState(input: {
	worktree: string;
	branch: string;
	baseRef?: string;
	baseHead: string;
	goal: string;
	limits: string[];
	done: string[];
}): LoopState {
	return {
		version: 1,
		worktree: input.worktree,
		branch: input.branch,
		baseRef: input.baseRef ?? "main",
		baseHead: input.baseHead,
		stage: "advise",
		goal: input.goal,
		limits: input.limits,
		done: input.done,
		questions: [],
		dispatchedAdvisors: ["intent", "codebase"],
		advisorRuns: {},
		build: { testFiles: [], testHashes: [] },
		rework: [],
	};
}

export function buildBrief(state: LoopState): LoopBrief {
	const brief: LoopBrief = {
		version: 1,
		goal: state.goal,
		limits: state.limits,
		done: state.done,
		questions: state.questions.filter((question) => question.id !== STALE_STATE_QUESTION_ID),
		advisorRuns: state.advisorRuns,
	};
	if (state.plan) brief.plan = state.plan;
	if (state.approval) brief.approval = state.approval;
	return brief;
}

export function briefHash(brief: LoopBrief): string {
	return createHash("sha256").update(JSON.stringify(brief)).digest("hex");
}

function list(items: string[]): string {
	return items.length ? items.map((item) => `- ${item}`).join("\n") : "- (none)";
}

function answers(state: LoopState): string {
	const answered = state.questions.filter((question) => question.answer);
	return answered.length
		? answered.map((question) => `- ${question.text}\n  Answer: ${question.answer}`).join("\n")
		: "- (none)";
}

export function advisorTask(state: LoopState, role: AdvisorRole): string {
	const base = [
		`Goal: ${state.goal}`,
		"Limits:",
		list(state.limits),
		"Done lines:",
		list(state.done),
		"Answers so far:",
		answers(state),
	];
	if (role === "intent") return [...base, "Current questions:", list(state.questions.map((q) => q.text))].join("\n");
	if (role === "codebase") return [...base, "Find repository facts, files, tests, boundaries and owners."].join("\n");
	if (role === "test-design") {
		return [
			...base,
			"Intent report:",
			JSON.stringify(state.advisorRuns.intent, null, "\t"),
			"Codebase report:",
			JSON.stringify(state.advisorRuns.codebase, null, "\t"),
		].join("\n");
	}
	return [
		...base,
		"Frozen advisor brief:",
		JSON.stringify(buildBrief(state), null, "\t"),
		"Lead plan:",
		state.plan?.text ?? "",
	].join("\n");
}

function dispatch(state: LoopState, roles: AdvisorRole[]): { state: LoopState; effects: LoopEffect[] } {
	return {
		state: { ...state, dispatchedAdvisors: roles },
		effects: [
			{ type: "dispatch-advisors", roles, advisors: roles.map((role) => ({ role, task: advisorTask(state, role) })) },
		],
	};
}

export function tokenCountFromSubagentResult(details: Record<string, unknown>): number | undefined {
	const output = details.outputTokens;
	const context = details.contextTokens;
	return typeof output === "number" && typeof context === "number" ? output + context : undefined;
}

function groupedQuestion(id: string, reason: string, questions: LoopQuestion[]): LoopQuestion {
	const body = questions
		.map((question, index) => `${index + 1}. ${question.text}\nRecommended: ${question.recommended}`)
		.join("\n\n");
	return {
		id,
		text: body || reason,
		recommended: "Answer every item in one reply so the runner can continue.",
		dependsOn: questions.map((question) => question.id),
	};
}

function grimoireQuestion(status: Extract<GrimoireStoreStatus, { state: "unreadable" }>): LoopQuestion {
	return {
		id: "grimoire-unreadable",
		text: `The Grimoire at ${status.dir} is unreadable: ${status.reason}. Should the loop continue without it after you fix or acknowledge this?`,
		recommended: "Fix the Grimoire path or say to continue without approved knowledge for this graph.",
		dependsOn: [],
	};
}

export function startLoop(input: {
	worktree: string;
	branch: string;
	baseRef?: string;
	baseHead: string;
	goal: string;
	limits: string[];
	done: string[];
	grimoire: GrimoireStoreStatus;
}): { state: LoopState; effects: LoopEffect[] } {
	const state = createLoopState(input);
	if (input.grimoire.state === "unreadable") {
		const question = grimoireQuestion(input.grimoire);
		return {
			state: { ...state, stage: "blocked", questions: [question], dispatchedAdvisors: [] },
			effects: [{ type: "ask-person", reason: "grimoire-unreadable", question }],
		};
	}
	return dispatch(state, ["intent", "codebase"]);
}

function reportQuestions(role: HelperReportRole, report: HelperReport): LoopQuestion[] {
	const out: LoopQuestion[] = [];
	if (role === "intent") {
		const details = report.details as { questions?: LoopQuestion[] };
		for (const question of details.questions ?? []) out.push(question);
	}
	for (const [index, text] of report.openQuestions.entries()) {
		if (out.some((question) => question.text === text)) continue;
		out.push({
			id: `${role}-open-${index + 1}`,
			text,
			recommended: "Use the report's recommended answer if one was supplied; otherwise answer directly.",
			dependsOn: [],
		});
	}
	if (report.status === "blocked" && out.length === 0) {
		out.push({
			id: `${role}-blocked`,
			text: report.summary,
			recommended: "Resolve the blocker or say how to proceed.",
			dependsOn: [],
		});
	}
	return out;
}

function toAdvisorRun(role: HelperReportRole, report: HelperReport, tokenCount: number): AdvisorRun {
	const schema = ROLE_HELPER_REPORT_SCHEMAS[role];
	if (!Value.Check(schema, report)) {
		const [first] = Value.Errors(schema, report);
		const where = first?.instancePath ? `${first.instancePath}: ` : "";
		throw new Error(`invalid ${role} helper_report: ${where}${first?.message ?? "report does not match schema"}`);
	}
	const run: AdvisorRun = {
		status: report.status,
		summary: report.summary,
		evidence: report.evidence,
		openQuestions: reportQuestions(role, report),
		assumptions: report.assumptions,
		tokenCount,
	};
	return run;
}

function adviseEffects(state: LoopState): { state: LoopState; effects: LoopEffect[] } {
	const { intent, codebase, testDesign } = state.advisorRuns;
	if (intent && codebase) {
		if (state.dispatchedAdvisors.some((role) => role === "intent" || role === "codebase"))
			return { state, effects: [] };
		const earlyQuestions = [...intent.openQuestions, ...codebase.openQuestions];
		if (earlyQuestions.length > 0) {
			const question = groupedQuestion("advisor-questions", "Advisor questions need an answer.", earlyQuestions);
			const next = { ...state, stage: "needs-person" as const, questions: [question], dispatchedAdvisors: [] };
			return { state: next, effects: [{ type: "ask-person", reason: "advisor-questions", question }] };
		}
		if (!testDesign) return dispatch(state, ["test-design"]);
		if (state.dispatchedAdvisors.includes("test-design")) return { state, effects: [] };
		const allQuestions = [...testDesign.openQuestions];
		if (allQuestions.length > 0) {
			const question = groupedQuestion("advisor-questions", "Advisor questions need an answer.", allQuestions);
			const next = { ...state, stage: "needs-person" as const, questions: [question], dispatchedAdvisors: [] };
			return { state: next, effects: [{ type: "ask-person", reason: "advisor-questions", question }] };
		}
		const next = { ...state, stage: "plan" as const, dispatchedAdvisors: [] };
		return { state: next, effects: [{ type: "write-lead-plan", brief: buildBrief(next) }] };
	}
	if (!intent && !codebase) return dispatch(state, ["intent", "codebase"]);
	return { state, effects: [] };
}

function architectureEffects(state: LoopState): { state: LoopState; effects: LoopEffect[] } {
	const run = state.advisorRuns.architecture;
	if (!run && !state.dispatchedAdvisors.includes("architecture")) return dispatch(state, ["architecture"]);
	if (!run) return { state, effects: [] };
	if (state.dispatchedAdvisors.includes("architecture")) return { state, effects: [] };
	if (run.openQuestions.length > 0 || run.status === "blocked") {
		const question = groupedQuestion(
			"architecture-questions",
			"Architecture questions need an answer.",
			run.openQuestions,
		);
		const next = { ...state, stage: "needs-person" as const, questions: [question], dispatchedAdvisors: [] };
		return { state: next, effects: [{ type: "ask-person", reason: "architecture-questions", question }] };
	}
	const question: LoopQuestion = {
		id: "brief-approval",
		text: "Architecture review is ready. Approve the frozen brief before build starts?",
		recommended: "Run /loop approve <summary> if the plan and brief are approved.",
		dependsOn: [],
	};
	return { state, effects: [{ type: "ask-person", reason: "brief-approval", question }] };
}

export function nextLoopEffects(state: LoopState): LoopEffect[] {
	if (state.stage === "advise") return adviseEffects(state).effects;
	if (state.stage === "plan") return [{ type: "write-lead-plan", brief: buildBrief(state) }];
	if (state.stage === "architecture-review") return architectureEffects(state).effects;
	if (state.stage === "brief-approved") return [{ type: "brief-approved", brief: buildBrief(state) }];
	return [];
}

export function applyAdvisorReport(
	state: LoopState,
	report: HelperReport,
	options: { tokenCount: number },
): { state: LoopState; effects: LoopEffect[] } {
	if (state.stage !== "advise" && state.stage !== "architecture-review")
		throw new Error(`cannot apply advisor report while stage is ${state.stage}`);
	if (!report.role) throw new Error("advisor report is missing role");
	if (report.role === "verifier") throw new Error("verifier reports are out of scope for slice one");
	if (!state.dispatchedAdvisors.includes(report.role)) throw new Error(`${report.role} advisor is not dispatched`);
	const key = advisorKey(report.role);
	const next: LoopState = {
		...state,
		dispatchedAdvisors: state.dispatchedAdvisors.filter((role) => role !== report.role),
		advisorRuns: { ...state.advisorRuns, [key]: toAdvisorRun(report.role, report, options.tokenCount) },
	};
	if (state.stage === "architecture-review") return architectureEffects(next);
	return adviseEffects(next);
}

export function affectedAdvisors(state: LoopState): AdvisorRole[] {
	if (state.advisorRuns.architecture?.openQuestions.length || (state.stage === "blocked" && state.plan))
		return ["architecture"];
	const roles: AdvisorRole[] = [];
	if (state.advisorRuns.intent?.openQuestions.length) roles.push("intent");
	if (state.advisorRuns.codebase?.openQuestions.length) roles.push("codebase");
	if (state.advisorRuns.testDesign?.openQuestions.length) roles.push("test-design");
	if (roles.length > 0) return roles;
	if (state.advisorRuns.testDesign) return ["test-design"];
	return ["intent", "codebase"];
}

export function answerLoopQuestion(
	state: LoopState,
	input: { answer: string; current: { branch: string; baseHead: string } },
): { state: LoopState; effects: LoopEffect[] } {
	if (state.stage !== "needs-person" && state.stage !== "blocked")
		throw new Error(`cannot answer while stage is ${state.stage}`);
	const answered = state.questions.map((question) => ({ ...question, answer: input.answer }));
	const isStaleAnswer = state.questions.some((question) => question.id === STALE_STATE_QUESTION_ID);
	if (isStaleAnswer) {
		const nextStage = state.blockedFrom ?? "advise";
		const updated: LoopState = {
			...state,
			stage: nextStage,
			blockedFrom: undefined,
			branch: input.current.branch,
			baseHead: input.current.baseHead,
			questions: answered,
			dispatchedAdvisors: [],
		};
		const next = state.frozenBriefHash ? { ...updated, frozenBriefHash: briefHash(buildBrief(updated)) } : updated;
		return { state: next, effects: nextLoopEffects(next) };
	}
	const roles = affectedAdvisors(state);
	const advisorRuns = { ...state.advisorRuns };
	for (const role of roles) delete advisorRuns[advisorKey(role)];
	const architectureAffected = roles.includes("architecture");
	const next: LoopState = {
		...state,
		stage: architectureAffected ? "architecture-review" : "advise",
		questions: answered,
		advisorRuns,
		dispatchedAdvisors: [],
	};
	return roles.length ? dispatch(next, roles) : { state: next, effects: nextLoopEffects(next) };
}

export function applyLeadPlan(state: LoopState, text: string): { state: LoopState; effects: LoopEffect[] } {
	if (state.stage !== "plan") throw new Error(`cannot apply a lead plan while stage is ${state.stage}`);
	const next: LoopState = {
		...state,
		stage: "architecture-review",
		plan: { author: "lead", text },
		dispatchedAdvisors: [],
	};
	return dispatch(next, ["architecture"]);
}

export function approveBrief(state: LoopState, approval: Approval): { state: LoopState; effects: LoopEffect[] } {
	if (state.stage !== "architecture-review") throw new Error(`cannot approve a brief while stage is ${state.stage}`);
	const approved: LoopState = { ...state, stage: "brief-approved", approval };
	const frozenBriefHash = briefHash(buildBrief(approved));
	const next = { ...approved, frozenBriefHash };
	return { state: next, effects: [{ type: "brief-approved", brief: buildBrief(next) }] };
}

export function staleReason(state: LoopState, current: { branch: string; baseHead: string }): string | undefined {
	if (state.branch !== current.branch) return `branch changed from ${state.branch} to ${current.branch}`;
	if (state.baseHead !== current.baseHead) return `base head changed from ${state.baseHead} to ${current.baseHead}`;
	if (state.frozenBriefHash && state.frozenBriefHash !== briefHash(buildBrief(state))) {
		return "frozen brief hash is not current";
	}
	return undefined;
}

export function blockForStaleState(
	state: LoopState,
	current: { branch: string; baseHead: string },
): { state: LoopState; effects: LoopEffect[] } {
	const reason = staleReason(state, current);
	if (!reason) return { state, effects: [] };
	const question: LoopQuestion = {
		id: STALE_STATE_QUESTION_ID,
		text: `The loop state is stale: ${reason}. Should this graph continue from the current branch and base head?`,
		recommended: "Answer how to proceed before the runner dispatches more work.",
		dependsOn: [],
	};
	const blocked: LoopState = {
		...state,
		stage: "blocked",
		blockedFrom: state.stage,
		questions: [question],
		dispatchedAdvisors: [],
	};
	return { state: blocked, effects: [{ type: "ask-person", reason: "stale-state", question }] };
}
