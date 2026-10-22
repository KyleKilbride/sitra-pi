import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { renderEntry } from "../extensions/grimoire.ts";
import sitraKnowledge from "../extensions/knowledge.ts";
import { createLoopState } from "../extensions/loop.ts";
import { loopStatePath, readLoopStateFile, writeLoopStateFile } from "../extensions/loop-state.ts";

type Handler = (event: unknown, ctx: unknown) => void;

function fakePi(active: string[]) {
	const handlers = new Map<string, Handler[]>();
	const tools: string[] = [];
	let current = [...active];
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerTool(tool: { name: string }) {
			tools.push(tool.name);
		},
		registerCommand() {},
		sendUserMessage() {},
		getActiveTools: () => current,
		setActiveTools: vi.fn((next: string[]) => {
			current = next;
		}),
	};
	const startTurn = () => {
		const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
		for (const h of handlers.get("before_agent_start") ?? []) h(event, { cwd: process.cwd() });
	};
	return { pi, tools, startTurn, active: () => current };
}

function gitWorktree(): { cwd: string; head: string } {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sitra-grimoire-loop-work-")));
	execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
	writeFileSync(join(cwd, "README.md"), "test\n");
	execFileSync("git", ["add", "README.md"], { cwd, stdio: "ignore" });
	execFileSync(
		"git",
		[
			"-c",
			"user.name=Test User",
			"-c",
			"user.email=test@example.com",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-m",
			"initial",
		],
		{
			cwd,
			stdio: "ignore",
		},
	);
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
	execFileSync("git", ["remote", "add", "origin", cwd], { cwd, stdio: "ignore" });
	execFileSync("git", ["update-ref", "refs/remotes/origin/main", head], { cwd, stdio: "ignore" });
	execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], {
		cwd,
		stdio: "ignore",
	});
	execFileSync("git", ["checkout", "-b", "feature"], { cwd, stdio: "ignore" });
	return { cwd, head };
}

function loopGateFixture() {
	const grimoire = realpathSync(mkdtempSync(join(tmpdir(), "sitra-grimoire-loop-")));
	const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-grimoire-loop-profile-")));
	const { cwd, head } = gitWorktree();
	mkdirSync(join(grimoire, "kinds", "warnings"), { recursive: true });
	writeFileSync(
		join(grimoire, "kinds", "warnings", "one-builder.md"),
		renderEntry({
			kind: "warning",
			title: "One builder per pull request",
			body: "Use one builder per pull request.",
			date: "2026-10-22",
			when: ["tool:subagent"],
		}),
	);
	vi.stubEnv("SITRA_GRIMOIRE", grimoire);
	vi.stubEnv("PI_CODING_AGENT_DIR", profile);
	vi.stubEnv("PI_SUBAGENT_NAME", "");
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	sitraKnowledge({
		on: (n: string, h: (e: unknown, c: unknown) => unknown) => handlers.set(n, h),
		registerTool() {},
		registerCommand() {},
		sendUserMessage() {},
	} as never);
	const warnings: string[] = [];
	const ctx = {
		cwd,
		hasUI: true,
		ui: { setStatus() {}, notify: (message: string) => warnings.push(message) },
	};
	const call = (input: object) =>
		handlers.get("tool_call")?.({ toolName: "subagent", input }, ctx) as
			| { block?: boolean; reason?: string }
			| undefined;
	const search = () => handlers.get("tool_call")?.({ toolName: "grimoire_search", input: { query: "builder" } }, ctx);
	const writeLoopState = (state: ReturnType<typeof createLoopState>) =>
		writeLoopStateFile(loopStatePath(profile, cwd, "feature"), state);
	const baseState = () =>
		createLoopState({
			worktree: cwd,
			branch: "feature",
			baseRef: "origin/main",
			baseHead: head,
			goal: "goal",
			limits: [],
			done: [],
		});
	return { grimoire, profile, cwd, call, search, writeLoopState, baseState, warnings };
}

afterEach(() => {
	vi.unstubAllEnvs();
});

test("a resumed session whose saved tool list predates Grimoire gets grimoire_search and grimoire_propose back", () => {
	vi.stubEnv("PI_SUBAGENT_NAME", "");
	const f = fakePi(["read", "bash"]);
	sitraKnowledge(f.pi as never);
	f.startTurn();
	expect(f.active()).toEqual(["read", "bash", "grimoire_propose", "grimoire_search"]);
});

