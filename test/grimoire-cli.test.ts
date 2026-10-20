import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	CLAUDE_CONTEXT_MAX,
	CODEX_CONTEXT_CHARS,
	claudeMdWithGrimoire,
	hookOutput,
	hooksWithGrimoire,
	hooksWithoutGrimoire,
	runGrimoireCli,
	sessionShown,
} from "../cli/grimoire.ts";
import { renderEntry, writeClaudeRoot } from "../extensions/grimoire.ts";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "sitra-grimoire-cli-")));

function grimoireWith(rootText: string, entries = 3): string {
	const dir = tmp();
	mkdirSync(join(dir, "root"));
	writeFileSync(join(dir, "root", "README.md"), rootText);
	mkdirSync(join(dir, "kinds", "lessons"), { recursive: true });
	for (let i = 0; i < entries; i++) {
		writeFileSync(
			join(dir, "kinds", "lessons", `2026-10-${String(i + 1).padStart(2, "0")}-lesson-${i}.md`),
			renderEntry({ kind: "lesson", title: `Lesson ${i}`, summary: `Do thing ${i}.`, body: "b", date: "2026-10-01" }),
		);
	}
	return dir;
}

const HOOK = "'/opt/sitra/bin/sitra.ts' grimoire hook";
const DIR = "--dir '/home/sam/.sitra/profile/grimoire'";

