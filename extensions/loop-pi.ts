/**
 * Thin Pi wiring for the LOOPS runner. State transitions stay in loop.ts.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Type } from "typebox";
import { worktreeClean } from "./git-status.ts";
import { grimoireDir, grimoireStoreStatus, writeProposal } from "./grimoire.ts";
import { type HelperReport, validateHelperReport } from "./helper-report.ts";
import {
	ADVISE_CAP_ASSUMPTION_PREFIX,
	ADVISOR_ROLES,
	type AdvisorRole,
	advisorTask,
	answerLoopQuestion,
	applyAdvisorReport,
	applyLeadPlan,
	applyVerifierReport,
	approveBrief,
	blockForAdvisorIntakeFailure,
	blockForBuildEvidenceFailure,
	blockForGitFailure,
	blockForStaleState,
	blockForVerifierIntakeFailure,
	confirmNewInformation,
	denyNewInformation,
	diffHash,
	type LoopEffect,
	type LoopState,
	type LoopTestHash,
	loopMetricsLine,
	recordAdvisorStarted,
	recordBlockAnswer,
	recordBuildEvidence,
	recordReworkProposal,
	replaceBlockWithStale,
	resumeLoop,
	reworkProposal,
	roleForAgent,
	staleReason,
	staleReasonText,
	startBuild,
	startLoop,
	tokensFromSubagentResult,
} from "./loop.ts";

export {
	abandonLoopStateFile,
	loopStatePath,
	readLoopMetricStateFiles,
	readLoopStateFile,
	writeLoopStateFile,
} from "./loop-state.ts";

import {
	abandonLoopStateFile,
	loopStatePath,
	readLoopMetricStateFiles,
	readLoopStateFile,
	writeLoopStateFile,
} from "./loop-state.ts";
import { EXIT_MARKER, HEADER_MARKER, hashFiles, type RunMeta, readRun, readRunHeader, shellQuote } from "./runs.ts";
import { childAgent, objectRecord, subagentChildren } from "./subagent-tools.ts";

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
	"usage: /loop start [--base <ref>] <task> | /loop answer <answer> | /loop plan <plan> | /loop approve <summary> | /loop build | /loop record-build <json> | /loop resume | /loop abandon [reason] | /loop confirm-new-info | /loop deny-new-info [reason] | /loop status";
const LOOP_VERBS = [
	"start",
	"answer",
	"plan",
	"approve",
	"build",
	"record-build",
	"resume",
	"abandon",
	"confirm-new-info",
	"deny-new-info",
	"status",
] as const;
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

interface ToolCall {
	toolName?: unknown;
	input?: unknown;
}

function profileDir(): string {
	if (process.env.PI_CODING_AGENT_DIR?.trim()) return process.env.PI_CODING_AGENT_DIR.trim();
	const dir = grimoireDir({ ...process.env, SITRA_GRIMOIRE: undefined });
	return dirname(dir);
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

function gitMaybe(cwd: string, args: string[]): string | undefined {
	try {
		const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
		return out || undefined;
	} catch {
		return undefined;
	}
}

function isInsideWorkTree(cwd: string): boolean {
	return gitMaybe(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

function testHashes(cwd: string, files: string[]): LoopTestHash[] {
	return hashFiles(git(cwd, ["rev-parse", "--show-toplevel"]), files);
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

function runsDir(): string {
	return join(profileDir(), "runs");
}

function runId(label: string): string {
	const slug = label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40);
	return `${new Date().toISOString().replace(/[:.]/g, "-")}-${slug}`;
}

function runLogForId(runId: string): string {
	if (!runId || runId.includes("/") || runId.includes("\\"))
		throw new Error("run id must be a file id from run_in_pane");
	return join(runsDir(), `${runId}.log`);
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function frozenTestFiles(state: LoopState): string[] {
	return state.frozenBrief?.advisorRuns.testDesign?.acceptanceTestFiles ?? [];
}

function frozenTestCommands(state: LoopState): string[] {
	return state.frozenBrief?.advisorRuns.testDesign?.acceptanceTestCommands ?? [];
}

function buildEvidenceRecordingState(state: LoopState): LoopState {
	if (state.stage === "build") return state;
	if (state.stage === "blocked" && state.block?.kind === "build-evidence" && state.block.resumeStage === "build") {
		return {
			...state,
			stage: "build",
			block: undefined,
			build: { testFiles: [], testHashes: [], ...(state.build.evidence ? { evidence: state.build.evidence } : {}) },
			verifierRequest: undefined,
			dispatchedAdvisors: [],
		};
	}
	return state;
}

function blockProblems(state: LoopState): string[] {
	const problems = state.block?.problems ?? [];
	if (problems.length > 0) {
		return problems.flatMap((problem) => [`reason: ${problem.reason}`, `satisfy: ${problem.satisfy}`]);
	}
	const question = state.questions.find((item) => item.id === state.block?.questionId);
	if (!state.block || !question) return [];
	return [`block: ${state.block.kind}`, `reason: ${question.text}`, `satisfy: ${question.recommended}`];
}

function toolStageText(state: LoopState): string {
	return [`stage: ${state.stage}`, ...blockProblems(state)].join("\n");
}

function buildEvidenceProblem(reason: string, satisfy: string): { reason: string; satisfy: string } {
	return { reason, satisfy };
}

function hasTrailingLineContinuation(command: string): boolean {
	let index = command.length - 1;
	while (index >= 0) {
		const char = command[index] ?? "";
		if (char !== " " && char !== "\t" && char !== "\n" && char !== "\r") break;
		index -= 1;
	}
	return command[index] === "\\";
}

function isDecisionBlock(state: LoopState): boolean {
	const kind = state.block?.kind;
	return (
		kind === "new-information" ||
		kind === "new-information-denied" ||
		kind === "rework-learning" ||
		kind === "same-rework-class" ||
		kind === "second-rework"
	);
}

function answerBuildEvidenceQuestions(state: LoopState): LoopState {
	return {
		...state,
		questions: state.questions.filter((question) => question.id !== "build-evidence"),
	};
}

function testsOnlyAncestorProblem(
	cwd: string,
	testFiles: string[],
	testHashes: LoopTestHash[],
	redCommit: string,
): { reason: string; satisfy: string } | undefined {
	const satisfy = `Split the red commit so its own diff from its parent touches only: ${testFiles.join(", ")}.`;
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", redCommit, "HEAD"], { cwd, stdio: "ignore" });
	} catch {
		return buildEvidenceProblem(`red run commit ${redCommit} is not an ancestor of HEAD`, satisfy);
	}
	if (redCommit === currentCommit(cwd))
		return buildEvidenceProblem(
			"red run commit is HEAD, not a tests-only ancestor",
			"Use the tests-only commit for red evidence, not the build commit.",
		);
	let changed: string[];
	try {
		const parent = git(cwd, ["rev-parse", `${redCommit}^`]);
		changed = execFileSync("git", ["diff", "--name-only", parent, redCommit], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		})
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
	} catch (error) {
		return buildEvidenceProblem(`red commit diff from its parent could not be checked: ${String(error)}`, satisfy);
	}
	const allowed = new Set(testFiles);
	const extra = changed.filter((file) => !allowed.has(file));
	if (extra.length > 0)
		return buildEvidenceProblem(`red commit changes non-acceptance files: ${extra.join(", ")}`, satisfy);
	for (const expected of testHashes) {
		if (!expected.sha256) return buildEvidenceProblem(`test file ${expected.file} is missing in the worktree`, satisfy);
		let raw: string;
		try {
			raw = execFileSync("git", ["show", `${redCommit}:${expected.file}`], {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch {
			return buildEvidenceProblem(`test file ${expected.file} does not exist at red run commit ${redCommit}`, satisfy);
		}
		const actual = createHash("sha256").update(raw).digest("hex");
		if (actual !== expected.sha256)
			return buildEvidenceProblem(
				`test file ${expected.file} has a different hash at red run commit ${redCommit}`,
				satisfy,
			);
	}
	return undefined;
}

function parseLoopRunLog(log: string): {
	log: string;
	done: boolean;
	exitCode?: number;
	command?: string;
	loop?: { commit: string; testHashes: LoopTestHash[] };
} {
	const raw = readFileSync(log, "utf8");
	const status = readRun(raw);
	const firstLine = raw.split("\n")[0] ?? "";
	const header = readRunHeader(firstLine);
	const loop = header?.meta.loop;
	return {
		log,
		done: status.done,
		...(status.exitCode !== undefined ? { exitCode: status.exitCode } : {}),
		...(header?.meta.command ? { command: header.meta.command } : {}),
		...(loop ? { loop } : {}),
	};
}

function linkNodeModules(sourceWorktree: string, runWorktree: string): void {
	const source = join(sourceWorktree, "node_modules");
	const target = join(runWorktree, "node_modules");
	if (!existsSync(source) || existsSync(target)) return;
	symlinkSync(source, target, "dir");
}

function evidenceCommand(command: string, log: string, meta: RunMeta): string {
	const q = shellQuote(log);
	const nonce = createHash("sha256").update(`${Date.now()}:${Math.random()}:${log}`).digest("hex").slice(0, 16);
	const metaJson = shellQuote(JSON.stringify({ ...meta, nonce }));
	const header = shellQuote(HEADER_MARKER);
	const exitPrefix = `${EXIT_MARKER}${nonce}=`;
	const script = `printf '%s{"pid":%s,"meta":%s}\\n' ${header} "$$" ${metaJson} > ${q}; { ${command}\n\n} 2>&1 | tee -a ${q}; code=\${PIPESTATUS[0]}; echo "${exitPrefix}\${code}" >> ${q}; exit "\${code}"`;
	return script;
}

function spawnEvidenceCommand(input: {
	commandLine: string;
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<{ code: number | undefined; signal: NodeJS.Signals | null }> {
	return new Promise((resolve, reject) => {
		if (input.signal?.aborted) {
			reject(new Error("loop evidence command aborted"));
			return;
		}
		const child = spawn("bash", ["-c", input.commandLine], { cwd: input.cwd, detached: true, stdio: "ignore" });
		let settled = false;
		let timedOut = false;
		let aborted = false;
		let killError: Error | undefined;
		let forceTimer: NodeJS.Timeout | undefined;
		let rejectTimer: NodeJS.Timeout | undefined;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (forceTimer) clearTimeout(forceTimer);
			if (rejectTimer) clearTimeout(rejectTimer);
			input.signal?.removeEventListener("abort", abort);
			fn();
		};
		const signalGroup = (signal: NodeJS.Signals) => {
			if (!child.pid) return;
			try {
				process.kill(-child.pid, signal);
			} catch (error) {
				killError = new Error(`could not send ${signal} to loop evidence process group ${child.pid}: ${String(error)}`);
			}
		};
		const kill = () => {
			signalGroup("SIGTERM");
			forceTimer = setTimeout(() => {
				signalGroup("SIGKILL");
			}, 100);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, input.timeoutMs);
		const abort = () => {
			aborted = true;
			kill();
		};
		input.signal?.addEventListener("abort", abort, { once: true });
		child.on("error", (error) => finish(() => reject(error)));
		child.on("exit", (code, signal) => {
			if (killError) {
				finish(() => reject(killError));
				return;
			}
			if (timedOut) {
				signalGroup("SIGKILL");
				rejectTimer = setTimeout(
					() => finish(() => reject(new Error(`loop evidence command timed out after ${input.timeoutMs}ms`))),
					100,
				);
				return;
			}
			if (aborted) {
				signalGroup("SIGKILL");
				rejectTimer = setTimeout(() => finish(() => reject(new Error("loop evidence command aborted"))), 100);
				return;
			}
			finish(() => resolve({ code: code ?? undefined, signal }));
		});
	});
}

async function runEvidenceInWorktree(input: {
	cwd: string;
	state: LoopState;
	phase: "red" | "green";
	commit: string;
	command: string;
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<{
	runId: string;
	log: string;
	exitCode: number;
	commit: string;
	testHashes: LoopTestHash[];
	sha256: string;
	command: string;
}> {
	const sourceWorktree = git(input.cwd, ["rev-parse", "--show-toplevel"]);
	const buildCommit = currentCommit(input.cwd);
	const requestedCommit = git(input.cwd, ["rev-parse", input.commit]);
	if (input.phase === "green" && requestedCommit !== buildCommit) {
		throw new Error(`green evidence commit must be the current build commit ${buildCommit}`);
	}
	const testFiles = frozenTestFiles(input.state);
	if (testFiles.length === 0) throw new Error("active loop build has no frozen acceptance test files");
	const commands = frozenTestCommands(input.state);
	if (commands.length === 0) throw new Error("frozen brief has no agreed acceptance commands");
	if (!commands.includes(input.command)) {
		throw new Error(`command is not an agreed loop acceptance command: ${input.command}`);
	}
	if (hasTrailingLineContinuation(input.command)) {
		throw new Error("agreed loop acceptance command ends with a trailing line-continuation backslash");
	}
	mkdirSync(runsDir(), { recursive: true });
	const id = runId(`loop-${input.phase}-evidence`);
	const log = runLogForId(id);
	const tempParent = mkdtempSync(join(tmpdir(), "sitra-loop-evidence-"));
	const tempWorktree = join(tempParent, "worktree");
	let added = false;
	try {
		execFileSync("git", ["worktree", "add", "--detach", tempWorktree, requestedCommit], {
			cwd: sourceWorktree,
			stdio: ["ignore", "pipe", "pipe"],
		});
		added = true;
		linkNodeModules(sourceWorktree, tempWorktree);
		const actualCommit = currentCommit(tempWorktree);
		const hashes = hashFiles(tempWorktree, testFiles);
		const missing = hashes.find((item) => item.missing);
		if (missing)
			throw new Error(`test file ${missing.file} does not exist at ${input.phase} evidence commit ${actualCommit}`);
		const line = evidenceCommand(input.command, log, {
			label: `loop ${input.phase} evidence`,
			project: basename(sourceWorktree),
			branch: input.state.branch,
			agent: "loop-runner",
			command: input.command,
			loop: { commit: actualCommit, testHashes: hashes },
		});
		const childStatus = await spawnEvidenceCommand({
			commandLine: line,
			cwd: tempWorktree,
			timeoutMs: input.timeoutMs,
			signal: input.signal,
		});
		const status = readRun(readFileSync(log, "utf8"));
		if (!status.done || status.exitCode === undefined || Number.isNaN(status.exitCode)) {
			throw new Error(`loop ${input.phase} evidence did not record an exit code`);
		}
		if (childStatus.signal) throw new Error(`loop ${input.phase} evidence ended by signal ${childStatus.signal}`);
		if (childStatus.code !== status.exitCode) {
			throw new Error(
				`loop ${input.phase} evidence child exit ${childStatus.code ?? "unknown"} did not match log exit ${status.exitCode}`,
			);
		}
		return {
			runId: id,
			log,
			exitCode: status.exitCode,
			commit: actualCommit,
			testHashes: hashes,
			sha256: sha256File(log),
			command: input.command,
		};
	} finally {
		if (added) {
			try {
				execFileSync("git", ["worktree", "remove", "--force", tempWorktree], {
					cwd: sourceWorktree,
					stdio: "ignore",
				});
			} catch {
				try {
					execFileSync("git", ["worktree", "prune"], { cwd: sourceWorktree, stdio: "ignore" });
				} catch {
					// The rmSync below still removes the temporary directory if Git has already detached it.
				}
			}
		}
		rmSync(tempParent, { recursive: true, force: true });
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

function checkoutGit(cwd: string): Omit<GitState, "baseRef" | "baseHead"> {
	return {
		worktree: git(cwd, ["rev-parse", "--show-toplevel"]),
		branch: git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
	};
}

function checkoutGitForLoopLookup(cwd: string): Omit<GitState, "baseRef" | "baseHead"> | undefined {
	if (!isInsideWorkTree(cwd)) return undefined;
	const worktree = gitMaybe(cwd, ["rev-parse", "--show-toplevel"]);
	const branch = gitMaybe(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	if (!worktree || !branch) return undefined;
	return { worktree, branch };
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

function loadCurrentLoopStateIfExists(cwd: string): { path: string; state: LoopState } | undefined {
	const checkout = checkoutGitForLoopLookup(cwd);
	if (!checkout) return undefined;
	const path = statePathFor({ ...checkout, baseRef: "", baseHead: "" });
	if (!existsSync(path)) return undefined;
	return { path, state: readLoopStateFile(path) };
}

function loadMutableState(gitState: GitState): LoopState {
	const path = statePathFor(gitState);
	const state = readLoopStateFile(path);
	const reason = staleReason(state, { branch: gitState.branch, baseHead: gitState.baseHead });
	if (!reason) return state;
	const blocked = blockForStaleState(state, { branch: gitState.branch, baseHead: gitState.baseHead });
	writeLoopStateFile(path, blocked.state);
	throw new Error(`loop state is stale: ${staleReasonText(reason)}`);
}

function blockIfBuildOrVerifyStale(
	cwd: string,
	path: string,
	state: LoopState,
	gitState: GitState,
): { state: LoopState; effects: LoopEffect[] } | undefined {
	const baseReason = staleReason(state, { branch: gitState.branch, baseHead: gitState.baseHead });
	if (baseReason) {
		const blocked = blockForStaleState(state, { branch: gitState.branch, baseHead: gitState.baseHead });
		writeLoopStateFile(path, blocked.state);
		return blocked;
	}
	if (state.build.testFiles.length === 0 && !state.verifierRequest) return undefined;
	if (state.stage === "verify" && !worktreeClean(cwd)) {
		const blocked = blockForStaleState(state, {
			branch: gitState.branch,
			baseHead: gitState.baseHead,
			dirtyWorktree: true,
		});
		writeLoopStateFile(path, blocked.state);
		return blocked;
	}
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

function advisorWaitLines(state: LoopState): string[] {
	const dispatchEffect = resumeLoop(state).effects.find(
		(effect): effect is Extract<LoopEffect, { type: "dispatch-advisors" }> => effect.type === "dispatch-advisors",
	);
	const pendingTasks = new Map((dispatchEffect?.advisors ?? []).map((advisor) => [advisor.role, advisor.task]));
	const started = new Set(state.startedAdvisors ?? []);
	const roles = ADVISOR_ROLES.filter((role) => pendingTasks.has(role) || state.advisorRuns[advisorKeyForStatus(role)]);
	if (roles.length === 0) return [];
	return [
		"awaited advisors:",
		...roles.flatMap((role) => {
			const task = pendingTasks.get(role);
			if (!task) return [`- ${advisorName(role)}: reported through helper_report`];
			return [
				`- ${advisorName(role)}: ${started.has(role) ? "started, awaiting helper_report" : "not started"}`,
				`${advisorName(role)} has not reported through helper_report. If the lead wrote a summary instead, that does not count; it must be started with this exact runner task:`,
				task,
			];
		}),
	];
}

function advisorKeyForStatus(role: AdvisorRole): keyof LoopState["advisorRuns"] {
	return role === "test-design" ? "testDesign" : role;
}

function adviseAssumptionLines(state: LoopState): string[] {
	const assumptions = Object.values(state.advisorRuns)
		.flatMap((run) => run?.assumptions ?? [])
		.filter((assumption) => assumption.startsWith(ADVISE_CAP_ASSUMPTION_PREFIX));
	if (assumptions.length === 0) return [];
	return ["advise assumptions:", ...assumptions.map((assumption) => `- ${assumption}`)];
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
		return "LOOPS advisors are complete. Write the high-level lead plan, then call loop_submit_plan with the plan text. The equivalent human slash command is `/loop plan <plan>`.";
	if (effect.type === "dispatch-verifier")
		return [
			"LOOPS runner dispatch for stage verify:",
			"Start verifier in a fresh context with this exact task. Do not add the builder transcript or any helper brief.",
			effect.task,
		].join("\n");
	if (effect.type === "write-grimoire-proposal")
		return `LOOPS classified rework ${effect.reworkIndex + 1}; drafting a Grimoire proposal for review.`;
	return `LOOPS stage: brief-approved\nFrozen brief hash: ${state.frozenBriefHash ?? "(missing)"}`;
}

function emitEffects(pi: Pi, state: LoopState, effects: LoopEffect[]): void {
	for (const effect of effects)
		pi.sendUserMessage(renderEffect(state, effect), { deliverAs: "followUp", streamingBehavior: "followUp" });
}

function materializeEffects(state: LoopState, effects: LoopEffect[]): { state: LoopState; effects: LoopEffect[] } {
	let current = state;
	const rendered: LoopEffect[] = [];
	for (const effect of effects) {
		if (effect.type !== "write-grimoire-proposal") {
			rendered.push(effect);
			continue;
		}
		const proposalPath = writeProposal(
			grimoireDir(process.env),
			reworkProposal(current, effect.reworkIndex, new Date().toISOString()),
		);
		const recorded = recordReworkProposal(current, { reworkIndex: effect.reworkIndex, proposalPath });
		current = recorded.state;
		rendered.push(...recorded.effects);
	}
	return { state: current, effects: rendered };
}

function persistAndEmit(pi: Pi, path: string, result: { state: LoopState; effects: LoopEffect[] }): LoopState {
	const materialized = materializeEffects(result.state, result.effects);
	writeLoopStateFile(path, materialized.state);
	emitEffects(pi, materialized.state, materialized.effects);
	return materialized.state;
}

function nextExpectedAction(state: LoopState, effects: LoopEffect[]): string {
	const dispatch = effects.find(
		(effect): effect is Extract<LoopEffect, { type: "dispatch-advisors" }> => effect.type === "dispatch-advisors",
	);
	if (dispatch) {
		return `start ${dispatch.advisors.map((advisor) => advisorName(advisor.role)).join(", ")} with the exact runner task and wait for helper_report`;
	}
	if (effects.some((effect) => effect.type === "write-lead-plan")) return "submit the lead plan with loop_submit_plan";
	if (effects.some((effect) => effect.type === "dispatch-verifier")) {
		return "start verifier with the exact runner task and wait for helper_report";
	}
	const askPerson = effects.find(
		(effect): effect is Extract<LoopEffect, { type: "ask-person" }> => effect.type === "ask-person",
	);
	if (askPerson?.reason === "brief-approval") return "person types /loop approve <summary>";
	if (askPerson) return "wait for the person's next /loop answer";
	if (state.stage === "build") return "start new red and green runs with loop_run_evidence";
	if (state.stage === "brief-approved") return "start implementation with /loop build";
	if (state.stage === "architecture-review") return "wait for architecture-advisor helper_report or person approval";
	if (state.stage === "plan") return "submit the lead plan with loop_submit_plan";
	if (state.stage === "verify") return "wait for verifier helper_report";
	if (state.stage === "done") return "loop is done";
	throw new Error(`no next expected action for unhandled LOOPS stage ${state.stage}`);
}

function emitUnblockNotice(pi: Pi, before: LoopState, answer: string, after: LoopState, effects: LoopEffect[]): void {
	if (!before.block || after.block) return;
	const nextAction =
		before.block.kind === "build-evidence" && after.stage === "build"
			? "start new red and green runs with loop_run_evidence"
			: nextExpectedAction(after, effects);
	pi.sendUserMessage(
		[`LOOPS stage: ${after.stage}`, `person answered: ${answer}`, `next expected action: ${nextAction}`].join("\n"),
		{ deliverAs: "followUp", streamingBehavior: "followUp" },
	);
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
	let stale = staleReason(state, { branch: gitState.branch, baseHead: gitState.baseHead });
	if (!stale) {
		try {
			stale = staleReason(state, {
				branch: gitState.branch,
				baseHead: gitState.baseHead,
				...(state.build.testFiles.length > 0 ? { testHashes: testHashes(cwd, state.build.testFiles) } : {}),
				...(state.verifierRequest
					? { ...(worktreeClean(cwd) ? { diffHash: diffHash(diffAgainstBase(cwd, state)) } : { dirtyWorktree: true }) }
					: {}),
			});
		} catch (error) {
			stale = { kind: "test-hashes", detail: `test hashes could not be checked: ${String(error)}` };
		}
	}
	const metrics = readLoopMetricStateFiles(profileDir());
	const rejectedVerifierReports = state.rejectedVerifierReports ?? [];
	return {
		content: [
			{
				type: "text",
				text: [
					`stage: ${state.stage}`,
					`goal: ${state.goal}`,
					loopMetricsLine(metrics.states),
					...advisorWaitLines(state),
					...adviseAssumptionLines(state),
					...(metrics.badFiles.length ? [`loop metrics unreadable: ${metrics.badFiles.join(", ")}`] : []),
					...(rejectedVerifierReports.length
						? [
								"rejected verifier reports:",
								...rejectedVerifierReports.map((report) => `- ${report.display}: ${report.reason}`),
							]
						: []),
					...(stale ? [`stale: ${stale.kind === "test-hashes" ? "test hashes" : staleReasonText(stale)}`] : []),
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
	params: { redRunId: string; greenRunId: string; maxVerifierRerunMs?: number },
): LoopState {
	const recordingState = buildEvidenceRecordingState(state);
	if (recordingState.stage !== "build") throw new Error(`cannot record build evidence while stage is ${state.stage}`);
	if (!worktreeClean(ctx.cwd)) {
		const blocked = blockForBuildEvidenceFailure(
			recordingState,
			"worktree must be clean before recording build evidence",
		);
		writeLoopStateFile(path, blocked.state);
		emitEffects(pi, blocked.state, blocked.effects);
		return blocked.state;
	}
	const testFiles = frozenTestFiles(recordingState);
	const hashes = testHashes(ctx.cwd, testFiles);
	const evidence = recordingState.build.evidence ?? [];
	const redEvidence = evidence.find((item) => item.runId === params.redRunId && item.phase === "red");
	if (!redEvidence) {
		const blocked = blockForBuildEvidenceFailure(
			recordingState,
			buildEvidenceProblem(
				`red evidence run id ${params.redRunId} was not recorded by loop_run_evidence`,
				"Run red evidence with loop_run_evidence and pass the returned red runId.",
			),
		);
		writeLoopStateFile(path, blocked.state);
		emitEffects(pi, blocked.state, blocked.effects);
		return blocked.state;
	}
	const greenEvidence = evidence.find((item) => item.runId === params.greenRunId && item.phase === "green");
	if (!greenEvidence) {
		const blocked = blockForBuildEvidenceFailure(
			recordingState,
			buildEvidenceProblem(
				`green evidence run id ${params.greenRunId} was not recorded by loop_run_evidence`,
				"Run green evidence with loop_run_evidence and pass the returned green runId.",
			),
		);
		writeLoopStateFile(path, blocked.state);
		emitEffects(pi, blocked.state, blocked.effects);
		return blocked.state;
	}
	const redLogPath = runLogForId(params.redRunId);
	const redHash = sha256File(redLogPath);
	if (redHash !== redEvidence.sha256) {
		const blocked = blockForBuildEvidenceFailure(
			recordingState,
			buildEvidenceProblem(
				`red evidence run id ${params.redRunId} log hash changed`,
				"Rerun red evidence with loop_run_evidence and pass the new runId.",
			),
		);
		writeLoopStateFile(path, blocked.state);
		emitEffects(pi, blocked.state, blocked.effects);
		return blocked.state;
	}
	const greenLogPath = runLogForId(params.greenRunId);
	const greenHash = sha256File(greenLogPath);
	if (greenHash !== greenEvidence.sha256) {
		const blocked = blockForBuildEvidenceFailure(
			recordingState,
			buildEvidenceProblem(
				`green evidence run id ${params.greenRunId} log hash changed`,
				"Rerun green evidence with loop_run_evidence and pass the new runId.",
			),
		);
		writeLoopStateFile(path, blocked.state);
		emitEffects(pi, blocked.state, blocked.effects);
		return blocked.state;
	}
	if (redEvidence.command !== greenEvidence.command) {
		const blocked = blockForBuildEvidenceFailure(
			recordingState,
			buildEvidenceProblem(
				"red and green evidence used different agreed commands",
				"Rerun red and green evidence with the same frozen test-design command.",
			),
		);
		writeLoopStateFile(path, blocked.state);
		emitEffects(pi, blocked.state, blocked.effects);
		return blocked.state;
	}
	const redRun = parseLoopRunLog(runLogForId(params.redRunId));
	const greenRun = parseLoopRunLog(runLogForId(params.greenRunId));
	if (redRun.loop?.commit) {
		const ancestorProblem = testsOnlyAncestorProblem(ctx.cwd, testFiles, hashes, redRun.loop.commit);
		if (ancestorProblem) {
			const blocked = blockForBuildEvidenceFailure(recordingState, ancestorProblem);
			writeLoopStateFile(path, blocked.state);
			emitEffects(pi, blocked.state, blocked.effects);
			return blocked.state;
		}
	}
	const result = recordBuildEvidence(recordingState, {
		commit: currentCommit(ctx.cwd),
		diff: diffAgainstBase(ctx.cwd, recordingState),
		testFiles,
		testHashes: hashes,
		redRun,
		greenRun,
		dispatchId: createHash("sha256").update(`${Date.now()}:${Math.random()}:${path}`).digest("hex"),
		maxVerifierRerunMs: params.maxVerifierRerunMs ?? 120_000,
	});
	const nextState = result.state.stage === "verify" ? answerBuildEvidenceQuestions(result.state) : result.state;
	writeLoopStateFile(path, nextState);
	emitEffects(pi, nextState, result.effects);
	return nextState;
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
		persistAndEmit(pi, path, result);
		return;
	}
	const checkout = checkoutGit(ctx.cwd);
	const { path, state: currentState } = loadExistingCurrentState(checkout);
	if (verb === "abandon") {
		abandonLoopStateFile(path, currentState, rest);
		const message = `Abandoned loop on ${currentState.branch} in ${currentState.worktree}.`;
		if (ctx.ui?.notify) ctx.ui.notify(message, "info");
		else pi.sendUserMessage(message, { deliverAs: "followUp", streamingBehavior: "followUp" });
		return;
	}
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
	if (verb === "resume") {
		if (rest) throw new Error(LOOP_USAGE);
		const stale = blockIfBuildOrVerifyStale(ctx.cwd, path, currentState, gitState);
		if (stale) {
			emitEffects(pi, stale.state, stale.effects);
			return;
		}
		persistAndEmit(pi, path, resumeLoop(currentState));
		return;
	}
	if (verb === "confirm-new-info") {
		if (rest) throw new Error(LOOP_USAGE);
		persistAndEmit(pi, path, confirmNewInformation(loadMutableState(gitState)));
		return;
	}
	if (verb === "deny-new-info") {
		persistAndEmit(pi, path, denyNewInformation(loadMutableState(gitState), rest));
		return;
	}
	if (verb === "answer") {
		if (!rest) throw new Error(LOOP_USAGE);
		const rawState = currentState;
		const isStaleAnswer = rawState.stage === "blocked" && rawState.block?.kind === "stale";
		if (!isStaleAnswer && rawState.block) {
			const staleReasonBeforeAnswer = staleReason(rawState, { branch: gitState.branch, baseHead: gitState.baseHead });
			const answered =
				staleReasonBeforeAnswer && isDecisionBlock(rawState) ? rawState : recordBlockAnswer(rawState, rest);
			writeLoopStateFile(path, answered);
			const stale = replaceBlockWithStale(answered, { branch: gitState.branch, baseHead: gitState.baseHead });
			if (stale.effects.length > 0) {
				writeLoopStateFile(path, stale.state);
				emitEffects(pi, stale.state, stale.effects);
				return;
			}
			const result = answerLoopQuestion(answered, { answer: rest, current: gitState });
			const next = persistAndEmit(pi, path, result);
			emitUnblockNotice(pi, rawState, rest, next, result.effects);
			return;
		}
		const state = isStaleAnswer ? rawState : loadMutableState(gitState);
		const result = answerLoopQuestion(state, { answer: rest, current: gitState });
		const next = persistAndEmit(pi, path, result);
		emitUnblockNotice(pi, state, rest, next, result.effects);
		return;
	}
	if (verb === "plan") {
		if (!rest) throw new Error(LOOP_USAGE);
		const result = applyLeadPlan(loadMutableState(gitState), rest);
		persistAndEmit(pi, path, result);
		return;
	}
	if (verb === "approve") {
		if (!rest) throw new Error(LOOP_USAGE);
		const result = approveBrief(loadMutableState(gitState), {
			approvedBy: "person",
			approvedAt: new Date().toISOString(),
			summary: rest,
		});
		persistAndEmit(pi, path, result);
		return;
	}
	if (verb === "build") {
		if (rest) throw new Error(LOOP_USAGE);
		const result = startBuild(loadMutableState(gitState));
		persistAndEmit(pi, path, result);
		pi.sendUserMessage(
			[
				"LOOPS stage: build",
				"Evidence recipe: commit the acceptance tests alone, run red evidence at that commit with loop_run_evidence, implement, then run green evidence at the build commit with loop_run_evidence. Record both run ids with loop_record_build.",
			].join("\n"),
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
			redRunId?: unknown;
			greenRunId?: unknown;
			maxVerifierRerunMs?: unknown;
		};
		if (
			typeof params.redRunId !== "string" ||
			typeof params.greenRunId !== "string" ||
			(params.maxVerifierRerunMs !== undefined && typeof params.maxVerifierRerunMs !== "number")
		) {
			throw new Error("invalid /loop record-build JSON: expected redRunId and greenRunId");
		}
		const next = recordBuildFromParams(pi, ctx, path, state, {
			redRunId: params.redRunId,
			greenRunId: params.greenRunId,
			...(typeof params.maxVerifierRerunMs === "number" ? { maxVerifierRerunMs: params.maxVerifierRerunMs } : {}),
		});
		pi.sendUserMessage(`LOOPS stage: ${next.stage}`, { deliverAs: "followUp", streamingBehavior: "followUp" });
		return;
	}
}

async function handleSubagentResult(pi: Pi, event: unknown, ctx: Ctx): Promise<void> {
	if (!event || typeof event !== "object") return;
	const loaded = loadCurrentLoopStateIfExists(ctx.cwd);
	if (!loaded) return;
	const { path, state } = loaded;
	const raw = event as Record<string, unknown>;
	if (raw.agent === "verifier") {
		if (state.stage !== "verify") return;
		if (!state.verifierRequest) return;
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
		const block = (reason: string, rejection?: { report?: HelperReport; sessionFile?: string }) => {
			const blocked = blockForVerifierIntakeFailure(state, reason, rejection);
			writeLoopStateFile(path, blocked.state);
			emitEffects(pi, blocked.state, blocked.effects);
		};
		if (typeof raw.sessionFile !== "string" || !raw.sessionFile) {
			block("subagent_result is missing sessionFile", {});
			return;
		}
		let report: unknown;
		try {
			report = readHelperReport(raw.sessionFile);
		} catch (error) {
			block(String(error), { sessionFile: raw.sessionFile });
			return;
		}
		const valid = validateHelperReport(report);
		if (!valid.ok) {
			block(`invalid helper_report from ${raw.sessionFile}: ${valid.reason}`, { sessionFile: raw.sessionFile });
			return;
		}
		let result: { state: LoopState; effects: LoopEffect[] };
		let acceptedLogs: ReturnType<typeof parseLoopRunLog>[];
		try {
			const details = valid.report.details as { acceptedLogs?: { log?: unknown }[] } | undefined;
			acceptedLogs = (details?.acceptedLogs ?? [])
				.filter((entry): entry is { log: string } => typeof entry.log === "string")
				.map((entry) => parseLoopRunLog(entry.log));
		} catch (error) {
			block(String(error), { report: valid.report, sessionFile: raw.sessionFile });
			return;
		}
		try {
			result = applyVerifierReport(state, valid.report, { acceptedLogs });
		} catch (error) {
			block(String(error), { report: valid.report, sessionFile: raw.sessionFile });
			return;
		}
		let next: LoopState;
		try {
			next = persistAndEmit(pi, path, result);
		} catch (error) {
			block(`could not write Grimoire proposal: ${String(error)}`);
			return;
		}
		if (next.stage === "done" || next.stage === "blocked" || next.stage === "brief-approved") {
			pi.sendUserMessage(`LOOPS stage: ${next.stage}`, {
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
	persistAndEmit(pi, path, result);
}

function handleToolCall(event: ToolCall, ctx: Ctx): void {
	if (event?.toolName !== "subagent") return;
	const input = objectRecord(event.input);
	if (!input) return;
	const children = subagentChildren(input);
	if (!children) return;
	const loaded = loadCurrentLoopStateIfExists(ctx.cwd);
	if (!loaded) return;
	const { path, state } = loaded;
	const started: AdvisorRole[] = [];
	for (const child of children) {
		const role = roleForAgent(childAgent(child));
		if (!role || !state.dispatchedAdvisors.includes(role)) continue;
		if (child.task === advisorTask(state, role)) started.push(role);
	}
	if (started.length > 0) writeLoopStateFile(path, recordAdvisorStarted(state, started));
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
		name: "loop_run_evidence",
		label: "Run loop evidence",
		description:
			"Run LOOPS red or green evidence in a temporary detached git worktree at the named commit and return a run id for loop_record_build.",
		promptSnippet:
			"loop_run_evidence: run the agreed test command for red at the tests-only commit and green at the build commit",
		parameters: Type.Object(
			{
				phase: Type.Union([Type.Literal("red"), Type.Literal("green")]),
				commit: Type.String({ minLength: 1 }),
				command: Type.String({ minLength: 1 }),
				timeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const checkout = checkoutGit(ctx.cwd);
			const { path, state } = loadExistingCurrentState(checkout);
			const recordingState = buildEvidenceRecordingState(state);
			if (recordingState.stage !== "build") {
				throw new Error(`cannot run loop evidence while stage is ${state.stage}`);
			}
			let gitState: GitState;
			try {
				gitState = currentGitForState(ctx.cwd, recordingState);
			} catch (error) {
				const blocked = blockForGitFailure(state, String(error));
				writeLoopStateFile(path, blocked.state);
				emitEffects(pi, blocked.state, blocked.effects);
				return { content: [{ type: "text", text: toolStageText(blocked.state) }], details: blocked.state };
			}
			const stale = staleReason(recordingState, { branch: gitState.branch, baseHead: gitState.baseHead });
			if (stale) {
				const blocked = blockForStaleState(recordingState, { branch: gitState.branch, baseHead: gitState.baseHead });
				writeLoopStateFile(path, blocked.state);
				emitEffects(pi, blocked.state, blocked.effects);
				return { content: [{ type: "text", text: toolStageText(blocked.state) }], details: blocked.state };
			}
			const p = params as { phase: "red" | "green"; commit: string; command: string; timeoutMs?: number };
			const result = await runEvidenceInWorktree({
				cwd: ctx.cwd,
				state: recordingState,
				phase: p.phase,
				commit: p.commit,
				command: p.command,
				timeoutMs: p.timeoutMs ?? 120_000,
				...(signal ? { signal } : {}),
			});
			let latest: LoopState;
			try {
				latest = readLoopStateFile(path);
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `phase: ${p.phase}\ncommit: ${result.commit}\nexit: ${result.exitCode}\nrunId: ${result.runId}\nlog: ${result.log}\nnot recorded: loop state could not be read after the run finished (${String(error)})`,
						},
					],
					details: { ...result, recorded: false },
				};
			}
			const latestRecordingState = buildEvidenceRecordingState(latest);
			if (
				latestRecordingState.stage !== "build" ||
				(latestRecordingState.block && latestRecordingState.block.kind !== "build-evidence")
			) {
				return {
					content: [
						{
							type: "text",
							text: `phase: ${p.phase}\ncommit: ${result.commit}\nexit: ${result.exitCode}\nrunId: ${result.runId}\nlog: ${result.log}\nnot recorded: loop stage changed to ${latest.stage}`,
						},
					],
					details: { ...result, recorded: false },
				};
			}
			if (latestRecordingState.build.evidence?.some((item) => item.runId === result.runId)) {
				return {
					content: [
						{
							type: "text",
							text: `phase: ${p.phase}\ncommit: ${result.commit}\nexit: ${result.exitCode}\nrunId: ${result.runId}\nlog: ${result.log}\nnot recorded: evidence run id already exists in loop state`,
						},
					],
					details: { ...result, recorded: false },
				};
			}
			writeLoopStateFile(path, {
				...latestRecordingState,
				build: {
					...latestRecordingState.build,
					evidence: [
						...(latestRecordingState.build.evidence ?? []),
						{
							runId: result.runId,
							sha256: result.sha256,
							phase: p.phase,
							commit: result.commit,
							command: result.command,
							log: result.log,
						},
					],
				},
			});
			return {
				content: [
					{
						type: "text",
						text: [
							`phase: ${p.phase}`,
							`commit: ${result.commit}`,
							`exit: ${result.exitCode}`,
							`runId: ${result.runId}`,
							`log: ${result.log}`,
						].join("\n"),
					},
				],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "loop_record_build",
		label: "Record loop build evidence",
		description:
			"Record LOOPS build evidence after explicit /loop build: red run id, green run id, and optional verifier rerun budget.",
		promptSnippet:
			"loop_record_build: after /loop build, record redRunId and greenRunId from red-then-green run_in_pane checks",
		parameters: Type.Object(
			{
				redRunId: Type.String({ minLength: 1 }),
				greenRunId: Type.String({ minLength: 1 }),
				maxVerifierRerunMs: Type.Optional(Type.Number()),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const checkout = checkoutGit(ctx.cwd);
			const path = statePathFor({ ...checkout, baseRef: "", baseHead: "" });
			const state = readLoopStateFile(path);
			let gitState: GitState;
			try {
				gitState = currentGitForState(ctx.cwd, state);
			} catch (error) {
				const blocked = blockForGitFailure(state, String(error));
				writeLoopStateFile(path, blocked.state);
				emitEffects(pi, blocked.state, blocked.effects);
				return { content: [{ type: "text", text: toolStageText(blocked.state) }], details: blocked.state };
			}
			const stale = blockIfBuildOrVerifyStale(ctx.cwd, path, state, gitState);
			if (stale) {
				emitEffects(pi, stale.state, stale.effects);
				return {
					content: [{ type: "text", text: `${toolStageText(stale.state)}\nstale block recorded` }],
					details: stale.state,
				};
			}
			const p = params as {
				redRunId: string;
				greenRunId: string;
				maxVerifierRerunMs?: number;
			};
			if (typeof p.redRunId !== "string" || typeof p.greenRunId !== "string") {
				throw new Error("loop_record_build requires redRunId and greenRunId run id strings");
			}
			const next = recordBuildFromParams(pi, ctx, path, state, p);
			return {
				content: [{ type: "text", text: toolStageText(next) }],
				details: next,
			};
		},
	});

	pi.registerTool({
		name: "loop_submit_plan",
		label: "Submit loop lead plan",
		description:
			"Submit the lead-authored LOOPS plan after advisors are complete. This advances the same state transition as /loop plan with the same validation.",
		promptSnippet: "loop_submit_plan: submit the lead-authored /loop plan text when LOOPS asks for a plan",
		parameters: Type.Object(
			{
				plan: Type.String({ minLength: 1 }),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as { plan?: unknown };
			if (typeof p.plan !== "string" || !p.plan.trim()) throw new Error("loop_submit_plan requires plan text");
			const plan = p.plan.trim();
			const checkout = checkoutGit(ctx.cwd);
			const { path, state } = loadExistingCurrentState(checkout);
			let gitState: GitState;
			try {
				gitState = currentGitForState(ctx.cwd, state);
			} catch (error) {
				const blocked = blockForGitFailure(state, String(error));
				writeLoopStateFile(path, blocked.state);
				emitEffects(pi, blocked.state, blocked.effects);
				return { content: [{ type: "text", text: `stage: ${blocked.state.stage}` }], details: blocked.state };
			}
			const result = applyLeadPlan(loadMutableState(gitState), plan);
			const next = persistAndEmit(pi, path, result);
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

	const handlePossibleSubagentResult = (event: unknown, ctx: Ctx) => {
		const result = subagentResultFromMessageEnd(event);
		if (!result) return undefined;
		return handleSubagentResult(pi, result, ctx);
	};
	pi.on("tool_call", handleToolCall as never);
	pi.on("message_end", handlePossibleSubagentResult as never);
}
