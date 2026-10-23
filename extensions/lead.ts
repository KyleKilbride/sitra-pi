/**
 * sitra lead: the lead's working rules (only for the agent the person talks to, never for teammates), long runs in
 * visible herdr panes instead of blocking, and a "needs you" signal in herdr when a question is waiting.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Type } from "typebox";
import { dirtyFiles } from "./git-status.ts";
import { HELPER_REPORT_TOOL_SCHEMA, renderHelperReport, validateHelperReport } from "./helper-report.ts";
import { loopStatePath, readLoopStateFile } from "./loop-state.ts";
import { hashFiles, type RunMeta, readRun, startCommandInFreshPane, writeRunScript } from "./runs.ts";
import { gitBranch, mainCheckout } from "./sessions.ts";
import { SUBAGENT_LAUNCH_RULE } from "./subagent-tools.ts";

/** The lead's working rules, written for the person it works with (their name, or "the user"). */
export function leadRules(name?: string): string {
	const who = name?.trim() || "the user";
	const Who = who[0]?.toUpperCase() + who.slice(1);
	return `# You are the lead: the agent ${who} talks to

- **${Who}'s words are the spec.** If they say how to do something (the tool, the command, where it runs), do exactly that. If it can't work, say why in one line.
- **Plan, then go.** For anything bigger than a quick step, propose a short plan (a few lines) and wait for their go. Once they say go, carry the plan out without asking per step. Ask again only if something would change what they agreed.
- Before you ask ${who} anything, check Grimoire, related sessions and peer agents' reports, and say in one line what you checked. Decide engineering points yourself. Ask at most 3 at a time, in plain words with the context in the question.
- **Never leave them in the dark.** Before anything that takes more than a couple of minutes, say in one line what's starting. When a step finishes or the picture changes, tell them in two lines.
- **Never block.** Tests, evals, builds and installs run with run_in_pane, in a pane they can watch. Don't sleep or poll; check the run with check_run when you have nothing else to do or when they ask.
- **${Who}'s limits travel with the work.** No full unit-test or eval suites unless they asked for them; CI runs the rest. Put that, the goal and what "done" means into every teammate's task.
- **You do the building.** Write the code yourself, own the branch and the pull request. Hand the builder only small, fully specified pieces (specific files, clear instructions, little decision-making) that can run while you keep going.
- **Teammates:** scout (digging and history), builder (narrow targeted edits), app-tester (uses the app in Chrome and reads its real state), reviewer (diffs, tests, evals). Steer them only through the subagent tools; never type into their panes.
- ${SUBAGENT_LAUNCH_RULE}
- **LOOPS runner questions are ${who}'s.** Show them, stop, and wait for ${who}'s answer. Advisor summaries do not count as advisor reports; start the exact advisor task the runner gives and wait for helper_report. A /loop ${who} typed is permission to run the loop and its advisors; never ask for a separate go. When LOOPS asks for your plan, submit it with loop_submit_plan; approval still belongs only to ${who}'s typed /loop approve.
- **Read big files in parts** (grep, line ranges), never whole.
- **Grimoire:** its root and catalogue are in your prompt. Read an entry in full before acting on what it covers, and pass the ones that apply into every teammate's task. Propose what future agents need with grimoire_propose. Use Grimoire for approved memory; do not use a separate memory system for work state.
`;
}

function repoRoot(cwd: string): string {
	try {
		return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
	} catch {
		return cwd;
	}
}

function herdr(args: string[]): string {
	return execFileSync("herdr", args, { encoding: "utf8" });
}

function paneIdFromSplit(output: string): string | undefined {
	try {
		const value: unknown = JSON.parse(output);
		if (!value || typeof value !== "object") return undefined;
		const paneId = (value as { result?: { pane?: { pane_id?: unknown } } }).result?.pane?.pane_id;
		return typeof paneId === "string" && paneId ? paneId : undefined;
	} catch {
		return undefined;
	}
}

interface Ctx {
	cwd: string;
	isIdle?: () => boolean;
	sessionManager?: {
		getSessionId?(): string | undefined;
	};
}

interface Pi {
	on(
		event: "before_agent_start",
		handler: (event: { systemPromptOptions: { sections: Record<string, string> } }, ctx: Ctx) => unknown,
	): void;
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		promptSnippet?: string;
		parameters: unknown;
		execute(
			id: string,
			params: Record<string, unknown>,
			signal: unknown,
			onUpdate: unknown,
			ctx: Ctx,
		): Promise<{
			content: { type: "text"; text: string }[];
			details: unknown;
		}>;
	}): void;
	events: {
		on(channel: string, handler: (data: { active?: boolean }) => void): void;
		emit(channel: string, data: unknown): void;
	};
	sendMessage(
		message: { customType: string; content: string; display: boolean },
		options: { triggerTurn: boolean; deliverAs?: "followUp" | "steer" | "nextTurn" },
	): void;
}

