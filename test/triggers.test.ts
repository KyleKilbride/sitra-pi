import { describe, expect, test } from "vitest";
import type { Entry } from "../extensions/grimoire.ts";
import {
	actionFromHook,
	actionFromPi,
	entriesForAction,
	evaluateTriggers,
	parseTrigger,
	pauseMessage,
	triggerMatches,
} from "../extensions/triggers.ts";

const CWD = "/work/app";
const entry = (title: string, when: string[], body = `${title}.`): Entry => ({
	kind: "warning",
	title,
	body,
	date: "2026-10-20",
	when,
	file: `kinds/warnings/2026-10-20-${title.toLowerCase().replace(/\W+/g, "-")}.md`,
});

describe("reading what the agent is about to do", () => {
	test("Pi tools: shell commands from any tool with a command, file paths from the file tools", () => {
		expect(actionFromPi("bash", { command: "cd ui && pnpm test" })).toEqual({
			tool: "bash",
			commands: [
				["cd", "ui"],
				["pnpm", "test"],
			],
			paths: [],
		});
		expect(actionFromPi("run_in_pane", { command: "pnpm check", label: "x" }).commands).toEqual([["pnpm", "check"]]);
		expect(actionFromPi("edit", { path: "src/a.ts", edits: [] })).toEqual({
			tool: "edit",
			commands: [],
			paths: ["src/a.ts"],
		});
		expect(actionFromPi("subagent", { agent: "builder", task: "x" }).tool).toBe("subagent");
	});

	test("files written from the shell count as paths: redirects, tee and sed -i", () => {
		expect(actionFromPi("bash", { command: "cat > agent/src/a.ts <<'EOF'\nx\nEOF" }).paths).toEqual(["agent/src/a.ts"]);
		expect(actionFromPi("bash", { command: "echo hi >> notes.md && pnpm build 2>&1 | tee /tmp/b.log" }).paths).toEqual([
			"notes.md",
			"/tmp/b.log",
		]);
		expect(actionFromHook("Bash", { command: "sed -i '' 's/a/b/' src/x.ts src/y.ts" }).paths).toEqual([
			"src/x.ts",
			"src/y.ts",
		]);
		expect(actionFromPi("bash", { command: "pnpm test 2>&1" }).paths).toEqual([]);
		expect(actionFromPi("bash", { command: "ls > /dev/null" }).paths).toEqual([]);
		expect(actionFromPi("bash", { command: 'echo "example > protected.ts"' }).paths).toEqual([]);
		expect(actionFromPi("bash", { command: "cmd &> all.log; cmd 2> err.log" }).paths).toEqual(["all.log", "err.log"]);
	});

	test("Claude Code and Codex hooks: tool names are normalised, and apply_patch yields the files it touches", () => {
		expect(actionFromHook("Bash", { command: "gh pr create --draft" })).toEqual({
			tool: "bash",
			commands: [["gh", "pr", "create", "--draft"]],
			paths: [],
		});
		expect(actionFromHook("MultiEdit", { file_path: "/work/app/src/a.ts" }).paths).toEqual(["/work/app/src/a.ts"]);
		expect(actionFromHook("Task", { prompt: "x" }).tool).toBe("subagent");
		const patch =
			"*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Add File: docs/new.md\n+hi\n*** End Patch";
		expect(actionFromHook("apply_patch", { command: patch })).toEqual({
			tool: "edit",
			commands: [],
			paths: ["src/a.ts", "docs/new.md"],
		});
	});
});