test("a session that already has the Grimoire tools is left alone", () => {
	vi.stubEnv("PI_SUBAGENT_NAME", "");
	const f = fakePi(["read", "grimoire_search", "grimoire_propose"]);
	sitraKnowledge(f.pi as never);
	f.startTurn();
	expect(f.pi.setActiveTools).not.toHaveBeenCalled();
});

test("a helper keeps the tool list its agent definition chose", () => {
	vi.stubEnv("PI_SUBAGENT_NAME", "scout");
	const f = fakePi(["read"]);
	sitraKnowledge(f.pi as never);
	f.startTurn();
	expect(f.active()).toEqual(["read"]);
});

test("a rule tied to an action pauses that action once per session with the rule, then lets it through", async () => {
	const { mkdtempSync, mkdirSync, writeFileSync, realpathSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { renderEntry } = await import("../extensions/grimoire.ts");
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "sitra-when-")));
	mkdirSync(join(dir, "kinds", "decisions"), { recursive: true });
	writeFileSync(
		join(dir, "kinds", "decisions", "2026-10-20-drafts.md"),
		renderEntry({
			kind: "decision",
			title: "Open pull requests as drafts",
			body: "Always pass --draft.",
			date: "2026-10-20",
			when: ["command:gh pr create"],
		}),
	);
	vi.stubEnv("SITRA_GRIMOIRE", dir);
	vi.stubEnv("PI_SUBAGENT_NAME", "");
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = {
		on: (name: string, h: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, h),
		registerTool() {},
		registerCommand() {},
		sendUserMessage() {},
	};
	sitraKnowledge(pi as never);
	const ctx = { cwd: dir, hasUI: false, ui: { setStatus() {}, notify() {} } };
	handlers.get("session_start")?.({}, ctx);
	const call = (command: string) =>
		handlers.get("tool_call")?.({ type: "tool_call", toolCallId: "1", toolName: "bash", input: { command } }, ctx) as
			| { block?: boolean; reason?: string }
			| undefined;
	expect(call("gh pr view 3")).toBeUndefined();
	const first = call("git push && gh pr create --fill");
	expect(first?.block).toBe(true);
	expect(first?.reason).toContain("Always pass --draft.");
	expect(call("git push && gh pr create --fill")).toBeUndefined();
	handlers.get("session_start")?.({}, ctx);
	expect(call("gh pr create --draft")?.block).toBe(true);
});

test("a broken outcome log never stops a rule from pausing", async () => {
	const { mkdtempSync, mkdirSync, writeFileSync, realpathSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { renderEntry } = await import("../extensions/grimoire.ts");
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "sitra-when-")));
	mkdirSync(join(dir, "kinds", "decisions"), { recursive: true });
	writeFileSync(
		join(dir, "kinds", "decisions", "d.md"),
		renderEntry({
			kind: "decision",
			title: "Drafts",
			body: "Pass --draft.",
			date: "2026-10-20",
			when: ["command:gh pr create"],
		}),
	);
	mkdirSync(join(dir, ".sitra"), { recursive: true });
	writeFileSync(join(dir, ".sitra", "pending-pause"), "not a folder");
	vi.stubEnv("SITRA_GRIMOIRE", dir);
	vi.stubEnv("PI_SUBAGENT_NAME", "");
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	sitraKnowledge({
		on: (n: string, h: (e: unknown, c: unknown) => unknown) => handlers.set(n, h),
		registerTool() {},
		registerCommand() {},
		sendUserMessage() {},
	} as never);
	const ctx = { cwd: dir, hasUI: false, ui: { setStatus() {}, notify() {} } };
	const r = handlers.get("tool_call")?.(
		{ type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "gh pr create" } },
		ctx,
	);
	expect(r).toMatchObject({ block: true });
});

