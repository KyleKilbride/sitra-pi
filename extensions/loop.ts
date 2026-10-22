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

export type LoopReworkClass = Static<typeof ReworkClass>;

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
		acceptanceTestFiles: Type.Optional(Type.Array(Type.String())),
		outputTokens: Type.Optional(Type.Number()),
		contextTokens: Type.Optional(Type.Number()),
	},
	{ additionalProperties: false },
);

const TestHash = Type.Object(
	{ file: Type.String(), sha256: Type.Optional(Type.String()), missing: Type.Optional(Type.Boolean()) },
	{ additionalProperties: false },
);

const BuildState = Type.Object(
	{
		commit: Type.Optional(Type.String()),
		redCommit: Type.Optional(Type.String()),
		testFiles: Type.Array(Type.String()),
		testHashes: Type.Array(TestHash),
		redRunLog: Type.Optional(Type.String()),
		greenRunLog: Type.Optional(Type.String()),
		redRunCommand: Type.Optional(Type.String()),
		greenRunCommand: Type.Optional(Type.String()),
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

const Block = Type.Object(
	{
		kind: Type.Union([
			Type.Literal("stale"),
			Type.Literal("grimoire-unreadable"),
			Type.Literal("intake-failed"),
			Type.Literal("questions"),
			Type.Literal("git"),
			Type.Literal("new-information"),
			Type.Literal("same-rework-class"),
			Type.Literal("second-rework"),
		]),
		questionId: Type.String({ minLength: 1 }),
		resumeStage: LoopStageSchema,
		pendingAdvisors: Type.Array(AdvisorRoleSchema),
	},
	{ additionalProperties: false },
);

const VerifierRequest = Type.Object(
	{
		commit: Type.String({ minLength: 1 }),
		diffHash: Type.String({ minLength: 1 }),
		testHashes: Type.Array(TestHash),
		task: Type.String({ minLength: 1 }),
		dispatchId: Type.String({ minLength: 1 }),
		runLogs: Type.Array(Type.String()),
		maxVerifierRerunMs: Type.Number(),
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
		baseRef: Type.String(),
		baseHead: Type.String(),
		stage: LoopStageSchema,
		block: Type.Optional(Block),
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
		frozenBrief: Type.Optional(LOOP_BRIEF_SCHEMA),
		frozenBriefHash: Type.Optional(Type.String()),
		build: BuildState,
		verifierRequest: Type.Optional(VerifierRequest),
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
export type LoopTestHash = Static<typeof TestHash>;
export type StaleReasonKind = "branch-changed" | "base-moved" | "brief" | "test-hashes" | "diff" | "dirty-worktree";
export interface StaleReason {
	kind: StaleReasonKind;
	detail: string;
}

export interface LoopProposal {
	kind: "lesson";
	title: string;
	summary: string;
	body: string;
	evidence?: string;
	tags: string[];
	proposedBy: "sitra-loops";
	date: string;
}

export interface AdvisorDispatch {
	role: AdvisorRole;
	task: string;
}

export type LoopEffect =
	| { type: "dispatch-advisors"; roles: AdvisorRole[]; advisors: AdvisorDispatch[] }
	| { type: "ask-person"; reason: string; question: LoopQuestion }
	| { type: "write-lead-plan"; brief: LoopBrief }
	| { type: "brief-approved"; brief: LoopBrief }
	| { type: "dispatch-verifier"; agent: "verifier"; task: string }
	| { type: "write-grimoire-proposal"; reworkIndex: number; proposal: LoopProposal };

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
	baseRef: string;
	baseHead: string;
	goal: string;
	limits: string[];
	done: string[];
}): LoopState {
	return {
		version: 1,
		worktree: input.worktree,
		branch: input.branch,
		baseRef: input.baseRef,
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
	if (state.frozenBrief) return state.frozenBrief;
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

function sha256Text(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function briefHash(brief: LoopBrief): string {
	return sha256Text(JSON.stringify(brief));
}

export function diffHash(diff: string): string {
	return sha256Text(diff);
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

export function tokensFromSubagentResult(details: Record<string, unknown>): {
	outputTokens?: number;
	contextTokens?: number;
} {
	const output = details.outputTokens;
	const context = details.contextTokens;
	return {
		...(typeof output === "number" ? { outputTokens: output } : {}),
		...(typeof context === "number" ? { contextTokens: context } : {}),
	};
}

function recordedTokens(state: LoopState): number {
	return Object.values(state.advisorRuns).reduce(
		(sum, run) => sum + (run?.outputTokens ?? 0) + (run?.contextTokens ?? 0),
		0,
	);
}

function tokenText(tokens: number): string {
	return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

export function loopMetricsLine(state: LoopState): string {
	const firstPass = state.stage === "done" && state.rework.length === 0 ? 1 : 0;
	const context = state.rework.filter(
		(entry) => entry.class === "context-missed" || entry.class === "context-missing",
	).length;
	const intent = state.rework.filter((entry) => entry.class === "wrong-intent").length;
	const check = state.rework.filter((entry) => entry.class === "check-gap").length;
	return `loops: first-pass ${firstPass}/1 · rounds ${state.rework.length + 1} · avoidable rework context ${context} intent ${intent} check ${check} · tokens ${tokenText(recordedTokens(state))}`;
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

function pendingAdvisorsForResume(state: LoopState): AdvisorRole[] {
	if (state.dispatchedAdvisors.length > 0) return state.dispatchedAdvisors;
	if (state.stage === "advise") {
		if (!state.advisorRuns.intent) return ["intent"];
		if (!state.advisorRuns.codebase) return ["codebase"];
		if (!state.advisorRuns.testDesign) return ["test-design"];
		return [];
	}
	if (state.stage === "architecture-review" && !state.advisorRuns.architecture) return ["architecture"];
	return [];
}

function withBlock(
	state: LoopState,
	input: {
		kind: NonNullable<LoopState["block"]>["kind"];
		question: LoopQuestion;
		pendingAdvisors?: AdvisorRole[];
		resumeStage?: LoopStage;
	},
): { state: LoopState; effects: LoopEffect[] } {
	if (state.block) {
		if (state.block.questionId === input.question.id) {
			const current = state.questions.find((question) => question.id === state.block?.questionId) ?? input.question;
			return {
				state,
				effects: [{ type: "ask-person", reason: state.block.kind, question: current }],
			};
		}
		const questions = state.questions.map((question) =>
			question.id === state.block?.questionId
				? { ...question, text: `${question.text}\n\nAdditional problem: ${input.question.text}` }
				: question,
		);
		const current = questions.find((question) => question.id === state.block?.questionId) ?? input.question;
		return {
			state: { ...state, questions },
			effects: [{ type: "ask-person", reason: state.block.kind, question: current }],
		};
	}
	const resumeStage = input.resumeStage ?? state.stage;
	if (resumeStage === "blocked" || resumeStage === "needs-person") {
		throw new Error(`invalid block resumeStage ${resumeStage}`);
	}
	const blocked: LoopState = {
		...state,
		stage: "blocked",
		block: {
			kind: input.kind,
			questionId: input.question.id,
			resumeStage,
			pendingAdvisors: input.pendingAdvisors ?? pendingAdvisorsForResume(state),
		},
		questions: [...state.questions, input.question],
		dispatchedAdvisors: [],
	};
	return { state: blocked, effects: [{ type: "ask-person", reason: input.kind, question: input.question }] };
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
	baseRef: string;
	baseHead: string;
	goal: string;
	limits: string[];
	done: string[];
	grimoire: GrimoireStoreStatus;
}): { state: LoopState; effects: LoopEffect[] } {
	const state = createLoopState(input);
	if (input.grimoire.state === "unreadable") {
		const question = grimoireQuestion(input.grimoire);
		return withBlock(state, { kind: "grimoire-unreadable", question, pendingAdvisors: ["intent", "codebase"] });
	}
	return dispatch(state, ["intent", "codebase"]);
}

function reportQuestions(role: HelperReportRole, report: HelperReport): LoopQuestion[] {
	const out: LoopQuestion[] = [];
	if (role === "intent") {
		const details = report.details as { questions: LoopQuestion[] };
		for (const question of details.questions) out.push(question);
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

function toAdvisorRun(
	role: HelperReportRole,
	report: HelperReport,
	tokens: { outputTokens?: number; contextTokens?: number },
): AdvisorRun {
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
		...(role === "test-design"
			? {
					acceptanceTestFiles: (report.details as { acceptanceTests: { targetFile: string }[] }).acceptanceTests.map(
						(test) => test.targetFile,
					),
				}
			: {}),
		...tokens,
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
			return withBlock(state, { kind: "questions", question, pendingAdvisors: affectedAdvisors(state) });
		}
		if (!testDesign) return dispatch(state, ["test-design"]);
		if (state.dispatchedAdvisors.includes("test-design")) return { state, effects: [] };
		const allQuestions = [...testDesign.openQuestions];
		if (allQuestions.length > 0) {
			const question = groupedQuestion("advisor-questions", "Advisor questions need an answer.", allQuestions);
			return withBlock(state, { kind: "questions", question, pendingAdvisors: affectedAdvisors(state) });
		}
		const next = { ...state, stage: "plan" as const, dispatchedAdvisors: [] };
		return { state: next, effects: [{ type: "write-lead-plan", brief: buildBrief(next) }] };
	}
	if (intent && !codebase && state.dispatchedAdvisors.length === 0) return dispatch(state, ["codebase"]);
	if (!intent && codebase && state.dispatchedAdvisors.length === 0) return dispatch(state, ["intent"]);
	if (!intent && !codebase) return dispatch(state, ["intent", "codebase"]);
	return { state, effects: [] };
}

function architectureEffects(state: LoopState): { state: LoopState; effects: LoopEffect[] } {
	const run = state.advisorRuns.architecture;
	if (!run && !state.dispatchedAdvisors.includes("architecture")) return dispatch(state, ["architecture"]);
	if (!run) return { state, effects: [] };
	if (state.dispatchedAdvisors.includes("architecture")) return { state, effects: [] };
	if (run.openQuestions.length > 0) {
		const question = groupedQuestion(
			"architecture-questions",
			"Architecture questions need an answer.",
			run.openQuestions,
		);
		return withBlock(state, { kind: "questions", question, pendingAdvisors: ["architecture"] });
	}
	const question: LoopQuestion = {
		id: "brief-approval",
		text: "Architecture review is ready. Approve the frozen brief before build starts?",
		recommended: "Run /loop approve <summary> if the plan and brief are approved.",
		dependsOn: [],
	};
	return { state, effects: [{ type: "ask-person", reason: "brief-approval", question }] };
}

function pendingProposalIndex(state: LoopState): number | undefined {
	if (state.block) return undefined;
	const index = state.rework.findIndex((entry) => !entry.proposalPath);
	return index >= 0 ? index : undefined;
}

export function reworkProposal(state: LoopState, reworkIndex: number, date = new Date().toISOString()): LoopProposal {
	const entry = state.rework[reworkIndex];
	if (!entry) throw new Error(`rework entry ${reworkIndex} does not exist`);
	const evidence = entry.evidence.length ? entry.evidence.join("\n") : undefined;
	const summary = state.verification?.summary ?? "Verifier reported a miss.";
	return {
		kind: "lesson",
		title: `LOOPS rework: ${entry.class}`,
		summary: `When a LOOPS verifier reports ${entry.class}, use the recorded evidence before retrying.`,
		body: [
			`Rework class: ${entry.class}`,
			"",
			`Verifier summary: ${summary}`,
			"",
			"Evidence:",
			list(entry.evidence),
			"",
			"Use this proposal as a reviewable learning. It is not approved knowledge until the person accepts it with /grimoire.",
		].join("\n"),
		...(evidence ? { evidence } : {}),
		tags: ["loops", "rework", entry.class],
		proposedBy: "sitra-loops",
		date,
	};
}

function proposalEffect(state: LoopState, reworkIndex: number): LoopEffect {
	return { type: "write-grimoire-proposal", reworkIndex, proposal: reworkProposal(state, reworkIndex) };
}

export function nextLoopEffects(state: LoopState): LoopEffect[] {
	if (state.stage === "advise") return adviseEffects(state).effects;
	if (state.stage === "plan") return [{ type: "write-lead-plan", brief: buildBrief(state) }];
	if (state.stage === "architecture-review") return architectureEffects(state).effects;
	if (state.stage === "brief-approved") return [{ type: "brief-approved", brief: buildBrief(state) }];
	if (state.stage === "verify" && state.verifierRequest)
		return [{ type: "dispatch-verifier", agent: "verifier", task: state.verifierRequest.task }];
	if (state.stage === "classify") {
		const index = pendingProposalIndex(state);
		return index === undefined ? [] : [proposalEffect(state, index)];
	}
	return [];
}

export function resumeLoop(state: LoopState): { state: LoopState; effects: LoopEffect[] } {
	if (state.stage === "blocked" && state.block) {
		const question = state.questions.find((item) => item.id === state.block?.questionId);
		return {
			state,
			effects: question ? [{ type: "ask-person", reason: state.block.kind, question }] : [],
		};
	}
	if (state.stage === "advise" && state.dispatchedAdvisors.length > 0) {
		return dispatch(state, state.dispatchedAdvisors);
	}
	if (state.stage === "architecture-review" && state.dispatchedAdvisors.includes("architecture")) {
		return dispatch(state, ["architecture"]);
	}
	return { state, effects: nextLoopEffects(state) };
}

export function applyAdvisorReport(
	state: LoopState,
	report: HelperReport,
	options: { outputTokens?: number; contextTokens?: number },
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
		advisorRuns: { ...state.advisorRuns, [key]: toAdvisorRun(report.role, report, options) },
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
	const answered = state.questions.map((question) =>
		question.answer || question.id !== state.block?.questionId ? question : { ...question, answer: input.answer },
	);
	if (!state.block) throw new Error("blocked state is missing block details");
	if (state.block.kind === "stale") {
		const nextStage = state.block.resumeStage;
		const updated: LoopState = {
			...state,
			stage: nextStage,
			block: undefined,
			branch: input.current.branch,
			baseHead: input.current.baseHead,
			questions: answered,
			dispatchedAdvisors: state.block.pendingAdvisors,
			...(nextStage === "build"
				? {
						build: { testFiles: [], testHashes: [] },
						verifierRequest: undefined,
					}
				: {}),
		};
		return updated.dispatchedAdvisors.length
			? dispatch(updated, updated.dispatchedAdvisors)
			: { state: updated, effects: nextLoopEffects(updated) };
	}
	if (
		state.block.kind === "intake-failed" ||
		state.block.kind === "grimoire-unreadable" ||
		state.block.kind === "git"
	) {
		const next: LoopState = {
			...state,
			stage: state.block.resumeStage,
			block: undefined,
			questions: answered,
			dispatchedAdvisors: [],
		};
		return state.block.pendingAdvisors.length
			? dispatch(next, state.block.pendingAdvisors)
			: { state: next, effects: nextLoopEffects(next) };
	}
	if (state.block.kind === "new-information") {
		const next: LoopState = {
			...state,
			stage: state.block.resumeStage,
			block: undefined,
			questions: answered,
			dispatchedAdvisors: [],
		};
		return { state: next, effects: nextLoopEffects(next) };
	}
	if (state.block.kind === "same-rework-class" || state.block.kind === "second-rework") {
		const next: LoopState = {
			...state,
			stage: state.block.resumeStage,
			block: undefined,
			questions: answered,
			build: { testFiles: [], testHashes: [] },
			verifierRequest: undefined,
			dispatchedAdvisors: [],
		};
		return state.block.pendingAdvisors.length
			? dispatch(next, state.block.pendingAdvisors)
			: { state: next, effects: nextLoopEffects(next) };
	}
	const roles = state.block.kind === "questions" ? state.block.pendingAdvisors : affectedAdvisors(state);
	if (state.block.kind === "questions" && state.block.resumeStage === "classify") {
		const next: LoopState = { ...state, stage: state.block.resumeStage, block: undefined, questions: answered };
		return { state: next, effects: nextLoopEffects(next) };
	}
	const advisorRuns = { ...state.advisorRuns };
	for (const role of roles) delete advisorRuns[advisorKey(role)];
	const architectureAffected = roles.includes("architecture");
	const next: LoopState = {
		...state,
		stage: architectureAffected ? "architecture-review" : state.block.resumeStage,
		block: undefined,
		questions: answered,
		advisorRuns,
		dispatchedAdvisors: [],
	};
	return roles.length ? dispatch(next, roles) : { state: next, effects: nextLoopEffects(next) };
}

export function recordBlockAnswer(state: LoopState, answer: string): LoopState {
	if (!state.block) throw new Error("blocked state is missing block details");
	return {
		...state,
		questions: state.questions.map((question) =>
			question.answer || question.id !== state.block?.questionId ? question : { ...question, answer },
		),
	};
}

export function replaceBlockWithStale(
	state: LoopState,
	current: { branch: string; baseHead: string },
): { state: LoopState; effects: LoopEffect[] } {
	if (!state.block) throw new Error("blocked state is missing block details");
	const reason = staleReason(state, current);
	if (!reason) return { state, effects: [] };
	const question: LoopQuestion = {
		id: STALE_STATE_QUESTION_ID,
		text: `The loop state is stale: ${staleReasonText(reason)}. Should this graph continue from the current branch and base head?`,
		recommended: "Answer how to proceed before the runner dispatches more work.",
		dependsOn: [],
	};
	const blocked: LoopState = {
		...state,
		stage: "blocked",
		block: {
			kind: "stale",
			questionId: question.id,
			resumeStage: state.block.resumeStage,
			pendingAdvisors: state.block.pendingAdvisors,
		},
		questions: [...state.questions, question],
		dispatchedAdvisors: [],
	};
	return { state: blocked, effects: [{ type: "ask-person", reason: "stale", question }] };
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
	const frozenBrief = buildBrief(approved);
	const frozenBriefHash = briefHash(frozenBrief);
	const next = { ...approved, frozenBrief, frozenBriefHash };
	return { state: next, effects: [{ type: "brief-approved", brief: buildBrief(next) }] };
}

export function startBuild(state: LoopState): { state: LoopState; effects: LoopEffect[] } {
	if (state.stage !== "brief-approved") throw new Error(`cannot start build while stage is ${state.stage}`);
	return { state: { ...state, stage: "build", block: undefined, dispatchedAdvisors: [] }, effects: [] };
}

export function recordReworkProposal(
	state: LoopState,
	input: { reworkIndex: number; proposalPath: string },
): { state: LoopState; effects: LoopEffect[] } {
	const entry = state.rework[input.reworkIndex];
	if (!entry) throw new Error(`rework entry ${input.reworkIndex} does not exist`);
	if (entry.proposalPath) return { state, effects: nextLoopEffects(state) };
	const rework = state.rework.map((item, index) =>
		index === input.reworkIndex ? { ...item, proposalPath: input.proposalPath } : item,
	);
	const recorded: LoopState = { ...state, rework };
	if (recorded.block?.kind === "same-rework-class" || recorded.block?.kind === "second-rework") {
		const question = recorded.questions.find((item) => item.id === recorded.block?.questionId);
		return {
			state: recorded,
			effects: question ? [{ type: "ask-person", reason: recorded.block.kind, question }] : [],
		};
	}
	const next: LoopState = {
		...recorded,
		stage: "brief-approved",
		block: undefined,
		build: { testFiles: [], testHashes: [] },
		verifierRequest: undefined,
		dispatchedAdvisors: [],
	};
	return { state: next, effects: [{ type: "brief-approved", brief: buildBrief(next) }] };
}

export interface LoopRunEvidence {
	log: string;
	done: boolean;
	exitCode?: number;
	command?: string;
	loop?: { commit: string; testHashes: LoopTestHash[] };
}

function sameHashes(a: LoopTestHash[], b: LoopTestHash[]): boolean {
	if (a.some((item) => item.missing) || b.some((item) => item.missing)) return false;
	return (
		JSON.stringify([...a].sort((x, y) => x.file.localeCompare(y.file))) ===
		JSON.stringify([...b].sort((x, y) => x.file.localeCompare(y.file)))
	);
}

function runTieProblem(run: LoopRunEvidence, testHashes: LoopTestHash[]): string | undefined {
	if (!run.loop) return "it is missing run header loop metadata";
	const missing = run.loop.testHashes.find((item) => item.missing);
	if (missing) return `${missing.file} was missing when the run started`;
	if (!sameHashes(run.loop.testHashes, testHashes)) return "it is tied to different test hashes";
	return undefined;
}

function redRunProblem(
	redRun: LoopRunEvidence | undefined,
	commit: string,
	testHashes: LoopTestHash[],
): string | undefined {
	if (!redRun) return "red run is missing";
	if (!redRun.done) return "red run has not finished";
	if (redRun.exitCode === undefined || Number.isNaN(redRun.exitCode)) return "red run has no exit code";
	if (redRun.exitCode === 0) return "red run passed; it must fail before implementation";
	const tie = runTieProblem(redRun, testHashes);
	if (tie) return `red run is invalid because ${tie}`;
	if (redRun.loop?.commit === commit) return "red run must be tied to a tests-only ancestor commit, not HEAD";
	return undefined;
}

function greenRunProblem(
	greenRun: LoopRunEvidence | undefined,
	commit: string,
	testHashes: LoopTestHash[],
): string | undefined {
	if (!greenRun) return "green run is missing";
	if (!greenRun.done) return "green run has not finished";
	if (greenRun.exitCode !== 0) return `green run did not pass (exit ${greenRun.exitCode ?? "unknown"})`;
	const tie = runTieProblem(greenRun, testHashes);
	if (tie) return `green run is invalid because ${tie}`;
	if (greenRun.loop?.commit !== commit) return `green run is tied to commit ${greenRun.loop?.commit}, not ${commit}`;
	return undefined;
}

function buildBlock(state: LoopState, problem: string): { state: LoopState; effects: LoopEffect[] } {
	return withBlock(state, {
		kind: "questions",
		resumeStage: "build",
		question: {
			id: "build-evidence",
			text: `Build evidence is not ready for verification: ${problem}. Record a valid red run and green run tied to the current commit and test hashes.`,
			recommended:
				"Run the agreed test so it fails before implementation, then passes after implementation, and record both run logs.",
			dependsOn: [],
		},
	});
}

export function blockForBuildEvidenceFailure(
	state: LoopState,
	problem: string,
): { state: LoopState; effects: LoopEffect[] } {
	return buildBlock(state, problem);
}

function agreedTestProblem(state: LoopState, testFiles: string[]): string | undefined {
	if (testFiles.length === 0) return "at least one test file is required";
	const agreed = state.advisorRuns.testDesign?.acceptanceTestFiles ?? [];
	if (agreed.length === 0) return "frozen brief has no acceptance test target files";
	const got = [...testFiles].sort();
	const want = [...agreed].sort();
	if (JSON.stringify(got) !== JSON.stringify(want)) {
		return `test files ${got.join(", ")} are not in the frozen brief (${want.join(", ")})`;
	}
	return undefined;
}

export function verifierTask(input: {
	brief: LoopBrief;
	diff: string;
	commit: string;
	testHashes: LoopTestHash[];
	redRunLog: string;
	greenRunLog: string;
	redRunCommand?: string;
	greenRunCommand?: string;
	dispatchId: string;
	maxVerifierRerunMs: number;
}): string {
	return [
		"You are the independent LOOPS verifier. Start from this runner-written evidence only.",
		`maxVerifierRerunMs: ${input.maxVerifierRerunMs}`,
		`Commit: ${input.commit}`,
		`Verifier dispatchId: ${input.dispatchId ?? ""}`,
		"Set this exact dispatchId in helper_report.",
		"Frozen brief:",
		JSON.stringify(input.brief, null, "\t"),
		"Diff against baseRef:",
		input.diff,
		"Test hashes:",
		JSON.stringify(input.testHashes, null, "\t"),
		"Run logs:",
		`- redRunLog: ${input.redRunLog}`,
		...(input.redRunCommand ? [`  command: ${input.redRunCommand}`] : []),
		`- greenRunLog: ${input.greenRunLog}`,
		...(input.greenRunCommand ? [`  command: ${input.greenRunCommand}`] : []),
		"",
		"Report only with helper_report role verifier details. Record every check rerun and every log accepted with a reason. Accept a saved log only when it is tied to this exact commit and test hashes; otherwise rerun the check if it is cheap under maxVerifierRerunMs and not a full suite, or report blocked.",
	].join("\n");
}

export function recordBuildEvidence(
	state: LoopState,
	input: {
		commit: string;
		diff: string;
		testFiles: string[];
		testHashes: LoopTestHash[];
		redRun?: LoopRunEvidence;
		greenRun?: LoopRunEvidence;
		dispatchId: string;
		maxVerifierRerunMs: number;
	},
): { state: LoopState; effects: LoopEffect[] } {
	if (state.stage !== "build") throw new Error(`cannot record build evidence while stage is ${state.stage}`);
	const agreedProblem = agreedTestProblem(state, input.testFiles);
	const buildState: LoopState = {
		...state,
		build: {
			commit: input.commit,
			...(input.redRun?.loop?.commit ? { redCommit: input.redRun.loop.commit } : {}),
			testFiles: input.testFiles,
			testHashes: input.testHashes,
			...(input.redRun ? { redRunLog: input.redRun.log } : {}),
			...(input.greenRun ? { greenRunLog: input.greenRun.log } : {}),
			...(input.redRun?.command ? { redRunCommand: input.redRun.command } : {}),
			...(input.greenRun?.command ? { greenRunCommand: input.greenRun.command } : {}),
		},
	};
	if (agreedProblem) return buildBlock(buildState, agreedProblem);
	const redProblem = redRunProblem(input.redRun, input.commit, input.testHashes);
	if (redProblem) return buildBlock(buildState, redProblem);
	const greenProblem = greenRunProblem(input.greenRun, input.commit, input.testHashes);
	if (greenProblem) return buildBlock(buildState, greenProblem);
	const redRunLog = input.redRun?.log;
	const greenRunLog = input.greenRun?.log;
	if (!redRunLog || !greenRunLog) return buildBlock(buildState, "run logs are missing");
	const task = verifierTask({
		brief: buildBrief(buildState),
		diff: input.diff,
		commit: input.commit,
		testHashes: input.testHashes,
		redRunLog,
		greenRunLog,
		redRunCommand: input.redRun?.command,
		greenRunCommand: input.greenRun?.command,
		dispatchId: input.dispatchId,
		maxVerifierRerunMs: input.maxVerifierRerunMs,
	});
	const next: LoopState = {
		...buildState,
		stage: "verify",
		block: undefined,
		verifierRequest: {
			commit: input.commit,
			diffHash: diffHash(input.diff),
			testHashes: input.testHashes,
			task,
			dispatchId: input.dispatchId,
			runLogs: [redRunLog, greenRunLog],
			maxVerifierRerunMs: input.maxVerifierRerunMs,
		},
	};
	return { state: next, effects: [{ type: "dispatch-verifier", agent: "verifier", task }] };
}

function verifierBlock(state: LoopState, reason: string): { state: LoopState; effects: LoopEffect[] } {
	return withBlock(state, {
		kind: "intake-failed",
		resumeStage: "verify",
		question: {
			id: "verifier-intake",
			text: `Verifier report could not be accepted: ${reason}. Should the runner ask for a fresh verifier report?`,
			recommended: "Ask for a fresh verifier report with logs tied to the exact commit and test hashes.",
			dependsOn: [],
		},
	});
}

function verificationFromReport(
	state: LoopState,
	status: "missed" | "blocked",
	report: HelperReport,
): NonNullable<LoopState["verification"]> {
	return {
		status,
		runLogs: state.verifierRequest?.runLogs ?? [],
		rerunChecks: (report.details as { rerunChecks: Static<typeof RerunCheck>[] }).rerunChecks,
		acceptedLogs: (report.details as { acceptedLogs: Static<typeof LogDecision>[] }).acceptedLogs,
		summary: report.summary,
	};
}

function classifiedMiss(
	state: LoopState,
	report: HelperReport,
	missClass: LoopReworkClass,
): { state: LoopState; effects: LoopEffect[] } {
	const reworkIndex = state.rework.length;
	const rework = [...state.rework, { class: missClass, evidence: report.evidence }];
	const classified: LoopState = {
		...state,
		stage: "classify",
		verification: verificationFromReport(state, "missed", report),
		rework,
	};
	if (state.rework.some((entry) => entry.class === missClass)) {
		const blocked = withBlock(classified, {
			kind: "same-rework-class",
			resumeStage: "advise",
			pendingAdvisors: ["intent", "codebase"],
			question: {
				id: "same-rework-class",
				text: `The verifier reported ${missClass} again in this task. What should change before the loop continues?`,
				recommended: "Give the new constraint or evidence to rerun advisor intake before any more build work.",
				dependsOn: [],
			},
		});
		return { state: blocked.state, effects: [proposalEffect(blocked.state, reworkIndex), ...blocked.effects] };
	}
	if (state.rework.length > 0) {
		const blocked = withBlock(classified, {
			kind: "second-rework",
			resumeStage: "advise",
			pendingAdvisors: ["intent", "codebase"],
			question: {
				id: "second-rework",
				text: `The verifier found another miss after one rework build (${missClass}). What new constraint or learning should restart intake?`,
				recommended:
					"Answer with the concrete new information; the runner will rerun advisors instead of starting a blind retry.",
				dependsOn: [],
			},
		});
		return { state: blocked.state, effects: [proposalEffect(blocked.state, reworkIndex), ...blocked.effects] };
	}
	if (missClass === "new-information") {
		return withBlock(classified, {
			kind: "new-information",
			resumeStage: "classify",
			question: {
				id: "new-information",
				text: `The verifier classified this miss as new information: ${report.summary}. Confirm whether this is real new information before a proposal and one rework build are allowed.`,
				recommended: "Answer only if this is real new information; the answer is recorded with the loop.",
				dependsOn: [],
			},
		});
	}
	return { state: classified, effects: [proposalEffect(classified, reworkIndex)] };
}

function verifierBlocked(state: LoopState, report: HelperReport): { state: LoopState; effects: LoopEffect[] } {
	const detail = report.openQuestions.length ? `\n\nVerifier questions:\n${list(report.openQuestions)}` : "";
	return withBlock(
		{
			...state,
			stage: "verify",
			verification: verificationFromReport(state, "blocked", report),
		},
		{
			kind: "intake-failed",
			resumeStage: "verify",
			question: {
				id: "verifier-blocked",
				text: `Verifier blocked: ${report.summary}.${detail}`,
				recommended: "Answer with the evidence needed for a fresh verifier report.",
				dependsOn: [],
			},
		},
	);
}

export function applyVerifierReport(
	state: LoopState,
	report: HelperReport,
	options: { acceptedLogs: LoopRunEvidence[] },
): { state: LoopState; effects: LoopEffect[] } {
	if (state.block) {
		const question = state.questions.find((item) => item.id === state.block?.questionId);
		return {
			state,
			effects: question ? [{ type: "ask-person", reason: state.block.kind, question }] : [],
		};
	}
	if (state.stage !== "verify") throw new Error(`cannot apply verifier report while stage is ${state.stage}`);
	if (!state.verifierRequest) throw new Error("verify stage is missing verifier request");
	if (report.role !== "verifier") throw new Error("verifier report is missing role");
	if (!report.dispatchId)
		return verifierBlock(state, "verifier report is missing dispatchId for the pending verifier request");
	if (report.dispatchId !== state.verifierRequest.dispatchId) {
		return verifierBlock(state, `verifier dispatchId ${report.dispatchId} did not match the pending verifier request`);
	}
	if (!Value.Check(ROLE_HELPER_REPORT_SCHEMAS.verifier, report)) {
		const [first] = Value.Errors(ROLE_HELPER_REPORT_SCHEMAS.verifier, report);
		const where = first?.instancePath ? `${first.instancePath}: ` : "";
		throw new Error(`invalid verifier helper_report: ${where}${first?.message ?? "report does not match schema"}`);
	}
	const details = report.details as {
		rerunChecks: Static<typeof RerunCheck>[];
		acceptedLogs: Static<typeof LogDecision>[];
		goalMatched: boolean;
	};
	for (const accepted of details.acceptedLogs) {
		const evidence = options.acceptedLogs.find((run) => run.log === accepted.log);
		if (!evidence) return verifierBlock(state, `${accepted.log} was accepted but could not be read`);
		const tie = runTieProblem(evidence, state.verifierRequest.testHashes);
		if (tie) return verifierBlock(state, `${accepted.log} was accepted but ${tie}`);
		if (evidence.loop?.commit !== state.verifierRequest.commit) {
			return verifierBlock(
				state,
				`${accepted.log} was accepted but it is tied to commit ${evidence.loop?.commit}, not ${state.verifierRequest.commit}`,
			);
		}
	}
	const verification = {
		status: "passed" as const,
		runLogs: state.verifierRequest.runLogs,
		rerunChecks: details.rerunChecks,
		acceptedLogs: details.acceptedLogs,
		summary: report.summary,
	};
	if (report.status === "done" && details.goalMatched) {
		return { state: { ...state, stage: "done", block: undefined, verification }, effects: [] };
	}
	if (report.status === "blocked") return verifierBlocked(state, report);
	const missClass = (report.details as { missClass?: LoopReworkClass }).missClass;
	if (!missClass) return verifierBlock(state, "verifier miss is missing missClass");
	return classifiedMiss(state, report, missClass);
}

export function staleReason(
	state: LoopState,
	current: {
		branch: string;
		baseHead: string;
		testHashes?: LoopTestHash[];
		diffHash?: string;
		dirtyWorktree?: boolean;
	},
): StaleReason | undefined {
	if (state.branch !== current.branch)
		return { kind: "branch-changed", detail: `branch changed from ${state.branch} to ${current.branch}` };
	if (state.baseHead !== current.baseHead)
		return { kind: "base-moved", detail: `base head changed from ${state.baseHead} to ${current.baseHead}` };
	if (state.frozenBriefHash && state.frozenBriefHash !== briefHash(buildBrief(state))) {
		return { kind: "brief", detail: "frozen brief hash is not current" };
	}
	if (current.dirtyWorktree) return { kind: "dirty-worktree", detail: "worktree has uncommitted changes" };
	if (
		current.testHashes &&
		state.build.testHashes.length > 0 &&
		!sameHashes(state.build.testHashes, current.testHashes)
	) {
		return { kind: "test-hashes", detail: "test hashes do not match test files" };
	}
	if (current.diffHash && state.verifierRequest && state.verifierRequest.diffHash !== current.diffHash) {
		return { kind: "diff", detail: "diff no longer matches verifier request" };
	}
	return undefined;
}

export function staleReasonText(reason: StaleReason): string {
	return reason.detail;
}

export function blockForStaleState(
	state: LoopState,
	current: {
		branch: string;
		baseHead: string;
		testHashes?: LoopTestHash[];
		diffHash?: string;
		dirtyWorktree?: boolean;
	},
): { state: LoopState; effects: LoopEffect[] } {
	const reason = staleReason(state, current);
	if (!reason) return { state, effects: [] };
	const question: LoopQuestion = {
		id: STALE_STATE_QUESTION_ID,
		text: `The loop state is stale: ${staleReasonText(reason)}. Should this graph continue from the current branch and base head?`,
		recommended: "Answer how to proceed before the runner dispatches more work.",
		dependsOn: [],
	};
	const verifyEvidenceStale =
		state.stage === "verify" &&
		(reason.kind === "test-hashes" || reason.kind === "diff" || reason.kind === "dirty-worktree");
	return withBlock(state, {
		kind: "stale",
		question,
		resumeStage: verifyEvidenceStale ? "build" : undefined,
		pendingAdvisors: verifyEvidenceStale ? [] : pendingAdvisorsForResume(state),
	});
}

export function blockForAdvisorIntakeFailure(
	state: LoopState,
	role: AdvisorRole,
	reason: string,
): { state: LoopState; effects: LoopEffect[] } {
	const question: LoopQuestion = {
		id: `advisor-intake-${role}`,
		text: `${role} advisor result could not be read: ${reason}. Should the runner retry that advisor?`,
		recommended: "Answer how to proceed; retrying the advisor is usually safest.",
		dependsOn: [],
	};
	return withBlock(state, { kind: "intake-failed", question, pendingAdvisors: [role] });
}

export function blockForVerifierIntakeFailure(
	state: LoopState,
	reason: string,
): { state: LoopState; effects: LoopEffect[] } {
	return verifierBlock(state, reason);
}

export function blockForGitFailure(state: LoopState, reason: string): { state: LoopState; effects: LoopEffect[] } {
	const question: LoopQuestion = {
		id: "git-state",
		text: `Git state could not be resolved for this loop: ${reason}. Fix the repository refs, then answer to continue.`,
		recommended: "Restore the missing git ref or say how to proceed.",
		dependsOn: [],
	};
	return withBlock(state, { kind: "git", question, pendingAdvisors: pendingAdvisorsForResume(state) });
}
