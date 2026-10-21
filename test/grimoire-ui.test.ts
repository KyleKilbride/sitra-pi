import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { writeConfig } from "../cli/config.ts";
import { installGrimoireHooks } from "../cli/grimoire.ts";
import {
	LIMITS,
	listEntries,
	listProposals,
	listRejected,
	loadRoot,
	parseEntry,
	renderEntry,
	writeClaudeRoot,
	writeProposal,
} from "../extensions/grimoire.ts";
import {
	dayLog,
	type GrimoireServer,
	snapshot,
	startGrimoireServer,
	validateGrimoirePath,
} from "../extensions/grimoire-ui.ts";
import { recordMoment, tally } from "../extensions/learn.ts";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "sitra-grimoire-ui-")));

const servers: GrimoireServer[] = [];
afterEach(async () => {
	while (servers.length > 0) {
		const s = servers.pop();
		if (s) await s.close();
	}
});

/** Sends an HTTP request with an explicit Host header so we can test DNS rebinding protection. */
function rawRequest(options: {
	port: number;
	path: string;
	method?: string;
	host?: string;
	headers?: Record<string, string>;
	body?: string;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname: "127.0.0.1",
				port: options.port,
				path: options.path,
				method: options.method ?? "GET",
				headers: {
					...(options.host !== undefined ? { Host: options.host } : {}),
					...(options.body
						? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(options.body)) }
						: {}),
					...options.headers,
				},
			},
			(res) => {
				let data = "";
				res.on("data", (chunk) => {
					data += chunk;
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
			},
		);
		req.on("error", reject);
		if (options.body) req.write(options.body);
		req.end();
	});
}

describe("path validation", () => {
	test("allows only .md files inside root/, kinds/<plural>/, proposals/ and rejected/, and rejects traversal or escape", () => {
		const dir = tmp();
		expect(validateGrimoirePath(dir, "root/README.md", ["root"])).toBe("root/README.md");
		expect(validateGrimoirePath(dir, "kinds/warnings/2026-10-20-rule.md", ["kinds"])).toBe(
			"kinds/warnings/2026-10-20-rule.md",
		);
		expect(validateGrimoirePath(dir, "proposals/2026-10-20-draft.md", ["proposals"])).toBe(
			"proposals/2026-10-20-draft.md",
		);
		expect(validateGrimoirePath(dir, "rejected/2026-10-20-no.md", ["rejected"])).toBe("rejected/2026-10-20-no.md");

		for (const bad of [
			"",
			"/etc/passwd",
			"/tmp/evil.md",
			"../secret.md",
			"root/../proposals/x.md",
			"root/../../outside.md",
			"kinds/warnings/../../root/README.md",
			"root/sub/nested.md",
			"kinds/rumors/2026-10-20-x.md",
			"kinds/warnings/sub/x.md",
			"root/notes.txt",
			".sitra/pauses.jsonl",
			".sitra/root.md",
			"root/bad\\name.md",
			"root/bad\0name.md",
		]) {
			expect(() => validateGrimoirePath(dir, bad)).toThrow();
		}
		expect(() => validateGrimoirePath(dir, "proposals/a.md", ["root"])).toThrow();

		// Symlink escape inside root/ pointing outside dir is rejected
		const outside = tmp();
		const outsideFile = join(outside, "escaped.md");
		writeFileSync(outsideFile, "# Outside\n");
		mkdirSync(join(dir, "root"), { recursive: true });
		symlinkSync(outsideFile, join(dir, "root", "link.md"));
		expect(() => validateGrimoirePath(dir, "root/link.md", ["root"])).toThrow();
	});
});