describe("session-start hook output", () => {
	test("Codex gets the root and the catalogue; Claude Code gets the catalogue (its root comes from CLAUDE.md imports)", () => {
		const dir = grimoireWith("# How Sam works\nAsk first.\n");
		const codex = JSON.parse(hookOutput("codex", dir, "Sam"));
		const codexText = codex.hookSpecificOutput.additionalContext as string;
		expect(codex.hookSpecificOutput.hookEventName).toBe("SessionStart");
		expect(codexText).toContain("Ask first.");
		expect(codexText).toContain("- [lesson] Lesson 0: Do thing 0.");

		const claude = JSON.parse(hookOutput("claude", dir, "Sam"));
		const claudeText = claude.hookSpecificOutput.additionalContext as string;
		expect(claudeText).not.toContain("Ask first.");
		expect(claudeText).toContain("- [lesson] Lesson 0: Do thing 0.");
		expect(claudeText).toContain("Only Sam approves");
		expect(claudeText).toContain("sitra grimoire search");
		expect(claudeText).not.toContain("grimoire_search");
	});

	test("Claude Code's text stays under its 10,000-character hook limit however big Grimoire gets", () => {
		const dir = grimoireWith("# root\n", 400);
		const text = JSON.parse(hookOutput("claude", dir, "Sam")).hookSpecificOutput.additionalContext as string;
		expect(text.length).toBeLessThanOrEqual(CLAUDE_CONTEXT_MAX);
		expect(text).toMatch(/…and \d+ more\. Find them with `sitra grimoire search/);
	});

	test("Codex's text stays within the character budget its token limit was set for, even with an oversized root", () => {
		const dir = grimoireWith(`# root\n${"x ".repeat(30_000)}\n`, 400);
		const text = JSON.parse(hookOutput("codex", dir, "Sam")).hookSpecificOutput.additionalContext as string;
		expect(text.length).toBeLessThanOrEqual(CODEX_CONTEXT_CHARS);
	});

	test("an empty or missing Grimoire still says how to propose", () => {
		const text = JSON.parse(hookOutput("codex", join(tmp(), "nope"), "Sam")).hookSpecificOutput.additionalContext;
		expect(text).toContain("proposals");
	});
});

describe("installing the hooks", () => {
	test("adds one session-start hook, keeps the person's other hooks, and is safe to run twice", () => {
		const theirs = {
			model: "opus",
			hooks: {
				SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "bash their-hook.sh" }] }],
				Stop: [{ hooks: [{ type: "command", command: "notify" }] }],
			},
		};
		const once = hooksWithGrimoire(theirs, { session: `${HOOK} claude ${DIR}` });
		const twice = hooksWithGrimoire(once, { session: `${HOOK} claude ${DIR}` });
		expect(twice).toEqual(once);
		expect(once.model).toBe("opus");
		expect(once.hooks.Stop).toEqual(theirs.hooks.Stop);
		expect(once.hooks.SessionStart).toHaveLength(2);
		expect(once.hooks.SessionStart[0]).toEqual(theirs.hooks.SessionStart[0]);
		expect(once.hooks.SessionStart[1]).toEqual({
			matcher: "startup|resume|clear|compact",
			hooks: [{ type: "command", command: `${HOOK} claude ${DIR}`, timeout: 10 }],
		});

		const codex = hooksWithGrimoire({}, { session: `${HOOK} codex ${DIR}`, additionalContextLimit: 12000 });
		expect(codex.hooks.SessionStart?.[0]?.hooks[0]).toEqual({
			type: "command",
			command: `${HOOK} codex ${DIR}`,
			timeout: 10,
			additionalContextLimit: 12000,
		});
	});

	test("the Claude root file is the capped root, rewritten only when it changes", () => {
		const dir = grimoireWith(`# How Sam works\n${"word ".repeat(10_000)}\n`);
		const file = writeClaudeRoot(dir, 1_000);
		const first = readFileSync(file, "utf8");
		expect(file).toBe(join(dir, ".sitra", "root.md"));
		expect(first).toContain("# How Sam works");
		expect(first.length).toBeLessThanOrEqual(1_000);
		const { mtimeMs } = statSync(file);
		writeClaudeRoot(dir, 1_000);
		expect(statSync(file).mtimeMs).toBe(mtimeMs);
		writeFileSync(join(dir, "root", "zz-new.md"), "# Newly approved root file\n");
		expect(readFileSync(writeClaudeRoot(dir, 100_000), "utf8")).toContain("Newly approved root file");
	});

	test("uninstalling removes only sitra's hook, even when another hook mentions the same words", () => {
		const theirs = {
			hooks: {
				SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "bash their-hook.sh" }] }],
				Stop: [{ hooks: [{ type: "command", command: 'printf "Remember: grimoire hook needs review"' }] }],
			},
		};
		const removed = hooksWithoutGrimoire(hooksWithGrimoire(theirs, { session: `${HOOK} claude ${DIR}` }));
		expect(removed).toEqual(theirs);
		expect(hooksWithoutGrimoire(hooksWithGrimoire({}, { session: `${HOOK} claude ${DIR}` }))).toEqual({ hooks: {} });
	});

	test("CLAUDE.md gets one managed block importing the root file, replaced where it is, and removed cleanly", () => {
		const mine = "# My rules\nBe brief.\n";
		const added = claudeMdWithGrimoire(mine, "/home/sam/My Notes/grimoire/.sitra/root.md");
		expect(added.startsWith(mine)).toBe(true);
		expect(added).toContain("@/home/sam/My\\ Notes/grimoire/.sitra/root.md");
		const withMore = `${added}\n# Later rules\nStay kind.\n`;
		const updated = claudeMdWithGrimoire(withMore, "/home/sam/g/.sitra/root.md");
		expect(updated.match(/sitra grimoire: start/g)).toHaveLength(1);
		expect(updated.indexOf("@/home/sam/g/.sitra/root.md")).toBeLessThan(updated.indexOf("# Later rules"));
		expect(updated).not.toContain("My\\ Notes");
		expect(claudeMdWithGrimoire(updated, undefined)).toBe(`${mine}\n# Later rules\nStay kind.\n`);
	});

	test("settings that aren't a JSON object with hook lists are refused, not rewritten", () => {
		for (const bad of ["a string", 3, [], { hooks: [] }, { hooks: { SessionStart: {} } }, { hooks: { Stop: [3] } }]) {
			expect(() => hooksWithGrimoire(bad as never, { session: `${HOOK} claude ${DIR}` })).toThrow(
				/not a settings object/,
			);
		}
	});
});

