import { afterEach, describe, expect, test, vi } from "vitest";
import { type HelperReport, renderHelperReport } from "../extensions/helper-report.ts";
import sitraLead from "../extensions/lead.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
	const handlers = new Map<string, Handler>();
	const tools = new Map<
		string,
		{
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

describe("helper_report", () => {
	test("helpers get a schema-validated report tool that returns a lead-readable block", async () => {
		const { tools } = fakePi();
		const tool = tools.get("helper_report");
		expect(tool).toBeDefined();
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
		expect(result?.details).toMatchObject({ status: "done", summary: "Found the parser tests." });
	});

	test("the lead context receives structured helper fields, or an explicit raw-output failure", () => {
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
		const rewritten = handlers.get("context")?.({ messages }, {}) as { messages: typeof messages };
		expect(rewritten.messages[0]?.content[0]?.text).toContain("Status: needs-input");
		expect(rewritten.messages[0]?.content[0]?.text).toContain("Which status code");
		expect(rewritten.messages[1]?.content[0]?.text).toContain("missing structured helper_report");
		expect(rewritten.messages[1]?.content[0]?.text).toContain("All good, no details.");
	});
});