export default function sitraLead(pi: Pi): void {
	const isTeammate = Boolean(process.env.PI_SUBAGENT_NAME);
	const isTower = process.env.SITRA_ROLE === "tower";
	pi.on("before_agent_start", (event: { systemPromptOptions: { sections: Record<string, string> } }, ctx) => {
		if (!isTeammate && !isTower)
			event.systemPromptOptions.sections["sitra-lead"] = leadRules(process.env.SITRA_USER_NAME);
		// Context files from folders above the repo (e.g. a workspace-wide CLAUDE.md mapping other projects) cost every
		// agent attention and aren't about this repo: keep only the repo's own and the profile's.
		const options = event.systemPromptOptions as unknown as { contextFiles?: { path: string }[] };
		const root = repoRoot(ctx.cwd);
		const profile = process.env.PI_CODING_AGENT_DIR ?? "";
		if (options.contextFiles) {
			options.contextFiles = options.contextFiles.filter(
				(f) => f.path.startsWith(root) || (profile && f.path.startsWith(profile)),
			);
		}
	});

	// A question waiting for the person shows as "blocked" in herdr, so they see that something needs them.
	pi.events.on("rpiv:ask-user:blocked", (data) => {
		pi.events.emit("herdr:blocked", { active: Boolean(data?.active), label: "waiting for your answer" });
	});

	// One run pane per agent, never a new pane per command. Runs reuse this pane (a run started while another is still
	// going queues behind it in the same shell), and it closes when the agent exits.
	let runPane: string | undefined;
	const paneAlive = (id: string): boolean => {
		try {
			herdr(["pane", "get", id]);
			return true;
		} catch {
			return false;
		}
	};
	process.once("exit", () => {
		if (!runPane) return;
		try {
			herdr(["pane", "close", runPane]);
		} catch {
			// Already closed.
		}
	});

	const runsDir = join(process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent"), "runs");

	const loopRunMeta = (cwd: string, branch?: string): { meta: Pick<RunMeta, "loop">; note?: string } => {
		if (!branch) return { meta: {} };
		const worktree = repoRoot(cwd);
		const profile = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
		const statePath = loopStatePath(profile, worktree, branch);
		if (!existsSync(statePath)) return { meta: {} };
		const state = readLoopStateFile(statePath);
		if (state.stage !== "build") {
			const note =
				state.stage === "blocked" && state.block
					? `not recorded as loop evidence: loop is blocked at ${state.block.resumeStage}`
					: `not recorded as loop evidence: loop stage is ${state.stage}`;
			return { meta: {}, note };
		}
		const testFiles = state.frozenBrief?.advisorRuns.testDesign?.acceptanceTestFiles ?? [];
		if (testFiles.length === 0) throw new Error("active loop build has no frozen acceptance test files");
		const dirty = dirtyFiles(cwd);
		if (dirty.length > 0) {
			throw new Error(
				[
					"active loop build run was not started: worktree must be clean before run_in_pane records loop evidence",
					"Dirty files:",
					...dirty.map((file) => `- ${file}`),
				].join("\n"),
			);
		}
		const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
		return { meta: { loop: { commit, testHashes: hashFiles(worktree, testFiles) } } };
	};

	if (isTeammate) {
		pi.registerTool({
			name: "helper_report",
			label: "Report helper result",
			description:
				"Return a helper or teammate result as structured fields: status, summary, evidence, open questions for the person, and assumptions. Role-specific reports set role and details.",
			promptSnippet:
				"helper_report: helpers can record validated status, summary, evidence, open questions for the person and assumptions; role-specific reports set role and details",
			parameters: HELPER_REPORT_TOOL_SCHEMA,
			async execute(_id, params) {
				const valid = validateHelperReport(params);
				if (!valid.ok) throw new Error(`invalid helper_report: ${valid.reason}`);
				const block = renderHelperReport(valid.report);
				return {
					content: [{ type: "text", text: `Recorded helper report.\n\n${block}` }],
					details: valid.report,
				};
			},
		});
	}

	pi.registerTool({
		name: "run_in_pane",
		label: "Run in a pane",
		description:
			"Run a long command (tests, evals, builds, installs) in its own visible herdr pane, with the full output saved to a log. Returns at once with the log path; use check_run to see progress. Never wait or sleep for it.",
		promptSnippet: "run_in_pane: run a long command in a visible pane without blocking",
		parameters: Type.Object({
			command: Type.String({ description: "The shell command to run, from the current directory." }),
			label: Type.String({ description: "A few words for the pane, e.g. 'agent unit tests'." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as { command: string; label: string };
			mkdirSync(runsDir, { recursive: true });
			const slug = p.label
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.slice(0, 40);
			const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${slug}`;
			const log = join(runsDir, `${runId}.log`);
			const script = join(runsDir, `${runId}.sh`);
			const branch = gitBranch(ctx.cwd);
			const loopEvidence = loopRunMeta(ctx.cwd, branch);
			const { line } = writeRunScript(script, ctx.cwd, p.command, log, {
				label: p.label,
				project: basename(mainCheckout(ctx.cwd)),
				...(branch ? { branch } : {}),
				agent:
					process.env.PI_SUBAGENT_NAME?.trim() ||
					(isTower ? (process.env.SITRA_TOWER_NAME?.trim() ?? "tower") : "lead"),
				...(ctx.sessionManager?.getSessionId?.() ? { sessionId: ctx.sessionManager.getSessionId() } : {}),
				command: p.command,
				...loopEvidence.meta,
			});
			let where: string;
			if (process.env.HERDR_ENV === "1" && process.env.HERDR_PANE_ID) {
				let freshPane = false;
				if (!runPane || !paneAlive(runPane)) {
					const split = herdr([
						"pane",
						"split",
						"--current",
						"--direction",
						"down",
						"--ratio",
						"0.3",
						"--no-focus",
						"--cwd",
						ctx.cwd,
					]);
					runPane = paneIdFromSplit(split);
					if (!runPane) throw new Error(`could not open a pane: ${split}`);
					freshPane = true;
				}
				const pane = runPane;
				if (freshPane) {
					try {
						startCommandInFreshPane(herdr, pane, line);
					} catch {
						runPane = undefined;
						return {
							content: [
								{
									type: "text",
									text: `The run "${p.label}" was not started: pane shell never became ready (${pane}); the new pane was closed. Log: ${log}\nScript: ${script}`,
								},
							],
							details: { log, runId, pane, script, error: "pane shell never became ready" },
						};
					}
				} else {
					herdr(["pane", "run", pane, line]);
				}
				where = `herdr pane ${pane} ("${p.label}")`;
			} else {
				spawn("bash", [script], { detached: true, stdio: "ignore" }).unref();
				where = "the background (not inside herdr)";
			}
			// The extension watches the run, not the model: when it ends, the result arrives as a message on its own.
			const watcher = setInterval(() => {
				if (!existsSync(log)) return;
				let status: ReturnType<typeof readRun>;
				try {
					status = readRun(readFileSync(log, "utf8"), 15);
				} catch (error) {
					clearInterval(watcher);
					pi.sendMessage(
						{
							customType: "sitra-run",
							content: `The run "${p.label}" could not be read: ${String(error)}\n(Full log: ${log})`,
							display: true,
						},
						ctx.isIdle?.() === false ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: true },
					);
					return;
				}
				if (!status.done) return;
				clearInterval(watcher);
				pi.sendMessage(
					{
						customType: "sitra-run",
						content: `The run "${p.label}" finished with exit code ${status.exitCode}. Last lines:\n${status.tail}\n(Full log: ${log})`,
						display: true,
					},
					// Idle: start a turn now. Busy: queue it for when the current run finishes.
					ctx.isIdle?.() === false ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: true },
				);
			}, 2_000);
			watcher.unref();
			return {
				content: [
					{
						type: "text",
						text: [
							`Started in ${where}. You'll get a message with the result when it finishes; don't wait or poll. Log: ${log}`,
							...(loopEvidence.note ? [loopEvidence.note] : []),
						].join("\n"),
					},
				],
				details: { log, runId },
			};
		},
	});

	pi.registerTool({
		name: "check_run",
		label: "Check a run",
		description:
			"Check a run started with run_in_pane: whether it finished, its exit code, and the last lines of output.",
		parameters: Type.Object({ log: Type.String({ description: "The log path run_in_pane returned." }) }),
		async execute(_id, params) {
			const p = params as { log: string };
			if (!existsSync(p.log)) return { content: [{ type: "text", text: "No output yet." }], details: {} };
			const status = readRun(readFileSync(p.log, "utf8"));
			const head = status.done ? `Finished, exit code ${status.exitCode}.` : "Still running.";
			return { content: [{ type: "text", text: `${head}\nLast lines:\n${status.tail}` }], details: status };
		},
	});
}