test("the turn-start handler never throws, and the review count refreshes even with learning off", async () => {
	const { mkdtempSync, mkdirSync, writeFileSync, realpathSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { renderEntry } = await import("../extensions/grimoire.ts");
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "sitra-turn-")));
	vi.stubEnv("SITRA_GRIMOIRE", dir);
	vi.stubEnv("PI_SUBAGENT_NAME", "");
	vi.stubEnv("SITRA_GRIMOIRE_LEARN", "0");
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	sitraKnowledge({
		on: (n: string, h: (e: unknown, c: unknown) => unknown) => handlers.set(n, h),
		registerTool() {},
		registerCommand() {},
		sendUserMessage() {},
	} as never);
	const statuses: string[] = [];
	const ctx = { cwd: dir, hasUI: true, ui: { setStatus: (_k: string, t: string) => statuses.push(t), notify() {} } };
	mkdirSync(join(dir, "proposals"), { recursive: true });
	writeFileSync(
		join(dir, "proposals", "p.md"),
		renderEntry({ kind: "lesson", title: "Learned", body: "b", date: "2026-10-20" }),
	);
	const event = () => ({ messageType: "user", prompt: "hello", systemPromptOptions: { sections: {} } });
	handlers.get("before_agent_start")?.(event(), ctx);
	expect(statuses.at(-1)).toContain("1 to review");
	const broken = realpathSync(mkdtempSync(join(tmpdir(), "sitra-turn-")));
	writeFileSync(join(broken, "proposals"), "not a folder");
	vi.stubEnv("SITRA_GRIMOIRE", broken);
	vi.stubEnv("SITRA_GRIMOIRE_LEARN", "1");
	expect(() => handlers.get("before_agent_start")?.(event(), ctx)).not.toThrow();
});

test("an unreadable Grimoire is visible in the session but does not block ordinary turns", async () => {
	const { mkdtempSync, realpathSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "sitra-unreadable-grimoire-")));
	writeFileSync(join(dir, "root"), "not a directory\n");
	vi.stubEnv("SITRA_GRIMOIRE", dir);
	vi.stubEnv("PI_SUBAGENT_NAME", "");
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	sitraKnowledge({
		on: (n: string, h: (e: unknown, c: unknown) => unknown) => handlers.set(n, h),
		registerTool() {},
		registerCommand() {},
		sendUserMessage() {},
	} as never);
	const warnings: string[] = [];
	const statuses: (string | undefined)[] = [];
	const ctx = {
		cwd: dir,
		hasUI: true,
		ui: {
			setStatus: (_k: string, t: string | undefined) => statuses.push(t),
			notify: (message: string) => warnings.push(message),
		},
	};
	const event = {
		messageType: "user",
		prompt: "hello",
		systemPromptOptions: { sections: {} as Record<string, string> },
	};
	expect(() => handlers.get("before_agent_start")?.(event, ctx)).not.toThrow();
	expect(warnings.at(-1)).toContain("Grimoire is unreadable");
	expect(statuses.at(-1)).toContain("grimoire unreadable");
	expect(event.systemPromptOptions.sections.grimoire).toContain("Grimoire unavailable");
});

test("a missing Grimoire is treated as empty in the prompt, not as unavailable", async () => {
	const { mkdtempSync, realpathSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "sitra-missing-grimoire-"))), "missing");
	vi.stubEnv("SITRA_GRIMOIRE", dir);
	vi.stubEnv("PI_SUBAGENT_NAME", "");
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	sitraKnowledge({
		on: (n: string, h: (e: unknown, c: unknown) => unknown) => handlers.set(n, h),
		registerTool() {},
		registerCommand() {},
		sendUserMessage() {},
	} as never);
	const warnings: string[] = [];
	const statuses: (string | undefined)[] = [];
	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		ui: {
			setStatus: (_k: string, t: string | undefined) => statuses.push(t),
			notify: (message: string) => warnings.push(message),
		},
	};
	const event = {
		messageType: "user",
		prompt: "hello",
		systemPromptOptions: { sections: {} as Record<string, string> },
	};
	handlers.get("before_agent_start")?.(event, ctx);
	expect(event.systemPromptOptions.sections.grimoire).toContain("Approved entries (0");
	expect(event.systemPromptOptions.sections.grimoire).not.toContain("Grimoire unavailable");
	expect(warnings).toEqual([]);
	expect(statuses.at(-1)).toContain("grimoire 0");
});

