import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createLoopState } from "../extensions/loop.ts";
import sitraLoop, { loopStatePath, readLoopStateFile } from "../extensions/loop-pi.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { description: string; handler(args: string, ctx: unknown): Promise<void> }>();
	const tools = new Map<
		string,
		{
			description: string;
			execute(
				id: string,
				params: Record<string, unknown>,
				signal: unknown,
				onUpdate: unknown,
				ctx: unknown,
			): Promise<{ content: { text: string }[]; details: unknown }>;
		}
	>();
	const userMessages: string[] = [];
	sitraLoop({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerCommand: (
			name: string,
			command: { description: string; handler(args: string, ctx: unknown): Promise<void> },
		) => commands.set(name, command),
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
		sendUserMessage: (message: string) => userMessages.push(message),
	} as never);
	return { handlers, commands, tools, userMessages };
}

const ctx = (cwd: string, messages: string[] = []) => ({
	cwd,
	ui: {
		setStatus() {},
		notify: (message: string) => messages.push(message),
	},
});

afterEach(() => vi.unstubAllEnvs());

describe("loop state files", () => {
	test("stores one JSON file per worktree and branch under the private profile", () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		const path = loopStatePath(profile, "/repo", "main");
		expect(path.startsWith(join(profile, "loops"))).toBe(true);
		expect(path.endsWith(".json")).toBe(true);
		expect(loopStatePath(profile, "/repo", "main")).toBe(path);
		expect(loopStatePath(profile, "/repo", "feature")).not.toBe(path);
	});

	test("validates state on read and fails loudly for invalid or unreadable files", () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-state-")));
		const file = join(dir, "state.json");
		writeFileSync(
			file,
			JSON.stringify(
				createLoopState({ worktree: "/repo", branch: "main", baseHead: "base", goal: "goal", limits: [], done: [] }),
			),
		);
		expect(readLoopStateFile(file).stage).toBe("advise");

		writeFileSync(file, JSON.stringify({ version: 1, stage: "advise" }));
		expect(() => readLoopStateFile(file)).toThrow(/invalid loop state/);

		rmSync(file);
		mkdirSync(file);
		expect(() => readLoopStateFile(file)).toThrow(/could not read loop state/);
	});
});

describe("Pi wiring", () => {
	test("/loop start is explicit, writes state, and asks for the first advisors", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, userMessages } = fakePi();
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-work-")));

		await commands.get("loop")?.handler("start Add the runner", ctx(cwd));

		const files = readFileSync(loopStatePath(profile, cwd, "unknown"), "utf8");
		expect(files).toContain("Add the runner");
		expect(userMessages.join("\n")).toContain("intent-advisor");
		expect(userMessages.join("\n")).toContain("codebase-advisor");
	});

	test("loop_status is read-only and returns the current state", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, tools } = fakePi();
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-work-")));
		await commands.get("loop")?.handler("start Add the runner", ctx(cwd));

		const result = await tools.get("loop_status")?.execute("1", {}, undefined, undefined, ctx(cwd));
		expect(result?.content[0]?.text).toContain("stage: advise");
		expect(result?.details).toMatchObject({ stage: "advise", goal: "Add the runner" });
	});

	test("subagent_result details are validated helper reports and update state through pure transitions", async () => {
		const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-profile-")));
		vi.stubEnv("PI_CODING_AGENT_DIR", profile);
		const { commands, handlers, userMessages } = fakePi();
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-work-")));
		await commands.get("loop")?.handler("start Add the runner", ctx(cwd));

		await handlers.get("subagent_result")?.(
			{
				sessionFile: "/tmp/session.jsonl",
				details: {
					status: "done",
					role: "intent",
					summary: "Intent clear.",
					evidence: ["docs/LOOPS.md:1"],
					openQuestions: [],
					assumptions: [],
					details: { questions: [], doneCandidates: ["Approved brief."], ambiguities: [] },
				},
				usage: { totalTokens: 1234 },
			},
			ctx(cwd),
		);
		await handlers.get("subagent_result")?.(
			{
				sessionFile: "/tmp/session.jsonl",
				details: {
					status: "done",
					role: "codebase",
					summary: "Loop belongs in extensions.",
					evidence: ["extensions/lead.ts:1"],
					openQuestions: [],
					assumptions: [],
					details: { files: ["extensions/loop.ts"], existingTests: [], facts: [], boundaries: [], owners: [] },
				},
				tokenCount: 2222,
			},
			ctx(cwd),
		);

		expect(readLoopStateFile(loopStatePath(profile, cwd, "unknown")).advisorRuns.intent?.tokenCount).toBe(1234);
		expect(userMessages.join("\n")).toContain("test-design-advisor");

		await expect(
			handlers.get("subagent_result")?.(
				{ sessionFile: "/tmp/session.jsonl", details: { status: "done-ish" } },
				ctx(cwd),
			),
		).rejects.toThrow(/invalid helper_report/);
	});
});
