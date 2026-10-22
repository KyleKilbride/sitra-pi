/**
 * Thin Pi wiring for the LOOPS runner. State transitions stay in loop.ts.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { grimoireDir, grimoireStoreStatus } from "./grimoire.ts";
import { validateHelperReport } from "./helper-report.ts";
import {
	type AdvisorRole,
	answerLoopQuestion,
	applyAdvisorReport,
	applyLeadPlan,
	approveBrief,
	blockForAdvisorIntakeFailure,
	blockForStaleState,
	type LoopEffect,
	type LoopState,
	roleForAgent,
	STALE_STATE_QUESTION_ID,
	staleReason,
	startLoop,
	tokensFromSubagentResult,
	validateLoopState,
} from "./loop.ts";

interface Ctx {
	cwd: string;
	ui?: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		setStatus?(key: string, text: string | undefined): void;
	};
}

interface ToolResult {
	content: { type: "text"; text: string }[];
	details: unknown;
}

interface Pi {
	on(event: string, handler: (event: never, ctx: Ctx) => unknown): void;
	registerCommand(name: string, command: { description: string; handler(args: string, ctx: Ctx): Promise<void> }): void;
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		promptSnippet?: string;
		parameters: unknown;
		execute(
			id: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: Ctx,
		): Promise<ToolResult>;
	}): void;
	sendUserMessage(
		content: string,
		options?: { deliverAs?: "steer" | "followUp"; streamingBehavior?: "steer" | "followUp" },
	): void;
}

function profileDir(): string {
	if (process.env.PI_CODING_AGENT_DIR?.trim()) return process.env.PI_CODING_AGENT_DIR.trim();
	const dir = grimoireDir({ ...process.env, SITRA_GRIMOIRE: undefined });
	return dirname(dir);
}

export function loopStatePath(profile: string, worktree: string, branch: string): string {
	const key = createHash("sha256").update(JSON.stringify({ worktree, branch })).digest("hex");
	return join(profile, "loops", `${key}.json`);
}

export function readLoopStateFile(path: string): LoopState {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(`could not read loop state ${path}: ${String(error)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`invalid loop state JSON ${path}: ${String(error)}`);
	}
	const valid = validateLoopState(parsed);
	if (!valid.ok) throw new Error(`invalid loop state ${path}: ${valid.reason}`);
	return valid.state;
}

export function writeLoopStateFile(path: string, state: LoopState): void {
	const valid = validateLoopState(state);
	if (!valid.ok) throw new Error(`refusing to write invalid loop state ${path}: ${valid.reason}`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(state, null, "\t")}\n`);
}

function git(cwd: string, args: string[]): string {
	try {
		const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
		if (!out) throw new Error("empty output");
		return out;
	} catch (error) {
		throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${String(error)}`);
	}
}

interface GitState {
	worktree: string;
	branch: string;
	baseRef: string;
	baseHead: string;
}

function currentGit(cwd: string, baseRef = defaultBaseRef(cwd)): GitState {
	const worktree = git(cwd, ["rev-parse", "--show-toplevel"]);
	const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const baseHead = git(cwd, ["rev-parse", baseRef]);
	return { worktree, branch, baseRef, baseHead };
}

function defaultBaseRef(cwd: string): string {
	return git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
}

function currentGitForState(cwd: string, state: LoopState): GitState {
	return currentGit(cwd, state.baseRef);
}

function tryCurrentGit(cwd: string): GitState | undefined {
	try {
		return currentGit(cwd);
	} catch {
		return undefined;
	}
}

function statePathFor(gitState: GitState): string {
	return loopStatePath(profileDir(), gitState.worktree, gitState.branch);
}

function splitCommand(args: string): { verb: string; rest: string } {
	const trimmed = args.trim();
	const space = trimmed.indexOf(" ");
	if (space < 0) return { verb: trimmed, rest: "" };
	return { verb: trimmed.slice(0, space), rest: trimmed.slice(space + 1).trim() };
}

function parseStart(rest: string): { baseRef?: string; goal: string } {
	const prefix = "--base ";
	if (!rest.startsWith(prefix)) return { goal: rest };
	const after = rest.slice(prefix.length).trim();
	const space = after.indexOf(" ");
	if (space < 0) throw new Error("usage: /loop start [--base <ref>] <task>");
	return { baseRef: after.slice(0, space), goal: after.slice(space + 1).trim() };
}

function isBaseBranch(branch: string, baseRef: string): boolean {
	return branch === baseRef || `origin/${branch}` === baseRef || baseRef.endsWith(`/${branch}`);
}

function loadCurrentState(gitState: GitState): LoopState {
	return readLoopStateFile(statePathFor(gitState));
}

function loadMutableState(gitState: GitState): LoopState {
	const path = statePathFor(gitState);
	const state = readLoopStateFile(path);
	const reason = staleReason(state, { branch: gitState.branch, baseHead: gitState.baseHead });
	if (!reason) return state;
	const blocked = blockForStaleState(state, { branch: gitState.branch, baseHead: gitState.baseHead });
	writeLoopStateFile(path, blocked.state);
	throw new Error(`loop state is stale: ${reason}`);
}

function advisorName(role: AdvisorRole): string {
	return role === "intent"
		? "intent-advisor"
		: role === "codebase"
			? "codebase-advisor"
			: role === "test-design"
				? "test-design-advisor"
				: "architecture-advisor";
}

function renderDispatch(state: LoopState, effect: Extract<LoopEffect, { type: "dispatch-advisors" }>): string {
	const bullets = effect.advisors.map(
		(advisor) => `- Start ${advisorName(advisor.role)} with this task:\n${advisor.task}`,
	);
	return [`LOOPS runner dispatch for stage ${state.stage}:`, `Goal: ${state.goal}`, ...bullets].join("\n");
}

function renderEffect(state: LoopState, effect: LoopEffect): string {
	if (effect.type === "dispatch-advisors") return renderDispatch(state, effect);
	if (effect.type === "ask-person")
		return [
			`LOOPS needs one answer before continuing:`,
			effect.question.text,
			`Recommended: ${effect.question.recommended}`,
		].join("\n\n");
	if (effect.type === "write-lead-plan")
		return "LOOPS advisors are complete. Write the high-level lead plan, then run `/loop plan <plan>`.";
	return `LOOPS stage: brief-approved\nFrozen brief hash: ${state.frozenBriefHash ?? "(missing)"}`;
}

function emitEffects(pi: Pi, state: LoopState, effects: LoopEffect[]): void {
	for (const effect of effects)
		pi.sendUserMessage(renderEffect(state, effect), { deliverAs: "followUp", streamingBehavior: "followUp" });
}

async function handleLoopCommand(pi: Pi, args: string, ctx: Ctx): Promise<void> {
	const { verb, rest } = splitCommand(args);
	if (verb === "start") {
		if (!rest) throw new Error("usage: /loop start <task>");
		const parsed = parseStart(rest);
		const gitState = currentGit(ctx.cwd, parsed.baseRef ?? defaultBaseRef(ctx.cwd));
		if (isBaseBranch(gitState.branch, gitState.baseRef)) throw new Error("refusing to start a loop on the base branch");
		const path = statePathFor(gitState);
		if (existsSync(path)) throw new Error(`loop state already exists for ${gitState.worktree} on ${gitState.branch}`);
		const result = startLoop({
			worktree: gitState.worktree,
			branch: gitState.branch,
			baseRef: gitState.baseRef,
			baseHead: gitState.baseHead,
			goal: parsed.goal,
			limits: [],
			done: [],
			grimoire: grimoireStoreStatus(grimoireDir(process.env)),
		});
		writeLoopStateFile(path, result.state);
		emitEffects(pi, result.state, result.effects);
		return;
	}
	const initial = currentGit(ctx.cwd);
	const path = statePathFor(initial);
	const currentState = readLoopStateFile(path);
	const gitState = currentGitForState(ctx.cwd, currentState);
	if (verb === "answer") {
		if (!rest) throw new Error("usage: /loop answer <answer>");
		const rawState = currentState;
		const isStaleAnswer =
			rawState.stage === "blocked" && rawState.questions.some((question) => question.id === STALE_STATE_QUESTION_ID);
		const state = isStaleAnswer ? rawState : loadMutableState(gitState);
		const result = answerLoopQuestion(state, { answer: rest, current: gitState });
		writeLoopStateFile(path, result.state);
		emitEffects(pi, result.state, result.effects);
		return;
	}
	if (verb === "plan") {
		if (!rest) throw new Error("usage: /loop plan <plan>");
		const result = applyLeadPlan(loadMutableState(gitState), rest);
		writeLoopStateFile(path, result.state);
		emitEffects(pi, result.state, result.effects);
		return;
	}
	if (verb === "approve") {
		if (!rest) throw new Error("usage: /loop approve <summary>");
		const result = approveBrief(loadMutableState(gitState), {
			approvedBy: "person",
			approvedAt: new Date().toISOString(),
			summary: rest,
		});
		writeLoopStateFile(path, result.state);
		emitEffects(pi, result.state, result.effects);
		return;
	}
	throw new Error("usage: /loop start <task> | /loop answer <answer> | /loop plan <plan> | /loop approve <summary>");
}

async function handleSubagentResult(pi: Pi, event: unknown, ctx: Ctx): Promise<void> {
	if (!event || typeof event !== "object") return;
	const initial = tryCurrentGit(ctx.cwd);
	if (!initial) return;
	const path = statePathFor(initial);
	if (!existsSync(path)) return;
	const state = readLoopStateFile(path);
	const gitState = currentGitForState(ctx.cwd, state);
	const raw = event as Record<string, unknown>;
	const role = roleForAgent(raw.agent);
	if (!role || !state.dispatchedAdvisors.includes(role)) return;
	if (state.stage !== "advise" && state.stage !== "architecture-review") return;
	const stale = blockForStaleState(state, { branch: gitState.branch, baseHead: gitState.baseHead });
	if (stale.state.stage === "blocked") {
		writeLoopStateFile(path, stale.state);
		emitEffects(pi, stale.state, stale.effects);
		return;
	}
	const block = (reason: string) => {
		const blocked = blockForAdvisorIntakeFailure(state, role, reason);
		writeLoopStateFile(path, blocked.state);
		emitEffects(pi, blocked.state, blocked.effects);
	};
	if (typeof raw.sessionFile !== "string" || !raw.sessionFile) {
		block("subagent_result is missing sessionFile");
		return;
	}
	const tokens = tokensFromSubagentResult(raw);
	let report: unknown;
	try {
		report = readHelperReport(raw.sessionFile);
	} catch (error) {
		block(String(error));
		return;
	}
	const valid = validateHelperReport(report);
	if (!valid.ok) {
		block(`invalid helper_report from ${raw.sessionFile}: ${valid.reason}`);
		return;
	}
	if (!valid.report.role) {
		block(`invalid helper_report from ${raw.sessionFile}: missing role`);
		return;
	}
	let result: { state: LoopState; effects: LoopEffect[] };
	try {
		result = applyAdvisorReport(state, valid.report, tokens);
	} catch (error) {
		block(String(error));
		return;
	}
	writeLoopStateFile(path, result.state);
	emitEffects(pi, result.state, result.effects);
}

function findHelperReport(input: unknown): unknown | undefined {
	if (!input || typeof input !== "object") return undefined;
	const record = input as Record<string, unknown>;
	if (record.toolName === "helper_report" && record.isError !== true && "details" in record) return record.details;
	if (record.message) {
		const found = findHelperReport(record.message);
		if (found !== undefined) return found;
	}
	return undefined;
}

function readHelperReport(sessionFile: string): unknown {
	let raw: string;
	try {
		raw = readFileSync(sessionFile, "utf8");
	} catch (error) {
		throw new Error(`could not read helper session file ${sessionFile}: ${String(error)}`);
	}
	let latest: unknown;
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch (error) {
			throw new Error(`invalid helper session JSON in ${sessionFile}: ${String(error)}`);
		}
		const report = findHelperReport(parsed);
		if (report !== undefined) latest = report;
	}
	if (latest !== undefined) return latest;
	throw new Error(`helper_report tool result not found in ${sessionFile}`);
}

function subagentResultFromMessageEnd(event: unknown): unknown | undefined {
	if (!event || typeof event !== "object") return undefined;
	const message = (event as { message?: unknown }).message;
	if (!message || typeof message !== "object") return undefined;
	const raw = message as { customType?: unknown; details?: unknown };
	if (raw.customType !== "subagent_result") return undefined;
	return raw.details;
}

export default function sitraLoop(pi: Pi): void {
	pi.registerCommand("loop", {
		description: "Start and advance an explicit LOOPS graph: start, answer, plan, approve",
		handler: async (args, ctx) => handleLoopCommand(pi, args, ctx),
	});

	pi.registerTool({
		name: "loop_status",
		label: "Loop status",
		description: "Read the current LOOPS runner state for this worktree and branch.",
		promptSnippet: "loop_status: read the current LOOPS runner stage and frozen brief status",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const initial = currentGit(ctx.cwd);
			const state = loadCurrentState(initial);
			const gitState = currentGitForState(ctx.cwd, state);
			const stale = staleReason(state, { branch: gitState.branch, baseHead: gitState.baseHead });
			const tokens = Object.values(state.advisorRuns).reduce(
				(sum, run) => sum + (run?.outputTokens ?? 0) + (run?.contextTokens ?? 0),
				0,
			);
			return {
				content: [
					{
						type: "text",
						text: [
							`stage: ${state.stage}`,
							`goal: ${state.goal}`,
							`advisor tokens recorded: ${tokens}`,
							...(stale ? [`stale: ${stale}`] : []),
						].join("\n"),
					},
				],
				details: state,
			};
		},
	});

	pi.on("message_end", (event, ctx) => {
		const result = subagentResultFromMessageEnd(event);
		if (!result) return undefined;
		return handleSubagentResult(pi, result, ctx);
	});
}
