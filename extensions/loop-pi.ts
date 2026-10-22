/**
 * Thin Pi wiring for the LOOPS runner. State transitions stay in loop.ts.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { grimoireDir, grimoireStoreStatus } from "./grimoire.ts";
import { validateHelperReport } from "./helper-report.ts";
import {
	type AdvisorRole,
	applyAdvisorReport,
	applyLeadPlan,
	applyPersonAnswer,
	approveBrief,
	type LoopEffect,
	type LoopState,
	staleReason,
	startLoop,
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
	return process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".sitra", "profile");
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

function writeLoopStateFile(path: string, state: LoopState): void {
	const valid = validateLoopState(state);
	if (!valid.ok) throw new Error(`refusing to write invalid loop state ${path}: ${valid.reason}`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(state, null, "\t")}\n`);
}

function git(cwd: string, args: string[]): string | undefined {
	try {
		return (
			execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined
		);
	} catch {
		return undefined;
	}
}

function currentBranch(cwd: string): string {
	return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "unknown";
}

function currentBaseHead(cwd: string): string {
	return (
		git(cwd, ["rev-parse", "origin/main"]) ??
		git(cwd, ["rev-parse", "main"]) ??
		git(cwd, ["rev-parse", "HEAD"]) ??
		"unknown"
	);
}

function statePath(ctx: Ctx): string {
	return loopStatePath(profileDir(), ctx.cwd, currentBranch(ctx.cwd));
}

function splitCommand(args: string): { verb: string; rest: string } {
	const trimmed = args.trim();
	const space = trimmed.indexOf(" ");
	if (space < 0) return { verb: trimmed, rest: "" };
	return { verb: trimmed.slice(0, space), rest: trimmed.slice(space + 1).trim() };
}

function loadCurrentState(ctx: Ctx): LoopState {
	const state = readLoopStateFile(statePath(ctx));
	const reason = staleReason(state, { branch: currentBranch(ctx.cwd), baseHead: currentBaseHead(ctx.cwd) });
	if (!reason) return state;
	const question = {
		id: "stale-state",
		text: `The loop state is stale: ${reason}. Should this graph be restarted or updated before continuing?`,
		recommended: "Answer with how to proceed before the runner dispatches more work.",
		dependsOn: [],
	};
	const blocked: LoopState = { ...state, stage: "blocked", questions: [question] };
	writeLoopStateFile(statePath(ctx), blocked);
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

function renderDispatch(state: LoopState, roles: AdvisorRole[]): string {
	const bullets = roles.map(
		(role) =>
			`- Start ${advisorName(role)} with the LOOPS goal, limits, done lines, and current state. The helper must report through helper_report with role ${role}.`,
	);
	return [`LOOPS runner dispatch for stage ${state.stage}:`, `Goal: ${state.goal}`, ...bullets].join("\n");
}

function renderEffect(state: LoopState, effect: LoopEffect): string {
	if (effect.type === "dispatch-advisors") return renderDispatch(state, effect.roles);
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

function affectedAdvisors(state: LoopState): AdvisorRole[] {
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

function tokenCount(event: Record<string, unknown>): number | undefined {
	for (const key of ["tokenCount", "tokens", "totalTokens"]) {
		const value = event[key];
		if (typeof value === "number") return value;
	}
	for (const key of ["usage", "metrics"]) {
		const nested = event[key];
		if (!nested || typeof nested !== "object") continue;
		for (const nestedKey of ["totalTokens", "tokens", "inputTokens", "outputTokens"]) {
			const value = (nested as Record<string, unknown>)[nestedKey];
			if (typeof value === "number") return value;
		}
	}
	return undefined;
}

async function handleLoopCommand(pi: Pi, args: string, ctx: Ctx): Promise<void> {
	const { verb, rest } = splitCommand(args);
	if (verb === "start") {
		if (!rest) throw new Error("usage: /loop start <task>");
		const result = startLoop({
			worktree: ctx.cwd,
			branch: currentBranch(ctx.cwd),
			baseHead: currentBaseHead(ctx.cwd),
			goal: rest,
			limits: [],
			done: [],
			grimoire: grimoireStoreStatus(grimoireDir(process.env)),
		});
		writeLoopStateFile(statePath(ctx), result.state);
		emitEffects(pi, result.state, result.effects);
		return;
	}
	if (verb === "answer") {
		if (!rest) throw new Error("usage: /loop answer <answer>");
		const state = loadCurrentState(ctx);
		const result = applyPersonAnswer(state, { answer: rest, affectedAdvisors: affectedAdvisors(state) });
		writeLoopStateFile(statePath(ctx), result.state);
		emitEffects(pi, result.state, result.effects);
		return;
	}
	if (verb === "plan") {
		if (!rest) throw new Error("usage: /loop plan <plan>");
		const result = applyLeadPlan(loadCurrentState(ctx), rest);
		writeLoopStateFile(statePath(ctx), result.state);
		emitEffects(pi, result.state, result.effects);
		return;
	}
	if (verb === "approve") {
		if (!rest) throw new Error("usage: /loop approve <summary>");
		const result = approveBrief(loadCurrentState(ctx), {
			approvedBy: "person",
			approvedAt: new Date().toISOString(),
			summary: rest,
		});
		writeLoopStateFile(statePath(ctx), result.state);
		emitEffects(pi, result.state, result.effects);
		return;
	}
	throw new Error("usage: /loop start <task> | /loop answer <answer> | /loop plan <plan> | /loop approve <summary>");
}

async function handleSubagentResult(pi: Pi, event: unknown, ctx: Ctx): Promise<void> {
	if (!event || typeof event !== "object") throw new Error("subagent_result event is missing details");
	const raw = event as Record<string, unknown>;
	if (typeof raw.sessionFile !== "string" || !raw.sessionFile)
		throw new Error("subagent_result is missing sessionFile");
	const valid = validateHelperReport(raw.details);
	if (!valid.ok) throw new Error(`invalid helper_report from ${raw.sessionFile}: ${valid.reason}`);
	if (!valid.report.role) throw new Error(`invalid helper_report from ${raw.sessionFile}: missing role`);
	const result = applyAdvisorReport(loadCurrentState(ctx), valid.report, { tokenCount: tokenCount(raw) });
	writeLoopStateFile(statePath(ctx), result.state);
	emitEffects(pi, result.state, result.effects);
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
			const state = loadCurrentState(ctx);
			const tokens = Object.values(state.advisorRuns).reduce((sum, run) => sum + (run?.tokenCount ?? 0), 0);
			return {
				content: [
					{ type: "text", text: `stage: ${state.stage}\ngoal: ${state.goal}\nadvisor tokens recorded: ${tokens}` },
				],
				details: state,
			};
		},
	});

	pi.on("subagent_result", (event, ctx) => handleSubagentResult(pi, event, ctx));
	pi.on("message_end", (event, ctx) => {
		const result = subagentResultFromMessageEnd(event);
		if (!result) return undefined;
		return handleSubagentResult(pi, result, ctx);
	});
}