describe("snapshot: what agents get, hooks and settings", () => {
	test("reports the exact lead prompt, character counts against LIMITS, Claude Code and Codex root/hooks, and settings", () => {
		const home = tmp();
		const sitra = join(home, ".sitra");
		const dir = join(sitra, "profile", "grimoire");
		mkdirSync(join(dir, "root"), { recursive: true });
		writeFileSync(join(dir, "root", "README.md"), "# Start here\nAlways check live state.\n");
		writeFileSync(join(dir, "root", "decisions.md"), "# Decisions\nKeep logic pure.\n");
		mkdirSync(join(dir, "kinds", "warnings"), { recursive: true });
		writeFileSync(
			join(dir, "kinds", "warnings", "2026-10-20-drafts.md"),
			renderEntry({
				kind: "warning",
				title: "Open pull requests as drafts",
				summary: "Always pass --draft when creating a pull request.",
				body: "Review happens in draft PRs.",
				date: "2026-10-20",
				tags: ["git", "pr"],
				when: ["command:gh pr create"],
			}),
		);
		writeClaudeRoot(dir);
		writeConfig(sitra, { name: "Sam", skills: [], learn: false, learnModel: "openai/gpt-6-mini" });

		// Before installing Claude/Codex hooks: both report not installed.
		const before = snapshot(dir, {
			HOME: home,
			SITRA_HOME: sitra,
			SITRA_USER_NAME: "Sam",
			SITRA_SHARPEN: "1",
			SITRA_GRIMOIRE_LOOK: "0",
		});

		expect(before.whatAgentsGet.everyPrompt.text).toContain("# Grimoire: Sam's approved knowledge");
		expect(before.whatAgentsGet.everyPrompt.text).toContain("Always check live state.");
		expect(before.whatAgentsGet.everyPrompt.text).toContain("Open pull requests as drafts");
		expect(before.whatAgentsGet.root.chars).toBe(loadRoot(dir).chars);
		expect(before.whatAgentsGet.root.limit).toBe(LIMITS.rootChars);
		expect(before.whatAgentsGet.catalogue.chars).toBeGreaterThan(0);
		expect(before.whatAgentsGet.catalogue.limit).toBe(LIMITS.catalogueChars);
		expect(before.whatAgentsGet.claudeCode.rootText).toContain("Always check live state.");
		expect(before.whatAgentsGet.codex.rootText).toContain("Always check live state.");
		expect(before.whatAgentsGet.hooks.claudeCode.status).toBe("not installed");
		expect(before.whatAgentsGet.hooks.codex.status).toBe("not installed");

		// Install hooks into ~/.claude and ~/.codex and verify both flip to installed.
		mkdirSync(join(home, ".claude"), { recursive: true });
		mkdirSync(join(home, ".codex"), { recursive: true });
		installGrimoireHooks({ home, repoRoot: "/opt/sitra", log() {} }, dir);

		const after = snapshot(dir, {
			HOME: home,
			SITRA_HOME: sitra,
			SITRA_USER_NAME: "Sam",
			SITRA_SHARPEN: "1",
			SITRA_GRIMOIRE_LOOK: "0",
		});

		expect(after.whatAgentsGet.hooks.claudeCode.status).toBe("installed");
		expect(after.whatAgentsGet.hooks.codex.status).toBe("installed");
		expect(after.whatAgentsGet.settings.extensions).toContain("./extensions/knowledge.ts");
		expect(after.whatAgentsGet.settings.extensions).toContain("./extensions/grimoire-ui-pi.ts");
		expect(after.whatAgentsGet.settings.env.SITRA_SHARPEN).toBe("1");
		expect(after.whatAgentsGet.settings.env.SITRA_GRIMOIRE_LOOK).toBe("0");
		expect(after.whatAgentsGet.settings.learn).toBe(false);
		expect(after.whatAgentsGet.settings.learnModel).toBe("openai/gpt-6-mini");
	});
});

