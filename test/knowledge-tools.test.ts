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
