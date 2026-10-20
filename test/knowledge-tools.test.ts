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