describe("HTTP server security: token, Host header and path escape", () => {
	test("binds to 127.0.0.1, requires the token on every route, and rejects any non-matching Host header", async () => {
		const dir = tmp();
		const srv = await startGrimoireServer({ dir, env: { HOME: dir } });
		servers.push(srv);

		expect(srv.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+$/);
		expect(srv.url).not.toContain("localhost");

		// Missing or wrong token on page and API routes -> 401
		const noTokenPage = await fetch(`http://127.0.0.1:${srv.port}/`);
		expect(noTokenPage.status).toBe(401);
		const badTokenApi = await fetch(`http://127.0.0.1:${srv.port}/api/snapshot?token=wrong`);
		expect(badTokenApi.status).toBe(401);
		const noTokenPost = await fetch(`http://127.0.0.1:${srv.port}/api/entries`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ kind: "lesson", title: "T", body: "B" }),
		});
		expect(noTokenPost.status).toBe(401);

		// Wrong Host header (DNS rebinding attempt or localhost) -> 403 even with valid token
		for (const host of [`localhost:${srv.port}`, `evil.example:${srv.port}`, "127.0.0.1", "evil.example"]) {
			const rebind = await rawRequest({
				port: srv.port,
				path: `/api/snapshot?token=${srv.token}`,
				host,
			});
			expect(rebind.status).toBe(403);
		}

		// Valid Host + valid token -> 200
		const okPage = await fetch(srv.url);
		expect(okPage.status).toBe(200);
		const html = await okPage.text();
		expect(html).toContain("<!DOCTYPE html>");
		expect(html).toContain("What agents get");

		const okSnap = await fetch(`http://127.0.0.1:${srv.port}/api/snapshot?token=${srv.token}`);
		expect(okSnap.status).toBe(200);

		// Path escape over HTTP API -> 400
		for (const badFile of [
			"../outside.md",
			"/tmp/abs.md",
			"root/../../escape.md",
			"kinds/lessons/../../root/x.md",
			"root/notes.txt",
		]) {
			const res = await fetch(`http://127.0.0.1:${srv.port}/api/root?token=${srv.token}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ file: badFile, content: "x" }),
			});
			expect(res.status).toBe(400);
		}
	});

	test("stops automatically after the idle timeout", async () => {
		const dir = tmp();
		const srv = await startGrimoireServer({ dir, env: { HOME: dir }, idleMs: 60 });
		servers.push(srv);
		const first = await fetch(srv.url);
		expect(first.status).toBe(200);
		await new Promise((r) => setTimeout(r, 120));
		await expect(fetch(srv.url)).rejects.toThrow();
	});
});

describe("CRUD: root, add, edit, move, delete, accept, reject, restore and link repointing", () => {
	test("manages root files, approved entries, proposals and rejected entries, and repoints or removes broken links", async () => {
		const dir = tmp();
		const srv = await startGrimoireServer({ dir, env: { HOME: dir, SITRA_USER_NAME: "Sam" } });
		servers.push(srv);
		const api = async <T = Record<string, unknown>>(path: string, method = "GET", body?: unknown) => {
			const sep = path.includes("?") ? "&" : "?";
			const res = await fetch(`http://127.0.0.1:${srv.port}${path}${sep}token=${srv.token}`, {
				method,
				headers: body ? { "Content-Type": "application/json" } : undefined,
				body: body ? JSON.stringify(body) : undefined,
			});
			return { status: res.status, data: (await res.json()) as T };
		};

		// 1. Save a root file
		const savedRoot = await api("/api/root", "PUT", {
			file: "root/README.md",
			content: "# Root\nStart here.\n",
		});
		expect(savedRoot.status).toBe(200);
		expect(loadRoot(dir).text).toBe("# Root\nStart here.");

		// 2. Add two approved entries
		const added1 = await api<{ entry: { file: string; when: string[] } }>("/api/entries", "POST", {
			kind: "lesson",
			title: "Trace failures through git history",
			summary: "Run git log -S before guessing why a test failed.",
			body: "Git history shows who changed the behaviour and why.",
			date: "2026-10-20",
			tags: ["git", "debugging"],
			when: ["command:git log", "not a trigger"],
		});
		expect(added1.status).toBe(200);
		const file1 = added1.data.entry.file;
		expect(file1).toBe("kinds/lessons/2026-10-20-trace-failures-through-git-history.md");
		expect(added1.data.entry.when).toEqual(["command:git log"]);

		const added2 = await api<{ entry: { file: string } }>("/api/entries", "POST", {
			kind: "decision",
			title: "Proof before claims",
			summary: "Label every claim and start from raw history.",
			body: `See ${file1} before claiming a root cause.`,
			date: "2026-10-20",
			links: [file1],
		});
		expect(added2.status).toBe(200);
		const file2 = added2.data.entry.file;

		// Also link to file1 from root/README.md
		await api("/api/root", "PUT", {
			file: "root/README.md",
			content: `# Root\nAlways follow [git history](../${file1}).\n`,
		});

		// 3. Edit entry 1 in place
		const edited1 = await api("/api/entries", "PUT", {
			file: file1,
			title: "Trace failures through git history first",
			summary: "Check git log -S first.",
			body: "Updated body.",
			tags: ["git"],
			when: ["tool:bash + command:git log"],
		});
		expect(edited1.status).toBe(200);
		expect(parseEntry(readFileSync(join(dir, file1), "utf8"), file1)).toMatchObject({
			title: "Trace failures through git history first",
			summary: "Check git log -S first.",
			body: "Updated body.",
			tags: ["git"],
			when: ["tool:bash + command:git log"],
		});

		// 4. Moving file1 to 'warning' detects links from root/README.md and file2 first (409)
		const moveCheck = await api<{ brokenLinks: Array<{ file: string }> }>("/api/move", "POST", {
			file: file1,
			kind: "warning",
		});
		expect(moveCheck.status).toBe(409);
		expect(moveCheck.data.brokenLinks.map((l) => l.file).sort()).toEqual(["root/README.md", file2].sort());

		// Moving file1 with onLinks: "repoint" moves the file and updates both root/README.md and file2
		const moved = await api<{ file: string }>("/api/move", "POST", {
			file: file1,
			kind: "warning",
			onLinks: "repoint",
		});
		expect(moved.status).toBe(200);
		const movedFile = moved.data.file;
		expect(movedFile).toBe("kinds/warnings/2026-10-20-trace-failures-through-git-history.md");
		expect(existsSync(join(dir, file1))).toBe(false);
		expect(parseEntry(readFileSync(join(dir, movedFile), "utf8"), movedFile)?.kind).toBe("warning");
		expect(readFileSync(join(dir, "root/README.md"), "utf8")).toContain(`../${movedFile}`);
		const updatedEntry2 = parseEntry(readFileSync(join(dir, file2), "utf8"), file2);
		expect(updatedEntry2?.links).toEqual([movedFile]);
		expect(updatedEntry2?.body).toContain(movedFile);

		// 5. Deleting movedFile detects links first (409), and can remove or repoint them, moving the entry to rejected/
		const delCheck = await api<{ brokenLinks: Array<{ file: string }> }>("/api/entries", "DELETE", {
			file: movedFile,
		});
		expect(delCheck.status).toBe(409);
		expect(delCheck.data.brokenLinks.map((l) => l.file).sort()).toEqual(["root/README.md", file2].sort());

		const deleted = await api<{ file: string }>("/api/entries", "DELETE", { file: movedFile, onLinks: "remove" });
		expect(deleted.status).toBe(200);
		expect(deleted.data.file).toBe("rejected/2026-10-20-trace-failures-through-git-history.md");
		expect(existsSync(join(dir, movedFile))).toBe(false);
		expect(listRejected(dir).map((e) => e.file)).toContain("rejected/2026-10-20-trace-failures-through-git-history.md");
		expect(readFileSync(join(dir, "root/README.md"), "utf8")).not.toContain(movedFile);
		expect(parseEntry(readFileSync(join(dir, file2), "utf8"), file2)?.links).toBeUndefined();

		// 6. Restore the rejected entry back to kinds/, then test delete with repointTo
		const restored = await api<{ entry: { file: string } }>("/api/restore", "POST", {
			file: "rejected/2026-10-20-trace-failures-through-git-history.md",
		});
		expect(restored.status).toBe(200);
		expect(restored.data.entry.file).toBe("kinds/warnings/2026-10-20-trace-failures-through-git-history.md");
		expect(listRejected(dir)).toEqual([]);

		// Link root/README.md to movedFile again and delete movedFile repointing to file2
		await api("/api/root", "PUT", {
			file: "root/README.md",
			content: `# Root\nSee [rule](../${movedFile}).\n`,
		});
		const deletedRepoint = await api("/api/entries", "DELETE", {
			file: movedFile,
			onLinks: "repoint",
			repointTo: file2,
		});
		expect(deletedRepoint.status).toBe(200);
		expect(readFileSync(join(dir, "root/README.md"), "utf8")).toContain(`../${file2}`);
		expect(listEntries(dir).map((e) => e.file)).toEqual([file2]);

		// 7. Proposals: edit, accept (choosing a kind) and reject
		const propA = writeProposal(dir, {
			kind: "lesson",
			title: "Proposal A",
			summary: "Summary A",
			body: "Body A",
			date: "2026-10-20",
		});
		const propB = writeProposal(dir, {
			kind: "fact",
			title: "Proposal B",
			summary: "Summary B",
			body: "Body B",
			date: "2026-10-20",
		});
		await api("/api/entries", "PUT", { file: propA, title: "Proposal A edited", body: "Body A edited" });
		const accepted = await api<{ entry: { file: string; title: string } }>("/api/accept", "POST", {
			file: propA,
			kind: "decision",
		});
		expect(accepted.status).toBe(200);
		expect(accepted.data.entry.file).toMatch(/^kinds\/decisions\//);
		expect(accepted.data.entry.title).toBe("Proposal A edited");

		const rejected = await api<{ file: string }>("/api/reject", "POST", { file: propB });
		expect(rejected.status).toBe(200);
		expect(rejected.data.file).toMatch(/^rejected\//);
		expect(listProposals(dir)).toEqual([]);
	});
});