test("the status line shows today's tally, and /grimoire walks through repeats after proposals", async () => {
	const { mkdtempSync, realpathSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { recordMoment, repeats } = await import("../extensions/learn.ts");
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "sitra-tally-")));
	vi.stubEnv("SITRA_GRIMOIRE", dir);
	vi.stubEnv("PI_SUBAGENT_NAME", "");
	vi.stubEnv("SITRA_GRIMOIRE_LEARN", "0");
	recordMoment(dir, {
		id: "r1",
		at: new Date().toISOString(),
		harness: "pi",
		cwd: "/work/app",
		message: "you said you'd start it and did nothing",
		agentReply: "",
		calls: [],
		verdict: "correction",
		skipped: "Already covered by 'Own the thread'",
	});
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const sent: string[] = [];
	sitraKnowledge({
		on: (n: string, h: (e: unknown, c: unknown) => unknown) => handlers.set(n, h),
		registerTool() {},
		registerCommand: (n: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(n, c),
		sendUserMessage: (m: string) => sent.push(m),
	} as never);
	const statuses: string[] = [];
	const asked: string[] = [];
	const ctx = {
		cwd: dir,
		hasUI: true,
		ui: {
			setStatus: (_k: string, t: string) => statuses.push(t),
			notify() {},
			select: async (title: string) => {
				asked.push(title);
				return "Ask the agent how to make it land";
			},
		},
	};
	handlers.get("session_start")?.({}, ctx);
	expect(statuses.at(-1)).toContain("today: 0 caught · 0 learned · 1 repeat");
	await commands.get("grimoire")?.handler("", ctx);
	expect(asked[0]).toContain("you said you'd start it and did nothing");
	expect(asked[0]).toContain("Own the thread");
	expect(sent[0]).toContain("Own the thread");
	expect(sent[0]).toMatch(/never edit/i);
	expect(repeats(dir)).toEqual([]);
	expect(statuses.at(-1)).toContain("1 repeat");
});

test("the first change in a session waits until the agent has looked at Grimoire, once", async () => {
	const { mkdtempSync, mkdirSync, writeFileSync, realpathSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { renderEntry } = await import("../extensions/grimoire.ts");
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "sitra-look-")));
	mkdirSync(join(dir, "kinds", "lessons"), { recursive: true });
	writeFileSync(
		join(dir, "kinds", "lessons", "l.md"),
		renderEntry({ kind: "lesson", title: "L", body: "b", date: "2026-10-20" }),
	);
	vi.stubEnv("SITRA_GRIMOIRE", dir);
	vi.stubEnv("PI_SUBAGENT_NAME", "");
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	sitraKnowledge({
		on: (n: string, h: (e: unknown, c: unknown) => unknown) => handlers.set(n, h),
		registerTool() {},
		registerCommand() {},
		sendUserMessage() {},
	} as never);
	const ctx = { cwd: "/w", hasUI: false, ui: { setStatus() {}, notify() {} } };
	const call = (toolName: string, input: object) =>
		handlers.get("tool_call")?.({ toolName, input }, ctx) as { block?: boolean; reason?: string } | undefined;
	expect(call("read", { path: "/w/src/a.ts" })).toBeUndefined();
	const first = call("edit", { path: "/w/src/a.ts" });
	expect(first?.block).toBe(true);
	expect(first?.reason).toMatch(/grimoire/i);
	expect(call("edit", { path: "/w/src/a.ts" })).toBeUndefined();
	handlers.get("session_start")?.({}, ctx);
	expect(call("read", { path: join(dir, "kinds", "lessons", "l.md") })).toBeUndefined();
	expect(call("write", { path: "/w/b.ts" })).toBeUndefined();
	handlers.get("session_start")?.({}, ctx);
	const inGrimoire = { cwd: dir, hasUI: false, ui: { setStatus() {}, notify() {} } };
	expect(
		handlers.get("tool_call")?.({ toolName: "read", input: { path: "kinds/lessons/l.md" } }, inGrimoire),
	).toBeUndefined();
	expect(handlers.get("tool_call")?.({ toolName: "edit", input: { path: "/w/x.ts" } }, inGrimoire)).toBeUndefined();
	handlers.get("session_start")?.({}, ctx);
	expect(call("read", { path: `${dir}-not-grimoire/a.txt` })).toBeUndefined();
	expect(call("edit", { path: "/w/x.ts" })?.block).toBe(true);
	handlers.get("session_start")?.({}, ctx);
	vi.stubEnv("SITRA_GRIMOIRE_LOOK", "0");
	expect(call("edit", { path: "/w/a.ts" })).toBeUndefined();
});

