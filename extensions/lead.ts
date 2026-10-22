/**
 * sitra lead: the lead's working rules (only for the agent the person talks to, never for teammates), long runs in
 * visible herdr panes instead of blocking, and a "needs you" signal in herdr when a question is waiting.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Type } from "typebox";
import { HELPER_REPORT_TOOL_SCHEMA, renderHelperReport, validateHelperReport } from "./helper-report.ts";
import { loopStatePath, readLoopStateFile } from "./loop-state.ts";
import { hashFiles, paneCommand, type RunMeta, readRun, shellQuote } from "./runs.ts";
import { gitBranch, mainCheckout } from "./sessions.ts";

/** The lead's working rules, written for the person it works with (their name, or "the user"). */
export function leadRules(name?: string): string {
	const who = name?.trim() || "the user";
	const Who = who[0]?.toUpperCase() + who.slice(1);
	return `# You are the lead: the agent ${who} talks to

- **${Who}'s words are the spec.** If they say how to do something (the tool, the command, where it runs), do exactly that. If it can't work, say why in one line.
- **Plan, then go.** For anything bigger than a quick step, propose a short plan (a few lines) and wait for their go. Once they say go, carry the plan out without asking per step. Ask again only if something would change what they agreed.
- **Never leave them in the dark.** Before anything that takes more than a couple of minutes, say in one line what's starting. When a step finishes or the picture changes, tell them in two lines.
- **Never block.** Tests, evals, builds and installs run with run_in_pane, in a pane they can watch. Don't sleep or poll; check the run with check_run when you have nothing else to do or when they ask.
- **${Who}'s limits travel with the work.** No full unit-test or eval suites unless they asked for them; CI runs the rest. Put that, the goal and what "done" means into every teammate's task.
- **You do the building.** Write the code yourself, own the branch and the pull request. Hand the builder only small, fully specified pieces (specific files, clear instructions, little decision-making) that can run while you keep going.
- **Teammates:** scout (digging and history), builder (narrow targeted edits), app-tester (uses the app in Chrome and reads its real state), reviewer (diffs, tests, evals). Steer them only through the subagent tools; never type into their panes.
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

	const loopRunMeta = (cwd: string, branch?: string): Pick<RunMeta, "loop"> => {
		if (!branch) return {};
		const worktree = repoRoot(cwd);
		const profile = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
		const statePath = loopStatePath(profile, worktree, branch);
		if (!existsSync(statePath)) return {};
		const state = readLoopStateFile(statePath);
		if (state.stage !== "build") return {};
		const testFiles = state.frozenBrief?.advisorRuns.testDesign?.acceptanceTestFiles ?? [];
		if (testFiles.length === 0) throw new Error("active loop build has no frozen acceptance test files");
		const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
		return { loop: { commit, testHashes: hashFiles(worktree, testFiles) } };
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
			const branch = gitBranch(ctx.cwd);
			const line = paneCommand(p.command, log, {
				label: p.label,
				project: basename(mainCheckout(ctx.cwd)),
				...(branch ? { branch } : {}),
				agent:
					process.env.PI_SUBAGENT_NAME?.trim() ||
					(isTower ? (process.env.SITRA_TOWER_NAME?.trim() ?? "tower") : "lead"),
				...(ctx.sessionManager?.getSessionId?.() ? { sessionId: ctx.sessionManager.getSessionId() } : {}),
				command: p.command,
				...loopRunMeta(ctx.cwd, branch),
			});
			let where: string;
			if (process.env.HERDR_ENV === "1" && process.env.HERDR_PANE_ID) {
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
					runPane = /"pane_id":"([^"]+)"/.exec(split)?.[1];
					if (!runPane) throw new Error(`could not open a pane: ${split.slice(0, 200)}`);
				}
				const pane = runPane;
				herdr(["pane", "run", pane, `cd ${shellQuote(ctx.cwd)} && ${line}`]);
				where = `herdr pane ${pane} ("${p.label}")`;
			} else {
				spawn("bash", ["-c", line], { cwd: ctx.cwd, detached: true, stdio: "ignore" }).unref();
				where = "the background (not inside herdr)";
			}
			// The extension watches the run, not the model: when it ends, the result arrives as a message on its own.
			const watcher = setInterval(() => {
				if (!existsSync(log)) return;
				let status;
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
						text: `Started in ${where}. You'll get a message with the result when it finishes; don't wait or poll. Log: ${log}`,
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
