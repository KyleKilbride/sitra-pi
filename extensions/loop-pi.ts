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
	applyVerifierReport,
	approveBrief,
	blockForAdvisorIntakeFailure,
	blockForGitFailure,
	blockForStaleState,
	blockForVerifierIntakeFailure,
	diffHash,
	LOOP_RUN_MARKER,
	type LoopEffect,
	type LoopState,
	type LoopTestHash,
	recordBlockAnswer,
	recordBuildEvidence,
	replaceBlockWithStale,
	roleForAgent,
	staleReason,
	startBuild,
	startLoop,
	tokensFromSubagentResult,
	validateLoopState,
} from "./loop.ts";
import { readRun } from "./runs.ts";

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

const LOOP_USAGE =
	"usage: /loop start [--base <ref>] <task> | /loop answer <answer> | /loop plan <plan> | /loop approve <summary> | /loop build | /loop record-build <json> | /loop status";
const LOOP_VERBS = ["start", "answer", "plan", "approve", "build", "record-build", "status"] as const;
type LoopVerb = (typeof LOOP_VERBS)[number];

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

function fileSha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function resolveWorktreePath(cwd: string, file: string): string {
	if (!file.trim()) throw new Error("test file path is empty");
	if (file.startsWith("/")) return file;
	const worktree = git(cwd, ["rev-parse", "--show-toplevel"]);
	return join(worktree, file);
}

function testHashes(cwd: string, files: string[]): LoopTestHash[] {
	return files.map((file) => ({ file, sha256: fileSha256(resolveWorktreePath(cwd, file)) }));
}

function currentCommit(cwd: string): string {
	return git(cwd, ["rev-parse", "HEAD"]);
}