describe("triggers", () => {
	test("a trigger is command:, path: or tool:, and anything else is ignored", () => {
		expect(parseTrigger("command: gh pr create")).toEqual([{ type: "command", value: "gh pr create" }]);
		expect(parseTrigger("path:agent/src/**")).toEqual([{ type: "path", value: "agent/src/**" }]);
		expect(parseTrigger("tool:Subagent")).toEqual([{ type: "tool", value: "subagent" }]);
		expect(parseTrigger("opening a PR")).toBeUndefined();
		expect(parseTrigger("command:")).toBeUndefined();
	});

	test("conditions in one trigger, joined by +, must all hold", () => {
		expect(parseTrigger("tool:bash + command:pnpm test")).toEqual([
			{ type: "tool", value: "bash" },
			{ type: "command", value: "pnpm test" },
		]);
		const t = parseTrigger("tool:bash + command:pnpm test") as NonNullable<ReturnType<typeof parseTrigger>>;
		expect(triggerMatches(t, actionFromPi("bash", { command: "pnpm test" }), CWD)).toBe(true);
		expect(triggerMatches(t, actionFromPi("run_in_pane", { command: "pnpm test" }), CWD)).toBe(false);
		expect(parseTrigger("tool:bash + nonsense")).toBeUndefined();
	});

	test("command triggers match whole leading words of any command in a chain, past env settings and wrappers", () => {
		const t = parseTrigger("command:gh pr create");
		if (!t) throw new Error("no trigger");
		const m = (command: string) => triggerMatches(t, actionFromPi("bash", { command }), CWD);
		expect(m("gh pr create --draft --title x")).toBe(true);
		expect(m("git push -u origin x && gh pr create --fill")).toBe(true);
		expect(m("GH_TOKEN=abc gh  pr   create")).toBe(true);
		expect(m("env FOO=1 time gh pr create")).toBe(true);
		expect(m("gh pr view 12")).toBe(false);
		expect(m("timeout 60 gh pr create")).toBe(true);
		expect(m("for b in a; do gh pr create; done")).toBe(true);
		expect(m("gh -R org/repo pr create")).toBe(false);
		expect(m("gh --verbose pr create")).toBe(true);
		expect(m("gh pr createx")).toBe(false);
		expect(m("echo 'gh pr create'")).toBe(false);
		expect(actionFromPi("bash", { command: "pnpm test 2>&1 | tee out.log" }).commands).toEqual([
			["pnpm", "test"],
			["tee", "out.log"],
		]);
		expect(actionFromPi("bash", { command: "sleep 1 & gh pr create" }).commands).toEqual([
			["sleep", "1"],
			["gh", "pr", "create"],
		]);
	});

	test("text that only looks like a command never matches: heredoc bodies, quoted strings, comments", () => {
		const t = parseTrigger("command:pnpm test") as NonNullable<ReturnType<typeof parseTrigger>>;
		const m = (command: string) => triggerMatches(t, actionFromPi("bash", { command }), CWD);
		expect(m("cat > README.md <<'EOF'\npnpm test\nEOF")).toBe(false);
		expect(m("cat > a.md <<-EOF\n\tpnpm test\n\tEOF\nls")).toBe(false);
		expect(m("git commit -m 'run pnpm test first'")).toBe(false);
		expect(m("echo hi # pnpm test")).toBe(false);
		expect(m("cat > a.md <<'EOF'\nx\nEOF\npnpm test")).toBe(true);
	});

	test("commands run inside other commands still match: bash -c, subshells, $( ) and backticks", () => {
		const t = parseTrigger("command:pnpm test") as NonNullable<ReturnType<typeof parseTrigger>>;
		const m = (command: string) => triggerMatches(t, actionFromPi("bash", { command }), CWD);
		expect(m("bash -c 'pnpm test'")).toBe(true);
		expect(m('sh -lc "cd ui && pnpm test"')).toBe(true);
		expect(m("(cd ui; pnpm test)")).toBe(true);
		expect(m("echo $(pnpm test)")).toBe(true);
		expect(m("echo `pnpm test`")).toBe(true);
		expect(m("echo '$(pnpm test)'")).toBe(false);
	});

	test("edge cases found in review: heredocs inside subshells, comments, process substitution, quoting rules", () => {
		const t = parseTrigger("command:pnpm test") as NonNullable<ReturnType<typeof parseTrigger>>;
		const m = (command: string) => triggerMatches(t, actionFromPi("bash", { command }), CWD);
		expect(m("(cat <<'EOF'\n)\npnpm test\nEOF\n)")).toBe(false);
		expect(m('echo "$(echo x # )\n pnpm test\n)"')).toBe(true);
		expect(m('echo "$(pnpm test)')).toBe(false);
		expect(m("cat <<EOF\n$(pnpm test)\nEOF")).toBe(true);
		expect(m("cat <<'EOF'\n$(pnpm test)\nEOF")).toBe(false);
		expect(m("cat <<\\EOF\ntext\nEOF\npnpm test")).toBe(true);
		expect(m('bash -c "pnpm\\ test"')).toBe(false);
		expect(m('bash -c "echo \\"hi\\"; pnpm test"')).toBe(true);
		expect(m("cat <(pnpm test)")).toBe(true);
		expect(m("diff <(ls a) <(ls b) > d.txt")).toBe(false);
		expect(actionFromPi("bash", { command: "diff <(ls a) <(ls b) > d.txt" }).paths).toEqual(["d.txt"]);
	});

	test("a command it can't fully parse is ignored rather than guessed at", () => {
		const t = parseTrigger("command:pnpm test") as NonNullable<ReturnType<typeof parseTrigger>>;
		expect(triggerMatches(t, actionFromPi("bash", { command: "ls && echo 'pnpm test" }), CWD)).toBe(false);
		expect(actionFromPi("bash", { command: "ls && echo 'pnpm test" }).commands).toEqual([["ls"]]);
	});

	test("flags in the command are skipped unless the trigger names them", () => {
		const t = (x: string) => parseTrigger(x) as NonNullable<ReturnType<typeof parseTrigger>>;
		const run = (command: string) => actionFromPi("bash", { command });
		expect(triggerMatches(t("command:pnpm exec vitest"), run("pnpm -s exec vitest run x"), CWD)).toBe(true);
		expect(triggerMatches(t("command:git push -f"), run("git push origin x"), CWD)).toBe(false);
		expect(triggerMatches(t("command:git push -f"), run("git push -f origin x"), CWD)).toBe(true);
		expect(triggerMatches(t("command:pnpm exec vitest"), run("rtk proxy pnpm exec vitest"), CWD)).toBe(true);
	});

	test("path triggers match the file relative to the folder, absolute, or by name when the pattern has no folder", () => {
		const m = (pattern: string, path: string) => {
			const t = parseTrigger(`path:${pattern}`);
			if (!t) throw new Error("no trigger");
			return triggerMatches(t, actionFromHook("Edit", { file_path: path }), CWD);
		};
		expect(m("agent/src/**", "/work/app/agent/src/tools/x.ts")).toBe(true);
		expect(m("agent/src/**", "agent/src/x.ts")).toBe(true);
		expect(m("agent/src/**", "/work/app/ui/src/x.ts")).toBe(false);
		expect(m("*.test.ts", "/work/app/agent/src/x.test.ts")).toBe(true);
		expect(m("/etc/**", "/etc/hosts")).toBe(true);
	});

	test("tool triggers match the normalised tool name", () => {
		const t = parseTrigger("tool:subagent");
		if (!t) throw new Error("no trigger");
		expect(triggerMatches(t, actionFromHook("Agent", {}), CWD)).toBe(true);
		expect(triggerMatches(t, actionFromPi("subagent", {}), CWD)).toBe(true);
		expect(triggerMatches(t, actionFromPi("bash", { command: "ls" }), CWD)).toBe(false);
	});
});