describe("running the hook from another tool", () => {
	test("uses the Grimoire folder it was installed with, not whatever the tool's environment says, and refreshes the Claude root", () => {
		const dir = grimoireWith("# How Sam works\n");
		const out: string[] = [];
		const code = runGrimoireCli(["hook", "claude", "--dir", dir], {
			home: tmp(),
			env: { SITRA_USER_NAME: "Sam" },
			repoRoot: "/opt/sitra",
			cwd: tmp(),
			readStdin: () => "{}",
			log: (l) => out.push(l),
		});
		expect(code).toBe(0);
		const text = JSON.parse(out.join("\n")).hookSpecificOutput.additionalContext as string;
		expect(text).toContain(`Approved entries (3, in ${dir})`);
		expect(text).toContain(`--dir '${dir}'`);
		expect(readFileSync(join(dir, ".sitra", "root.md"), "utf8")).toContain("# How Sam works");
	});
});

describe("rules tied to actions in Claude Code and Codex", () => {
	function withDraftRule(): string {
		const dir = grimoireWith("# root\n", 0);
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
		return dir;
	}
	const runHook = (dir: string, tool: "claude" | "codex", payload: unknown) => {
		const out: string[] = [];
		const code = runGrimoireCli(["hook", tool, "tool", "--dir", dir], {
			home: tmp(),
			env: {},
			repoRoot: "/opt/sitra",
			cwd: "/work",
			readStdin: () => JSON.stringify(payload),
			log: (l) => out.push(l),
		});
		return { code, out: out.join("\n") };
	};

	test("the tool hook denies a matching action once per session with the rule as the reason, then stays quiet", () => {
		const dir = withDraftRule();
		const payload = (session: string, command: string) => ({
			session_id: session,
			cwd: "/work",
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input: { command },
		});
		expect(runHook(dir, "claude", payload("s1", "gh pr view 2")).out).toBe("");
		const first = JSON.parse(runHook(dir, "claude", payload("s1", "gh pr create --fill")).out);
		expect(first.hookSpecificOutput.permissionDecision).toBe("deny");
		expect(first.hookSpecificOutput.permissionDecisionReason).toContain("Always pass --draft.");
		expect(runHook(dir, "claude", payload("s1", "gh pr create --fill")).out).toBe("");
		expect(JSON.parse(runHook(dir, "codex", payload("s2", "gh pr create")).out).hookSpecificOutput.hookEventName).toBe(
			"PreToolUse",
		);
	});

	test("anything unexpected means no opinion: odd payloads, a broken Grimoire folder", () => {
		const dir = withDraftRule();
		const quiet = (payload: string, where = dir) => {
			const out: string[] = [];
			const code = runGrimoireCli(["hook", "claude", "tool", "--dir", where], {
				home: tmp(),
				env: {},
				repoRoot: "/opt/sitra",
				cwd: "/work",
				readStdin: () => payload,
				log: (l) => out.push(l),
			});
			return code === 0 && out.join("") === "";
		};
		for (const p of ["not json", "null", "3", '{"tool_name":1}', '{"tool_name":"Bash","tool_input":"x"}']) {
			expect(quiet(p)).toBe(true);
		}
		expect(quiet(JSON.stringify({ session_id: 7, tool_name: "Bash", tool_input: { command: "gh pr create" } }))).toBe(
			false,
		);
		const broken = withDraftRule();
		writeFileSync(join(broken, ".sitra"), "not a folder");
		expect(
			quiet(JSON.stringify({ session_id: "s", tool_name: "Bash", tool_input: { command: "gh pr create" } }), broken),
		).toBe(true);
	});

	test("parallel hook processes in one session each remember what they showed", async () => {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const dir = withDraftRule();
		writeFileSync(
			join(dir, "kinds", "decisions", "2026-10-20-suite.md"),
			renderEntry({
				kind: "decision",
				title: "No full suites",
				body: "Ask first.",
				date: "2026-10-20",
				when: ["command:pnpm test"],
			}),
		);
		const bin = join(process.cwd(), "bin", "sitra.ts");
		const call = async (command: string) => {
			const child = promisify(execFile)("node", [bin, "grimoire", "hook", "claude", "tool", "--dir", dir], {});
			child.child.stdin?.end(
				JSON.stringify({ session_id: "par", cwd: "/work", tool_name: "Bash", tool_input: { command } }),
			);
			return (await child).stdout.trim();
		};
		const [a, b] = await Promise.all([call("gh pr create"), call("pnpm test")]);
		expect(a).toContain("deny");
		expect(b).toContain("deny");
		const [a2, b2] = await Promise.all([call("gh pr create"), call("pnpm test")]);
		expect(a2).toBe("");
		expect(b2).toBe("");
	}, 30_000);

	test("two hook processes that read the session's notes at the same moment both keep what they showed", () => {
		const dir = withDraftRule();
		const first = sessionShown(dir, "race");
		const second = sessionShown(dir, "race");
		expect(first.has("kinds/a.md")).toBe(false);
		expect(second.has("kinds/b.md")).toBe(false);
		expect(second.claim("kinds/b.md")).toBe(true);
		expect(first.claim("kinds/a.md")).toBe(true);
		expect(first.claim("kinds/b.md")).toBe(false);
		const later = sessionShown(dir, "race");
		expect(later.has("kinds/a.md") && later.has("kinds/b.md")).toBe(true);
	});

	test("an active session's memory survives the clean-up of old sessions", async () => {
		const { utimesSync, readdirSync } = await import("node:fs");
		const dir = withDraftRule();
		const payload = (session: string, command: string) => ({
			session_id: session,
			cwd: "/work",
			tool_name: "Bash",
			tool_input: { command },
		});
		runHook(dir, "claude", payload("old", "gh pr create"));
		const shown = join(dir, ".sitra", "shown");
		const old = new Date(Date.now() - 5 * 86_400_000);
		for (const f of readdirSync(shown)) utimesSync(join(shown, f), old, old);
		expect(runHook(dir, "claude", payload("old", "ls")).out).toBe("");
		runHook(dir, "claude", payload("new", "gh pr create"));
		expect(runHook(dir, "claude", payload("old", "gh pr create")).out).toBe("");
	});

	test("sitra grimoire install wires both hooks into Claude Code and Codex", () => {
		const home = tmp();
		mkdirSync(join(home, ".claude"));
		mkdirSync(join(home, ".codex"));
		const dir = withDraftRule();
		runGrimoireCli(["install", "--dir", dir], {
			home,
			env: {},
			repoRoot: "/opt/sitra",
			cwd: "/work",
			readStdin: () => "",
			log: () => {},
		});
		const claude = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
		expect(claude.hooks.PreToolUse[0].hooks[0].command).toMatch(/grimoire hook claude tool --dir /);
		expect(claude.hooks.PreToolUse[0].matcher).toContain("Bash");
		const codex = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));
		expect(codex.hooks.PreToolUse[0].hooks[0].command).toMatch(/grimoire hook codex tool --dir /);
		expect(codex.hooks.PreToolUse[0].matcher).toContain("apply_patch");
	});

	test("install adds a PreToolUse hook next to the session hook, and uninstall removes both", () => {
		const both = hooksWithGrimoire(
			{},
			{ session: `${HOOK} claude ${DIR}`, tool: `${HOOK} claude tool ${DIR}`, toolMatcher: "Bash|Edit" },
		);
		expect(both.hooks.PreToolUse).toEqual([
			{ matcher: "Bash|Edit", hooks: [{ type: "command", command: `${HOOK} claude tool ${DIR}`, timeout: 10 }] },
		]);
		expect(
			hooksWithGrimoire(both, {
				session: `${HOOK} claude ${DIR}`,
				tool: `${HOOK} claude tool ${DIR}`,
				toolMatcher: "Bash|Edit",
			}),
		).toEqual(both);
		expect(hooksWithoutGrimoire(both)).toEqual({ hooks: {} });
	});
});
