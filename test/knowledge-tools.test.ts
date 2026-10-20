import { afterEach, expect, test, vi } from "vitest";
import sitraKnowledge from "../extensions/knowledge.ts";

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