describe("picking and wording the rules for an action", () => {
	const pr = entry("Open pull requests as drafts", ["command:gh pr create"]);
	const suite = entry("No full test suites unless asked", [
		"command:pnpm test",
		"command:pnpm check",
		"command:npx vitest",
	]);
	const shared = entry("Shared situations are off limits", ["path:agent/tests/situations/**"]);
	const plain = { ...entry("Plain rule", []), when: undefined };

	test("only entries with a matching trigger, never ones already shown in this session", () => {
		const all = [pr, suite, shared, plain];
		expect(entriesForAction(all, actionFromPi("bash", { command: "pnpm check" }), CWD)).toEqual([suite]);
		expect(entriesForAction(all, actionFromPi("bash", { command: "git push && gh pr create" }), CWD)).toEqual([pr]);
		expect(entriesForAction(all, actionFromPi("bash", { command: "pnpm check" }), CWD, new Set([suite.file]))).toEqual(
			[],
		);
		expect(
			entriesForAction(all, actionFromHook("Write", { file_path: "/work/app/agent/tests/situations/a.ts" }), CWD),
		).toEqual([shared]);
		expect(entriesForAction(all, actionFromPi("read", { path: "README.md" }), CWD)).toEqual([]);
	});

	test("the pause message carries each rule word for word, says it pauses once, and stays within its limit", () => {
		const { text, included } = pauseMessage([pr, suite], "/g");
		expect(included).toEqual([pr, suite]);
		expect(text).toContain("Open pull requests as drafts.");
		expect(text).toContain("No full test suites unless asked.");
		expect(text).toContain("/g/kinds/warnings/");
		expect(text).toMatch(/run it again/i);
		const many = Array.from({ length: 20 }, (_, i) => entry(`Long rule ${i}`, ["tool:bash"], "word ".repeat(2000)));
		const capped = pauseMessage(many, "/g");
		expect(capped.text.length).toBeLessThanOrEqual(6_000);
		for (const e of capped.included) {
			expect(capped.text).toContain(e.title);
			expect(capped.text).toContain(`/g/${e.file}`);
		}
		expect(capped.included.length).toBeGreaterThan(0);
		const tooMany = Array.from({ length: 80 }, (_, i) =>
			entry(`A rule with a fairly long title number ${i}`, ["tool:bash"]),
		);
		const cut = pauseMessage(tooMany, "/g");
		expect(cut.text.length).toBeLessThanOrEqual(6_000);
		expect(cut.included.length).toBeLessThan(80);
		for (const e of tooMany.filter((x) => !cut.included.includes(x))) expect(cut.text).not.toContain(`/g/${e.file}`);
	});
});

