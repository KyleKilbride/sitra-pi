import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createLoopState, type LoopState } from "../extensions/loop.ts";
import { loopStatePath, writeLoopStateFile } from "../extensions/loop-pi.ts";
import { type HelperReport, renderHelperReport } from "../extensions/helper-report.ts";
import sitraLead from "../extensions/lead.ts";
import { readRunHeader } from "../extensions/runs.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
	const handlers = new Map<string, Handler>();
	const tools = new Map<
		string,
		{
			description: string;
			promptSnippet?: string;
			parameters: {
				type?: string;
				properties?: Record<string, { type?: string }>;
			};
			execute: (
				id: string,
				params: Record<string, unknown>,
				signal: unknown,
				onUpdate: unknown,
				ctx: unknown,
			) => Promise<{ content: { text: string }[]; details: unknown }>;
		}
	>();
	sitraLead({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
		events: { on() {}, emit() {} },
		sendMessage() {},
	} as never);
	return { handlers, tools };
}

const content = (text: string) => [{ type: "text", text }];

afterEach(() => vi.unstubAllEnvs());

function gitWorktree(): { cwd: string; head: string } {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sitra-lead-loop-")));
	execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
	writeFileSync(join(cwd, "README.md"), "test\n");
	writeFileSync(join(cwd, "loop.test.ts"), "expect(true).toBe(true)\n");
	execFileSync("git", ["add", "."], { cwd, stdio: "ignore" });
	execFileSync("git", ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "initial"], {
		cwd,
		stdio: "ignore",
	});
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
	execFileSync("git", ["remote", "add", "origin", cwd], { cwd, stdio: "ignore" });
	execFileSync("git", ["update-ref", "refs/remotes/origin/main", head], { cwd, stdio: "ignore" });
	execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd, stdio: "ignore" });
	execFileSync("git", ["checkout", "-b", "feature"], { cwd, stdio: "ignore" });
	return { cwd, head };
}

describe("helper_report", () => {
	test("only helper sessions get a schema-validated report tool", async () => {
		const { tools } = fakePi();
		expect(tools.has("helper_report")).toBe(false);

		vi.stubEnv("PI_SUBAGENT_NAME", "scout");
		const helper = fakePi();
		const tool = helper.tools.get("helper_report");
		expect(tool).toBeDefined();
		expect(tool?.description).not.toMatch(/Kyle|Sam/);
		expect(tool?.promptSnippet).not.toMatch(/Kyle|Sam/);
		expect(tool?.parameters.type).toBe("object");
		expect(Object.keys(tool?.parameters.properties ?? {}).length).toBeGreaterThan(0);
		expect(tool?.parameters.properties?.evidence?.type).toBe("array");
		expect(tool?.parameters.properties?.openQuestions?.type).toBe("array");
		expect(tool?.parameters.properties?.assumptions?.type).toBe("array");
		const result = await tool?.execute(
			"1",
			{
				status: "done",
				summary: "Found the parser tests.",
				evidence: ["test/parser.test.ts"],
				openQuestions: [],
				assumptions: ["No app run was needed."],
			},
			undefined,
			undefined,
			{},
		);
		expect(result?.content[0]?.text).toContain("sitra-helper-report-v1");
		expect(result?.content[0]?.text).not.toContain("Return exactly this block as your final reply");
		expect(result?.content[0]?.text).not.toMatch(/Kyle|Sam/);
		expect(result?.details).toMatchObject({ status: "done", summary: "Found the parser tests." });
	});

	test("invalid helper_report arguments fail loudly", async () => {
		vi.stubEnv("PI_SUBAGENT_NAME", "scout");
		const { tools } = fakePi();
		await expect(
			tools.get("helper_report")?.execute(
				"1",
				{
					status: "done-ish",
					summary: "Found the parser tests.",
					evidence: ["test/parser.test.ts"],
					openQuestions: [],
					assumptions: [],
				},
				undefined,
				undefined,
				{},
			),
		).rejects.toThrow(/invalid helper_report/);
	});

	test("lead context leaves teammate prose alone until the runner owns report transport", () => {
		const { handlers } = fakePi();
		const report: HelperReport = {
			status: "needs-input",
			summary: "The API contract is ambiguous.",
			evidence: ["docs/api.md"],
			openQuestions: ["Which status code should empty results use?"],
			assumptions: ["The endpoint is public."],
		};
		const messages = [
			{ role: "toolResult", toolName: "subagent", content: content(renderHelperReport(report)) },
			{ role: "toolResult", toolName: "subagent", content: content("All good, no details.") },
		];
		const rewritten = handlers.get("context")?.({ messages }, {}) as { messages: typeof messages } | undefined;
		expect(rewritten).toBeUndefined();
		expect(messages[0]?.content[0]?.text).toBe(renderHelperReport(report));
		expect(messages[1]?.content[0]?.text).toBe("All good, no details.");
	});
});

describe("run_in_pane loop metadata", () => {
	test("writes active build loop commit and frozen test hashes into the run header", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-lead-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { tools } = fakePi();
		const { cwd, head } = gitWorktree();
		const state: LoopState = {
			...createLoopState({
				worktree: cwd,
				branch: "feature",
				baseRef: "origin/main",
				baseHead: head,
				goal: "Add the runner",
				limits: [],
				done: [],
			}),
			stage: "build",
			advisorRuns: {
				testDesign: {
					status: "done",
					summary: "tests",
					evidence: [],
					openQuestions: [],
					assumptions: [],
					acceptanceTestFiles: ["loop.test.ts"],
				},
			},
		};
		writeLoopStateFile(loopStatePath(profile, cwd, "feature"), state);

		const result = await tools.get("run_in_pane")?.execute(
			"1",
			{ command: "true", label: "loop red" },
			undefined,
			undefined,
			{ cwd },
		);
		const details = result?.details as { log: string; runId: string };
		const log = details.log;
		execFileSync("bash", [
			"-c",
			`for i in {1..50}; do [ -s ${JSON.stringify(log)} ] && exit 0; sleep 0.05; done; exit 1`,
		]);
		const header = readRunHeader(readFileSync(log, "utf8").split("\n")[0] ?? "");
		expect(header?.meta.loop?.commit).toBe(head);
		expect(header?.meta.loop?.testHashes).toEqual([
			{
				file: "loop.test.ts",
				sha256: execFileSync("sha256sum", ["loop.test.ts"], { cwd, encoding: "utf8" }).split(/\s+/)[0],
			},
		]);
		expect(details.runId).toBeTypeOf("string");
	});
});