function diffAgainstBase(cwd: string, state: LoopState): string {
	return execFileSync("git", ["diff", "--no-ext-diff", `${state.baseRef}...HEAD`], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function parseLoopRunLog(log: string): {
	log: string;
	done: boolean;
	exitCode?: number;
	loop?: { commit: string; testHashes: LoopTestHash[] };
} {
	const raw = readFileSync(log, "utf8");
	const status = readRun(raw);
	let loop: { commit: string; testHashes: LoopTestHash[] } | undefined;
	for (const line of raw.split("\n")) {
		if (!line.startsWith(LOOP_RUN_MARKER)) continue;
		const parsed = JSON.parse(line.slice(LOOP_RUN_MARKER.length)) as {
			commit?: unknown;
			testHashes?: unknown;
		};
		if (
			typeof parsed.commit === "string" &&
			Array.isArray(parsed.testHashes) &&
			parsed.testHashes.every(
				(item) =>
					item &&
					typeof item === "object" &&
					typeof (item as { file?: unknown }).file === "string" &&
					typeof (item as { sha256?: unknown }).sha256 === "string",
			)
		) {
			loop = { commit: parsed.commit, testHashes: parsed.testHashes as LoopTestHash[] };
		}
	}
	return {
		log,
		done: status.done,
		...(status.exitCode !== undefined ? { exitCode: status.exitCode } : {}),
		...(loop ? { loop } : {}),
	};
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

function checkoutGit(cwd: string): Omit<GitState, "baseRef" | "baseHead"> {
	return {
		worktree: git(cwd, ["rev-parse", "--show-toplevel"]),
		branch: git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
	};
}

function currentGitForState(cwd: string, state: LoopState): GitState {
	const checkout = checkoutGit(cwd);
	return { ...checkout, baseRef: state.baseRef, baseHead: git(cwd, ["rev-parse", state.baseRef]) };
}

function statePathFor(gitState: GitState): string {
	return loopStatePath(profileDir(), gitState.worktree, gitState.branch);
}

function noLoopMessage(checkout: Omit<GitState, "baseRef" | "baseHead">): string {
	return `no loop on ${checkout.branch} in ${checkout.worktree}; start one with /loop start <task>`;
}

function splitCommand(args: string): { verb: string; rest: string } {
	const trimmed = args.trim();
	const space = trimmed.indexOf(" ");
	if (space < 0) return { verb: trimmed, rest: "" };
	return { verb: trimmed.slice(0, space), rest: trimmed.slice(space + 1).trim() };
}

function isLoopVerb(verb: string): verb is LoopVerb {
	return (LOOP_VERBS as readonly string[]).includes(verb);
}

function parseStart(rest: string): { baseRef?: string; goal: string } {
	const prefix = "--base ";
	if (!rest.startsWith(prefix)) return { goal: rest };
	const after = rest.slice(prefix.length).trim();
	const space = after.indexOf(" ");
	if (space < 0) throw new Error(LOOP_USAGE);
	return { baseRef: after.slice(0, space), goal: after.slice(space + 1).trim() };
}

function isBaseBranch(branch: string, baseRef: string): boolean {
	const remotePrefix = "origin/";
	const baseBranch = baseRef.startsWith(remotePrefix) ? baseRef.slice(remotePrefix.length) : baseRef;
	return `refs/heads/${branch}` === `refs/heads/${baseBranch}`;
}

function loadExistingCurrentState(checkout: Omit<GitState, "baseRef" | "baseHead">): {
	path: string;
	state: LoopState;
} {
	const path = statePathFor({ ...checkout, baseRef: "", baseHead: "" });
	if (!existsSync(path)) throw new Error(noLoopMessage(checkout));
	return { path, state: readLoopStateFile(path) };
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

function blockIfBuildOrVerifyStale(
	cwd: string,
	path: string,
	state: LoopState,
	gitState: GitState,
): { state: LoopState; effects: LoopEffect[] } | undefined {
	if (state.build.testFiles.length === 0 && !state.verifierRequest) return undefined;
	const current = {
		branch: gitState.branch,
		baseHead: gitState.baseHead,
		...(state.build.testFiles.length > 0 ? { testHashes: testHashes(cwd, state.build.testFiles) } : {}),
		...(state.verifierRequest ? { diffHash: diffHash(diffAgainstBase(cwd, state)) } : {}),
	};
	const reason = staleReason(state, current);
	if (!reason) return undefined;
	const blocked = blockForStaleState(state, current);
	writeLoopStateFile(path, blocked.state);
	return blocked;
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
	if (effect.type === "dispatch-verifier")
		return [
			"LOOPS runner dispatch for stage verify:",
			"Start verifier in a fresh context with this exact task. Do not add the builder transcript or any helper brief.",
			effect.task,
		].join("\n");
	return `LOOPS stage: brief-approved\nFrozen brief hash: ${state.frozenBriefHash ?? "(missing)"}`;
}

function emitEffects(pi: Pi, state: LoopState, effects: LoopEffect[]): void {
	for (const effect of effects)
		pi.sendUserMessage(renderEffect(state, effect), { deliverAs: "followUp", streamingBehavior: "followUp" });
}

function loopStatus(cwd: string, state: LoopState): ToolResult {
	let gitState: GitState;
	try {
		gitState = currentGitForState(cwd, state);
	} catch (error) {
		const blocked = blockForGitFailure(state, String(error));
		return {
			content: [{ type: "text", text: `stage: blocked\ngit: ${String(error)}` }],
			details: blocked.state,
		};
	}
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
}

function recordBuildFromParams(
	pi: Pi,
	ctx: Ctx,
	path: string,
	state: LoopState,
	params: { testFiles: string[]; redRunLog: string; greenRunLog: string; maxVerifierRerunMs?: number },
): LoopState {
	const hashes = testHashes(ctx.cwd, params.testFiles);
	const result = recordBuildEvidence(state, {
		commit: currentCommit(ctx.cwd),
		diff: diffAgainstBase(ctx.cwd, state),
		testFiles: params.testFiles,
		testHashes: hashes,
		redRun: parseLoopRunLog(params.redRunLog),
		greenRun: parseLoopRunLog(params.greenRunLog),
		maxVerifierRerunMs: params.maxVerifierRerunMs ?? 120_000,
	});
	writeLoopStateFile(path, result.state);
	emitEffects(pi, result.state, result.effects);
	return result.state;
}

async function handleLoopCommand(pi: Pi, args: string, ctx: Ctx): Promise<void> {
	const { verb, rest } = splitCommand(args);
	if (!verb || !isLoopVerb(verb)) throw new Error(LOOP_USAGE);
	if (verb === "start") {
		if (!rest) throw new Error(LOOP_USAGE);
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
	const checkout = checkoutGit(ctx.cwd);
	const { path, state: currentState } = loadExistingCurrentState(checkout);
	if (verb === "status") {
		if (!ctx.ui?.notify) throw new Error("/loop status requires an interactive UI");
		ctx.ui.notify(loopStatus(ctx.cwd, currentState).content[0]?.text ?? "", "info");
		return;
	}
	let gitState: GitState;
	try {
		gitState = currentGitForState(ctx.cwd, currentState);
	} catch (error) {
		const blocked = blockForGitFailure(currentState, String(error));
		writeLoopStateFile(path, blocked.state);
		emitEffects(pi, blocked.state, blocked.effects);
		return;
	}
	if (verb === "answer") {
		if (!rest) throw new Error(LOOP_USAGE);
		const rawState = currentState;
		const isStaleAnswer = rawState.stage === "blocked" && rawState.block?.kind === "stale";
		if (!isStaleAnswer && rawState.block) {
			const answered = recordBlockAnswer(rawState, rest);
			writeLoopStateFile(path, answered);
			const stale = replaceBlockWithStale(answered, { branch: gitState.branch, baseHead: gitState.baseHead });
			if (stale.effects.length > 0) {
				writeLoopStateFile(path, stale.state);
				emitEffects(pi, stale.state, stale.effects);
				return;
			}
			const result = answerLoopQuestion(answered, { answer: rest, current: gitState });
			writeLoopStateFile(path, result.state);
			emitEffects(pi, result.state, result.effects);
			return;
		}
		const state = isStaleAnswer ? rawState : loadMutableState(gitState);
		const result = answerLoopQuestion(state, { answer: rest, current: gitState });
		writeLoopStateFile(path, result.state);
		emitEffects(pi, result.state, result.effects);
		return;
	}
	if (verb === "plan") {
		if (!rest) throw new Error(LOOP_USAGE);
		const result = applyLeadPlan(loadMutableState(gitState), rest);
		writeLoopStateFile(path, result.state);
		emitEffects(pi, result.state, result.effects);
		return;
	}
	if (verb === "approve") {
		if (!rest) throw new Error(LOOP_USAGE);
		const result = approveBrief(loadMutableState(gitState), {
			approvedBy: "person",
			approvedAt: new Date().toISOString(),
			summary: rest,
		});
		writeLoopStateFile(path, result.state);
		emitEffects(pi, result.state, result.effects);
		return;
	}
	if (verb === "build") {
		if (rest) throw new Error(LOOP_USAGE);
		const result = startBuild(loadMutableState(gitState));
		writeLoopStateFile(path, result.state);
		pi.sendUserMessage(
			"LOOPS stage: build\nMaterialize the agreed tests, run red then green checks, and record evidence with loop_record_build.",
			{ deliverAs: "followUp", streamingBehavior: "followUp" },
		);
		return;
	}
	if (verb === "record-build") {
		if (!rest) throw new Error(LOOP_USAGE);
		const state = loadMutableState(gitState);
		let parsed: unknown;
		try {
			parsed = JSON.parse(rest);
		} catch (error) {
			throw new Error(`invalid /loop record-build JSON: ${String(error)}`);
		}
		if (!parsed || typeof parsed !== "object") throw new Error("invalid /loop record-build JSON: expected object");
		const params = parsed as {
			testFiles?: unknown;
			redRunLog?: unknown;
			greenRunLog?: unknown;
			maxVerifierRerunMs?: unknown;
		};
		if (
			!Array.isArray(params.testFiles) ||
			!params.testFiles.every((file) => typeof file === "string" && file.length > 0) ||
			typeof params.redRunLog !== "string" ||
			typeof params.greenRunLog !== "string" ||
			(params.maxVerifierRerunMs !== undefined && typeof params.maxVerifierRerunMs !== "number")
		) {
			throw new Error("invalid /loop record-build JSON: expected testFiles, redRunLog and greenRunLog");
		}
		const next = recordBuildFromParams(pi, ctx, path, state, {
			testFiles: params.testFiles,
			redRunLog: params.redRunLog,
			greenRunLog: params.greenRunLog,
			...(typeof params.maxVerifierRerunMs === "number" ? { maxVerifierRerunMs: params.maxVerifierRerunMs } : {}),
		});
		pi.sendUserMessage(`LOOPS stage: ${next.stage}`, { deliverAs: "followUp", streamingBehavior: "followUp" });
		return;
	}
}

async function handleSubagentResult(pi: Pi, event: unknown, ctx: Ctx): Promise<void> {
	if (!event || typeof event !== "object") return;
	let checkout: Omit<GitState, "baseRef" | "baseHead">;
	try {
		checkout = checkoutGit(ctx.cwd);
	} catch {
		return;
	}
	const path = statePathFor({ ...checkout, baseRef: "", baseHead: "" });
	if (!existsSync(path)) return;
	const state = readLoopStateFile(path);
	const raw = event as Record<string, unknown>;
	if (raw.agent === "verifier") {
		if (state.stage !== "verify") return;
		let gitState: GitState;
		try {
			gitState = currentGitForState(ctx.cwd, state);
		} catch (error) {
			const blocked = blockForGitFailure(state, String(error));
			writeLoopStateFile(path, blocked.state);
			emitEffects(pi, blocked.state, blocked.effects);
			return;
		}
		const stale = blockIfBuildOrVerifyStale(ctx.cwd, path, state, gitState);
		if (stale) {
			emitEffects(pi, stale.state, stale.effects);
			return;
		}
		const block = (reason: string) => {
			const blocked = blockForVerifierIntakeFailure(state, reason);
			writeLoopStateFile(path, blocked.state);
			emitEffects(pi, blocked.state, blocked.effects);
		};
		if (typeof raw.sessionFile !== "string" || !raw.sessionFile) {
			block("subagent_result is missing sessionFile");
			return;
		}
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
		let result: { state: LoopState; effects: LoopEffect[] };
		try {
			const details = valid.report.details as { acceptedLogs?: { log?: unknown }[] } | undefined;
			const acceptedLogs = (details?.acceptedLogs ?? [])
				.filter((entry): entry is { log: string } => typeof entry.log === "string")
				.map((entry) => parseLoopRunLog(entry.log));
			result = applyVerifierReport(state, valid.report, { acceptedLogs });
		} catch (error) {
			block(String(error));
			return;
		}
		writeLoopStateFile(path, result.state);
		emitEffects(pi, result.state, result.effects);
		if (result.state.stage === "done" || result.state.stage === "classify") {
			pi.sendUserMessage(`LOOPS stage: ${result.state.stage}`, {
				deliverAs: "followUp",
				streamingBehavior: "followUp",
			});
		}
		return;
	}
	const role = roleForAgent(raw.agent);
	if (!role || !state.dispatchedAdvisors.includes(role)) return;
	if (state.stage !== "advise" && state.stage !== "architecture-review") return;
	let gitState: GitState;
	try {
		gitState = currentGitForState(ctx.cwd, state);
	} catch (error) {
		const blocked = blockForGitFailure(state, String(error));
		writeLoopStateFile(path, blocked.state);
		emitEffects(pi, blocked.state, blocked.effects);
		return;
	}
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
		description: "Start and advance an explicit LOOPS graph: start, answer, plan, approve, build",
		handler: async (args, ctx) => handleLoopCommand(pi, args, ctx),
	});

	pi.registerTool({
		name: "loop_record_build",
		label: "Record loop build evidence",
		description:
			"Record LOOPS build evidence after explicit /loop build: test files, red run log, green run log, and optional verifier rerun budget.",
		promptSnippet:
			"loop_record_build: after /loop build, record testFiles plus redRunLog and greenRunLog from red-then-green checks",
		parameters: Type.Object(
			{
				testFiles: Type.Array(Type.String({ minLength: 1 })),
				redRunLog: Type.String({ minLength: 1 }),
				greenRunLog: Type.String({ minLength: 1 }),
				maxVerifierRerunMs: Type.Optional(Type.Number()),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const checkout = checkoutGit(ctx.cwd);
			const path = statePathFor({ ...checkout, baseRef: "", baseHead: "" });
			const state = readLoopStateFile(path);
			const gitState = currentGitForState(ctx.cwd, state);
			const stale = blockIfBuildOrVerifyStale(ctx.cwd, path, state, gitState);
			if (stale) {
				emitEffects(pi, stale.state, stale.effects);
				return {
					content: [{ type: "text", text: `stage: ${stale.state.stage}\nstale block recorded` }],
					details: stale.state,
				};
			}
			const p = params as {
				testFiles: string[];
				redRunLog: string;
				greenRunLog: string;
				maxVerifierRerunMs?: number;
			};
			const next = recordBuildFromParams(pi, ctx, path, state, p);
			return {
				content: [{ type: "text", text: `stage: ${next.stage}` }],
				details: next,
			};
		},
	});

	pi.registerTool({
		name: "loop_status",
		label: "Loop status",
		description: "Read the current LOOPS runner state for this worktree and branch.",
		promptSnippet: "loop_status: read the current LOOPS runner stage and frozen brief status",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const checkout = checkoutGit(ctx.cwd);
			const { state } = loadExistingCurrentState(checkout);
			return loopStatus(ctx.cwd, state);
		},
	});

	pi.on("message_end", (event, ctx) => {
		const result = subagentResultFromMessageEnd(event);
		if (!result) return undefined;
		return handleSubagentResult(pi, result, ctx);
	});
}