test("action triggers do not pre-scan unrelated root files before loading entries", async () => {
	const { mkdtempSync, mkdirSync, writeFileSync, realpathSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { renderEntry } = await import("../extensions/grimoire.ts");
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "sitra-no-prescan-")));
	writeFileSync(join(dir, "root"), "not a directory\n");
	mkdirSync(join(dir, "kinds", "warnings"), { recursive: true });
	writeFileSync(
		join(dir, "kinds", "warnings", "w.md"),
		renderEntry({
			kind: "warning",
			title: "Use draft PRs",
			body: "Open PRs as drafts.",
			date: "2026-10-21",
			when: ["command:gh pr create"],
		}),
	);
	vi.stubEnv("SITRA_GRIMOIRE", dir);
	vi.stubEnv("PI_SUBAGENT_NAME", "");
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	sitraKnowledge({
		on: (n: string, h: (e: unknown, c: unknown) => unknown) => handlers.set(n, h),
		registerTool() {},
		registerCommand() {},
		sendUserMessage() {},
	} as never);
	const warnings: string[] = [];
	const ctx = { cwd: dir, hasUI: true, ui: { setStatus() {}, notify: (message: string) => warnings.push(message) } };
	const result = handlers.get("tool_call")?.(
		{ type: "tool_call", toolName: "bash", input: { command: "gh pr create" } },
		ctx,
	) as { block?: boolean; reason?: string } | undefined;
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("Open PRs as drafts.");
	expect(warnings).toEqual([]);
});

test("loop-pending advisor subagent dispatch skips the Grimoire look and rule gates", () => {
	const f = loopGateFixture();
	f.writeLoopState(f.baseState());

	const result = f.call({
		children: [
			{
				agent: "intent-advisor",
				task: "Goal: goal\nLimits:\n- (none)\nDone lines:\n- (none)\nAnswers so far:\n- (none)\nCurrent questions:\n- (none)",
			},
			{
				agent: "codebase-advisor",
				task: "Goal: goal\nLimits:\n- (none)\nDone lines:\n- (none)\nAnswers so far:\n- (none)\nFind repository facts, files, tests, boundaries and owners.",
			},
		],
	});

	expect(result).toBeUndefined();
	expect(existsSync(join(f.grimoire, ".sitra", "pending-pause"))).toBe(false);
	expect(f.warnings).toEqual([]);
	expect(readLoopStateFile(loopStatePath(f.profile, f.cwd, "feature")).startedAdvisors).toEqual([]);
});

test("loop-pending advisor subagent dispatch with a rewritten task is not treated as started", () => {
	const f = loopGateFixture();
	f.writeLoopState(f.baseState());

	const result = f.call({
		children: [{ agent: "intent-advisor", task: "Find the intent." }],
	});

	expect(result?.block).toBe(true);
	expect(readLoopStateFile(loopStatePath(f.profile, f.cwd, "feature")).startedAdvisors).toEqual([]);
});

test("a non-loop subagent spawn still gets the Grimoire look nudge once", () => {
	const f = loopGateFixture();

	const first = f.call({ agent: "scout", task: "Find nearby files." });

	expect(first?.block).toBe(true);
	expect(first?.reason).toContain("Paused once before your first change");
	expect(f.call({ agent: "scout", task: "Find nearby files." })).toBeUndefined();
});

test("a same-call rerun is not paused again by the other Grimoire gate", () => {
	const f = loopGateFixture();

	const first = f.call({ agent: "builder", task: "Make the change." });
	f.search();
	const second = f.call({ task: "Make the change.", agent: "builder" });

	expect(first?.block).toBe(true);
	expect(first?.reason).toContain("Paused once before your first change");
	expect(first?.reason).toContain("Use one builder per pull request.");
	expect(second).toBeUndefined();
});

test("a mixed loop advisor and non-pending subagent call is still gated", () => {
	const f = loopGateFixture();
	f.writeLoopState(f.baseState());

	const result = f.call({
		children: [
			{ agent: "intent-advisor", task: "Find the intent." },
			{ agent: "scout", task: "Find unrelated context." },
		],
	});

	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("Paused once before your first change");
});

test("unreadable loop state keeps the Grimoire gate on and warns", () => {
	const f = loopGateFixture();
	mkdirSync(join(f.profile, "loops"), { recursive: true });
	writeFileSync(loopStatePath(f.profile, f.cwd, "feature"), "{");

	const result = f.call({ agent: "intent-advisor", task: "Find the intent." });

	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("Paused once before your first change");
	expect(f.warnings[0]).toContain("LOOPS state could not be checked for the Grimoire gate");
});