describe("Today's log: pauses, corrections and repeats for a date", () => {
	test("returns pauses, corrections and repeats newest first, matching tally(), and filters by date", async () => {
		const dir = tmp();
		mkdirSync(join(dir, "kinds", "warnings"), { recursive: true });
		const ruleFile = "kinds/warnings/2026-10-20-no-full-suite.md";
		writeFileSync(
			join(dir, ruleFile),
			renderEntry({
				kind: "warning",
				title: "No full test suites unless asked",
				summary: "Run only targeted tests.",
				body: "Full suites take 30 minutes.",
				date: "2026-10-20",
				when: ["command:pnpm test"],
			}),
		);
		mkdirSync(join(dir, ".sitra"), { recursive: true });

		const t1 = new Date(2026, 9, 20, 9, 0, 0).toISOString();
		const t2 = new Date(2026, 9, 20, 10, 0, 0).toISOString();
		const t3 = new Date(2026, 9, 20, 11, 0, 0).toISOString();
		const t4 = new Date(2026, 9, 20, 12, 0, 0).toISOString();
		const t5 = new Date(2026, 9, 20, 13, 0, 0).toISOString();
		const prevDay = new Date(2026, 9, 19, 15, 0, 0).toISOString();

		// Pauses: one caught (changed), one repeated, and one on the previous day
		appendFileSync(
			join(dir, ".sitra", "pauses.jsonl"),
			`${[
				JSON.stringify({
					at: t1,
					file: ruleFile,
					outcome: "changed",
					session: "s-alpha",
					cwd: "/work/repo-a",
					call: { tool: "bash", input: { command: "pnpm test" } },
				}),
				JSON.stringify({
					at: t2,
					file: ruleFile,
					outcome: "repeated",
					session: "s-beta",
					cwd: "/work/repo-b",
					call: { tool: "bash", input: { command: "pnpm test" } },
				}),
				JSON.stringify({
					at: prevDay,
					file: ruleFile,
					outcome: "changed",
				}),
			].join("\n")}\n`,
		);

		// Moments:
		// 1) A correction that drafted a proposal (learned)
		recordMoment(dir, {
			id: "m-learned",
			at: t3,
			harness: "pi",
			cwd: "/work/repo-a",
			message: "Always open pull requests as drafts",
			agentReply: "Opened the PR.",
			calls: [{ tool: "bash", input: { command: "gh pr create" } }],
			verdict: "correction",
			proposal: "proposals/2026-10-20-open-prs-as-drafts.md",
		});
		// 2) A correction already covered by an existing rule (repeat)
		recordMoment(dir, {
			id: "m-repeat",
			at: t4,
			harness: "claude",
			cwd: "/work/repo-b",
			message: "Don't run the full test suite",
			agentReply: "Running pnpm test.",
			calls: [{ tool: "Bash", input: { command: "pnpm test" } }],
			verdict: "correction",
			skipped: `Already covered by ${ruleFile}`,
		});
		// 3) A message judged not a correction
		recordMoment(dir, {
			id: "m-other",
			at: t5,
			harness: "pi",
			cwd: "/work/repo-a",
			message: "Looks good",
			agentReply: "Done.",
			calls: [],
			verdict: "other",
		});

		const srv = await startGrimoireServer({ dir, env: { HOME: dir } });
		servers.push(srv);
		const res = await fetch(`http://127.0.0.1:${srv.port}/api/log?date=2026-10-20&token=${srv.token}`);
		expect(res.status).toBe(200);
		const log = (await res.json()) as ReturnType<typeof dayLog>;

		// Matches tally() for 2026-10-20
		expect(log.tally).toEqual(tally(dir, new Date(2026, 9, 20, 23, 59, 59, 999)));
		expect(log.tally).toEqual({ caught: 1, learned: 1, repeats: 1 });

		// Pauses newest first
		expect(log.pauses).toHaveLength(2);
		expect(log.pauses[0]).toMatchObject({
			at: t2,
			session: "s-beta",
			repo: "/work/repo-b",
			outcome: "repeated",
		});
		expect(log.pauses[1]).toMatchObject({
			at: t1,
			session: "s-alpha",
			repo: "/work/repo-a",
			outcome: "caught",
		});
		expect(log.pauses[1]?.entries[0]).toMatchObject({
			file: ruleFile,
			title: "No full test suites unless asked",
		});
		expect(log.pauses[1]?.when).toContain("command:pnpm test");
		expect(log.pauses[1]?.action.command).toBe("pnpm test");

		// Corrections newest first
		expect(log.corrections).toHaveLength(3);
		expect(log.corrections[0]).toMatchObject({ id: "m-other", verdict: "other" });
		expect(log.corrections[1]).toMatchObject({
			id: "m-repeat",
			message: "Don't run the full test suite",
			verdict: "correction",
			outcome: "repeat",
			covered: `Already covered by ${ruleFile}`,
		});
		expect(log.corrections[2]).toMatchObject({
			id: "m-learned",
			message: "Always open pull requests as drafts",
			verdict: "correction",
			outcome: "learned",
			proposal: "proposals/2026-10-20-open-prs-as-drafts.md",
		});

		// Repeats
		expect(log.repeats).toHaveLength(1);
		expect(log.repeats[0]).toMatchObject({
			id: "m-repeat",
			message: "Don't run the full test suite",
			covered: `Already covered by ${ruleFile}`,
		});

		// Combined events are newest first
		const times = log.events.map((e) => e.at);
		expect(times).toEqual([...times].sort().reverse());

		// Earlier day filter
		const prevLog = dayLog(dir, "2026-10-19");
		expect(prevLog.tally).toEqual({ caught: 1, learned: 0, repeats: 0 });
		expect(prevLog.pauses).toHaveLength(1);
	});
});
