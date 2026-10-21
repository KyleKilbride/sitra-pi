import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const AGENTS = new URL("../templates/profile/agents/", import.meta.url);

const roles = [
	{
		name: "intent-advisor",
		mode: "background",
		model: "anthropic/claude-opus-5-5",
		thinking: "high",
		tools: ["read", "grep", "find", "ls", "bash", "grimoire_search", "grimoire_propose", "helper_report"],
	},
	{
		name: "codebase-advisor",
		mode: "background",
		model: "anthropic/claude-haiku-5-5",
		thinking: "medium",
		tools: ["read", "grep", "find", "ls", "bash", "grimoire_search", "helper_report"],
	},
	{
		name: "test-design-advisor",
		mode: "background",
		model: "anthropic/claude-opus-5-5",
		thinking: "medium",
		tools: ["read", "grep", "find", "ls", "bash", "grimoire_search", "helper_report"],
	},
	{
		name: "architecture-advisor",
		mode: "background",
		model: "openai/gpt-6.1-sol",
		thinking: "high",
		tools: ["read", "grep", "find", "ls", "bash", "grimoire_search", "helper_report"],
	},
	{
		name: "verifier",
		mode: "interactive",
		model: "openai/gpt-6.1-sol",
		thinking: "xhigh",
		tools: ["read", "grep", "find", "ls", "bash", "run_in_pane", "check_run", "grimoire_search", "helper_report"],
	},
];

function agent(name: string): { frontmatter: Map<string, string>; body: string } {
	const text = readFileSync(fileURLToPath(new URL(`${name}.md`, AGENTS)), "utf8");
	const lines = text.split("\n");
	const end = lines.indexOf("---", 1);
	const frontmatter = new Map<string, string>();
	for (const line of lines.slice(1, end)) {
		const splitAt = line.indexOf(":");
		if (splitAt > 0) frontmatter.set(line.slice(0, splitAt), line.slice(splitAt + 1).trim());
	}
	return { frontmatter, body: lines.slice(end + 1).join("\n") };
}

const list = (value: string | undefined) => value?.split(",").map((part) => part.trim()) ?? [];

describe("advisor and verifier profiles", () => {
	test("set explicit read-only tools, no skills, and pinned model overrides", () => {
		for (const role of roles) {
			const meta = agent(role.name).frontmatter;
			const tools = list(meta.get("tools"));
			expect(meta.get("name")).toBe(role.name);
			expect(meta.get("mode")).toBe(role.mode);
			expect(meta.get("model")).toBe(role.model);
			expect(meta.get("thinking")).toBe(role.thinking);
			expect(meta.get("skills")).toBe("none");
			expect(meta.get("allow-model-override")).toBe("false");
			expect(list(meta.get("deny-tools"))).toEqual(["edit", "write"]);
			expect(tools).toEqual(role.tools);
			expect(tools).toContain("helper_report");
			for (const denied of ["mcp", "codemode", "edit", "write"]) expect(tools).not.toContain(denied);
			if (role.name === "verifier") expect(tools).toEqual(expect.arrayContaining(["run_in_pane", "check_run"]));
			else expect(tools).not.toEqual(expect.arrayContaining(["run_in_pane", "check_run"]));
		}
	});

	test("ship generic prompts, not private person or company-specific names", () => {
		for (const role of roles) {
			const body = agent(role.name).body;
			for (const forbidden of ["Kyle", "Kilbride", "Sam", "Acme", "ExampleCorp", "{{name}}"]) {
				expect(body.includes(forbidden), `${role.name} should not mention ${forbidden}`).toBe(false);
			}
		}
	});

	test("architecture advisor documents the private checklist states", () => {
		const body = agent("architecture-advisor").body;
		expect(body).toContain("$PI_CODING_AGENT_DIR/agents/checklists/architecture.md");
		expect(body).toContain("checklist.state 'absent'");
		expect(body).toContain("unreadable");
	});

	test("verifier is instructed to report comprehensive findings", () => {
		const body = agent("verifier").body;
		expect(body).toContain("Report every issue you find");
		expect(body).toContain("low-severity or uncertain");
	});
});

test("reviewer has an explicit read-only tools list", () => {
	const meta = agent("reviewer").frontmatter;
	expect(list(meta.get("tools"))).toEqual(["read", "grep", "find", "ls", "bash", "helper_report"]);
	expect(list(meta.get("tools"))).not.toEqual(expect.arrayContaining(["mcp", "codemode", "edit", "write"]));
	expect(meta.get("skills")).toBe("none");
});
