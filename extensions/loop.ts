/**
 * Pure LOOPS runner state and transition logic. Pi wiring lives in loop-pi.ts.
 */
import { createHash } from "node:crypto";
import { Type } from "typebox";
import * as Value from "typebox/value";
import type { GrimoireStoreStatus } from "./grimoire.ts";
import type { HelperReport, HelperReportRole, HelperReportStatus } from "./helper-report.ts";

export const ADVISOR_ROLES = ["intent", "codebase", "test-design", "architecture"] as const;
export type AdvisorRole = (typeof ADVISOR_ROLES)[number];
export type AdvisorKey = "intent" | "codebase" | "testDesign" | "architecture";

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

const Question = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		text: Type.String({ minLength: 1 }),
		recommended: Type.String({ minLength: 1 }),
		dependsOn: Type.Array(Type.String()),
		answer: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

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
		tokenCount: Type.Optional(Type.Number()),
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

const ReworkClass = Type.Union([
	Type.Literal("context-missed"),
	Type.Literal("context-missing"),
	Type.Literal("wrong-intent"),
	Type.Literal("new-information"),
	Type.Literal("execution-slip"),
	Type.Literal("check-gap"),
]);

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
		baseHead: Type.String(),
		stage: Type.Union(LOOP_STAGES.map((stage) => Type.Literal(stage))),
		goal: Type.String(),
		limits: Type.Array(Type.String()),
		done: Type.Array(Type.String()),
		questions: Type.Array(Question),
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
					rerunChecks: Type.Array(
						Type.Object(
							{ command: Type.String(), log: Type.String(), reason: Type.String() },
							{ additionalProperties: false },
						),
					),
					acceptedLogs: Type.Array(
						Type.Object({ log: Type.String(), reason: Type.String() }, { additionalProperties: false }),
					),
					summary: Type.String(),
				},
				{ additionalProperties: false },
			),
		),
		rework: Type.Array(ReworkEntry),
	},
	{ additionalProperties: false },
);

export interface LoopQuestion {
	id: string;
	text: string;
	recommended: string;
	dependsOn: string[];
	answer?: string;
}

export interface Approval {
	approvedBy: string;
	approvedAt: string;
	summary: string;
}

export interface AdvisorRun {
	status: HelperReportStatus;
	summary: string;
	evidence: string[];
	openQuestions: LoopQuestion[];
	assumptions: string[];
	tokenCount?: number;
}

export interface LoopState {
	version: 1;
	worktree: string;
	branch: string;
	baseHead: string;
	stage: LoopStage;
	goal: string;
	limits: string[];
	done: string[];
	questions: LoopQuestion[];
	advisorRuns: Partial<Record<AdvisorKey, AdvisorRun>>;
	plan?: { author: "lead"; text: string };
	approval?: Approval;
	frozenBriefHash?: string;
	build: {
		commit?: string;
		testFiles: string[];
		testHashes: { file: string; sha256: string }[];
		redRunLog?: string;
		greenRunLog?: string;
	};
	verification?: {
		status: "passed" | "missed" | "blocked";
		runLogs: string[];
		rerunChecks: { command: string; log: string; reason: string }[];
		acceptedLogs: { log: string; reason: string }[];
		summary: string;
	};
	rework: {
		class: "context-missed" | "context-missing" | "wrong-intent" | "new-information" | "execution-slip" | "check-gap";
		evidence: string[];
		proposalPath?: string;
		overriddenBy?: string;
	}[];
}

export type LoopBrief = {
	version: 1;
	goal: string;
	limits: string[];
	done: string[];
	questions: LoopQuestion[];
	advisorRuns: Partial<Record<AdvisorKey, AdvisorRun>>;
	plan?: { author: "lead"; text: string };
	approval?: Approval;
};

export type LoopEffect =
	| { type: "dispatch-advisors"; roles: AdvisorRole[] }
	| { type: "ask-person"; reason: string; question: LoopQuestion }
	| { type: "write-lead-plan"; brief: LoopBrief }
	| { type: "brief-approved"; brief: LoopBrief };

export function advisorKey(role: AdvisorRole | HelperReportRole): AdvisorKey {
	if (role === "test-design") return "testDesign";
	if (role === "verifier") throw new Error("verifier reports are out of scope for slice one");
	return role;
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

export function validateLoopBrief(input: unknown): { ok: true; brief: LoopBrief } | { ok: false; reason: string } {
	if (!Value.Check(LOOP_BRIEF_SCHEMA, input)) return { ok: false, reason: schemaError(LOOP_BRIEF_SCHEMA, input) };
	return { ok: true, brief: input as LoopBrief };
}

export function createLoopState(input: {
	worktree: string;
	branch: string;
	baseHead: string;
	goal: string;
	limits: string[];
	done: string[];
}): LoopState {
	return {
		version: 1,
		worktree: input.worktree,
		branch: input.branch,
		baseHead: input.baseHead,
		stage: "advise",
		goal: input.goal,
		limits: input.limits,
		done: input.done,
		questions: [],
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
		questions: state.questions,
		advisorRuns: state.advisorRuns,
	};
	if (state.plan) brief.plan = state.plan;
	if (state.approval) brief.approval = state.approval;
	return brief;
}

export function briefHash(brief: LoopBrief): string {
	return createHash("sha256").update(JSON.stringify(brief)).digest("hex");
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
			state: { ...state, stage: "blocked", questions: [question] },
			effects: [{ type: "ask-person", reason: "grimoire-unreadable", question }],
		};
	}
	return { state, effects: [{ type: "dispatch-advisors", roles: ["intent", "codebase"] }] };
}