describe("measuring the triggers against real corrections", () => {
	test("a case is caught when one of its expected entries would have paused one of the agent's calls", () => {
		const pr = entry("Open pull requests as drafts", ["command:gh pr create"]);
		const suite = entry("No full test suites unless asked", ["command:pnpm test"]);
		const report = evaluateTriggers(
			[pr, suite],
			[
				{
					id: "a",
					harness: "pi",
					cwd: CWD,
					calls: [{ tool: "bash", input: { command: "gh pr create" } }],
					expect: [pr.file],
				},
				{
					id: "b",
					harness: "claude",
					cwd: CWD,
					calls: [{ tool: "Bash", input: { command: "pnpm test" } }],
					expect: [pr.file],
				},
				{
					id: "c",
					harness: "codex",
					cwd: CWD,
					calls: [{ tool: "Bash", input: { command: "ls" } }],
					expect: [suite.file],
				},
			],
		);
		expect(report.cases).toBe(3);
		expect(report.caught.map((c) => c.id)).toEqual(["a"]);
		expect(report.wrongOnly.map((c) => c.id)).toEqual(["b"]);
		expect(report.coverable).toBe(3);
		expect(report.pauses).toBe(2);
		const both = evaluateTriggers(
			[pr, { ...suite, when: ["command:gh pr create"] }],
			[
				{
					id: "d",
					harness: "pi",
					cwd: CWD,
					calls: [
						{ tool: "bash", input: { command: "gh pr create" } },
						{ tool: "bash", input: { command: "gh pr create" } },
					],
					expect: [],
				},
			],
		);
		expect(both.pauses).toBe(1);
		expect(both.delivered).toBe(2);
		expect(report.summary).toContain("1 of 3");
	});
});
