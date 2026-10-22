import { afterEach, describe, expect, test, vi } from "vitest";
import { type HelperReport, renderHelperReport } from "../extensions/helper-report.ts";
import sitraLead from "../extensions/lead.ts";

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