function reportQuestions(role: HelperReportRole, report: HelperReport): LoopQuestion[] {
	const out: LoopQuestion[] = [];
	const details = report.details;
	if (
		role === "intent" &&
		details &&
		typeof details === "object" &&
		Array.isArray((details as { questions?: unknown }).questions)
	) {
		for (const item of (details as { questions: unknown[] }).questions) {
			if (!item || typeof item !== "object") continue;
			const q = item as { id?: unknown; text?: unknown; recommended?: unknown; dependsOn?: unknown };
			if (
				typeof q.id === "string" &&
				typeof q.text === "string" &&
				typeof q.recommended === "string" &&
				Array.isArray(q.dependsOn)
			) {
				out.push({
					id: q.id,
					text: q.text,
					recommended: q.recommended,
					dependsOn: q.dependsOn.filter((v): v is string => typeof v === "string"),
				});
			}
		}
	}
	for (const [index, text] of report.openQuestions.entries()) {
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

function toAdvisorRun(role: HelperReportRole, report: HelperReport, tokenCount?: number): AdvisorRun {
	const run: AdvisorRun = {
		status: report.status,
		summary: report.summary,
		evidence: report.evidence,
		openQuestions: reportQuestions(role, report),
		assumptions: report.assumptions,
	};
	if (tokenCount !== undefined) run.tokenCount = tokenCount;
	return run;
}

function adviseEffects(state: LoopState): { state: LoopState; effects: LoopEffect[] } {
	const { intent, codebase, testDesign } = state.advisorRuns;
	if (intent && codebase) {
		const earlyQuestions = [...intent.openQuestions, ...codebase.openQuestions];
		if (earlyQuestions.length > 0) {
			const question = groupedQuestion("advisor-questions", "Advisor questions need an answer.", earlyQuestions);
			const next = { ...state, stage: "needs-person" as const, questions: [question] };
			return { state: next, effects: [{ type: "ask-person", reason: "advisor-questions", question }] };
		}
		if (!testDesign) return { state, effects: [{ type: "dispatch-advisors", roles: ["test-design"] }] };
		const allQuestions = [...testDesign.openQuestions];
		if (allQuestions.length > 0) {
			const question = groupedQuestion("advisor-questions", "Advisor questions need an answer.", allQuestions);
			const next = { ...state, stage: "needs-person" as const, questions: [question] };
			return { state: next, effects: [{ type: "ask-person", reason: "advisor-questions", question }] };
		}
		const next = { ...state, stage: "plan" as const, questions: [] };
		return { state: next, effects: [{ type: "write-lead-plan", brief: buildBrief(next) }] };
	}
	if (!intent && !codebase) return { state, effects: [{ type: "dispatch-advisors", roles: ["intent", "codebase"] }] };
	return { state, effects: [] };
}

function architectureEffects(state: LoopState): { state: LoopState; effects: LoopEffect[] } {
	const run = state.advisorRuns.architecture;
	if (!run) return { state, effects: [{ type: "dispatch-advisors", roles: ["architecture"] }] };
	if (run.openQuestions.length > 0 || run.status === "blocked") {
		const question = groupedQuestion(
			"architecture-questions",
			"Architecture questions need an answer.",
			run.openQuestions,
		);
		const next = { ...state, stage: "needs-person" as const, questions: [question] };
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
	options: { tokenCount?: number } = {},
): { state: LoopState; effects: LoopEffect[] } {
	if (!report.role) throw new Error("advisor report is missing role");
	if (report.role === "verifier") throw new Error("verifier reports are out of scope for slice one");
	const key = advisorKey(report.role);
	const next: LoopState = {
		...state,
		advisorRuns: { ...state.advisorRuns, [key]: toAdvisorRun(report.role, report, options.tokenCount) },
	};
	if (state.stage === "architecture-review") return architectureEffects(next);
	return adviseEffects(next);
}

export function applyPersonAnswer(
	state: LoopState,
	input: { answer: string; affectedAdvisors: AdvisorRole[] },
): { state: LoopState; effects: LoopEffect[] } {
	if (state.stage !== "needs-person" && state.stage !== "blocked")
		throw new Error(`cannot answer while stage is ${state.stage}`);
	const advisorRuns = { ...state.advisorRuns };
	for (const role of input.affectedAdvisors) delete advisorRuns[advisorKey(role)];
	const answered = state.questions.map((question) => ({ ...question, answer: input.answer }));
	const architectureAffected = input.affectedAdvisors.includes("architecture");
	const next: LoopState = {
		...state,
		stage: architectureAffected ? "architecture-review" : "advise",
		questions: answered,
		advisorRuns,
	};
	return {
		state: { ...next, questions: [] },
		effects: input.affectedAdvisors.length
			? [{ type: "dispatch-advisors", roles: input.affectedAdvisors }]
			: nextLoopEffects(next),
	};
}

export function applyLeadPlan(state: LoopState, text: string): { state: LoopState; effects: LoopEffect[] } {
	if (state.stage !== "plan") throw new Error(`cannot apply a lead plan while stage is ${state.stage}`);
	const next: LoopState = { ...state, stage: "architecture-review", plan: { author: "lead", text } };
	return { state: next, effects: [{ type: "dispatch-advisors", roles: ["architecture"] }] };
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
