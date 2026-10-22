import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const LOOP_EXT = fileURLToPath(new URL("../extensions/loop-pi.ts", import.meta.url));
const MODEL = fileURLToPath(new URL("./fixtures/loop-model.ts", import.meta.url));

function gitWorktree(): string {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-e2e-work-")));
	execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
	writeFileSync(join(cwd, "README.md"), "test\n");
	execFileSync("git", ["add", "README.md"], { cwd, stdio: "ignore" });
	execFileSync("git", ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", "initial"], {
		cwd,
		stdio: "ignore",
	});
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
	execFileSync("git", ["remote", "add", "origin", cwd], { cwd, stdio: "ignore" });
	execFileSync("git", ["update-ref", "refs/remotes/origin/main", head], { cwd, stdio: "ignore" });
	execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], {
		cwd,
		stdio: "ignore",
	});
	execFileSync("git", ["checkout", "-b", "feature"], { cwd, stdio: "ignore" });
	return cwd;
}

function sessionFileWithHelperReport(profile: string, report: unknown): string {
	const file = join(profile, `helper-${sessionFileWithHelperReport.next++}.jsonl`);
	writeFileSync(
		file,
		`${JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "helper_report", details: report } })}\n`,
	);
	return file;
}
sessionFileWithHelperReport.next = 1;

const helperReport = (role: string, summary: string, details: unknown, openQuestions: string[] = []) => ({
	status: openQuestions.length ? "needs-input" : "done",
	role,
	summary,
	evidence: [`${role}.md:1`],
	openQuestions,
	assumptions: [],
	details,
});

test("loop runner e2e: explicit start to advisor reports, person answer, plan, architecture, and brief-approved", async () => {
	const cwd = gitWorktree();
	const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-e2e-profile-")));
	const records: { type?: string; message?: { role?: string; content?: unknown; customType?: string } }[] = [];
	const helper = (agent: string, report: unknown) => ({
		id: `${agent}-1`,
		name: agent,
		agent,
		status: "completed",
		outputTokens: 40,
		contextTokens: 60,
		sessionFile: sessionFileWithHelperReport(profile, report),
	});

	await new Promise<void>((resolve, reject) => {
		let answered = false;
		let planned = false;
		let approved = false;
		const fail = setTimeout(() => {
			child.kill();
			reject(new Error(`timed out\nrecords:\n${JSON.stringify(records, null, 2)}\nstderr:\n${stderr}`));
		}, 60_000);
		const child = spawn(
			"pi",
			[
				"--mode",
				"rpc",
				"--no-extensions",
				"-e",
				LOOP_EXT,
				"-e",
				MODEL,
				"--no-session",
				"--model",
				"sitra-loop-faux/script",
			],
			{
				cwd,
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: profile,
					SITRA_LOOP_MODEL_SCRIPT: JSON.stringify(Array.from({ length: 40 }, () => ({ text: "ack" }))),
					SITRA_LOOP_AUTO_HELPERS: JSON.stringify([
						{
							when: "Start intent-advisor",
							messages: [
								helper(
									"intent-advisor",
									helperReport("intent", "Intent found decisions.", {
										questions: [
											{
												id: "q-command",
												text: "Use /loop start?",
												recommended: "Yes, use /loop start.",
												dependsOn: [],
											},
											{
												id: "q-approval",
												text: "Ask for approval before build?",
												recommended: "Yes, freeze the brief first.",
												dependsOn: [],
											},
										],
										doneCandidates: ["Brief approved."],
										ambiguities: [],
									}),
								),
								helper(
									"codebase-advisor",
									helperReport(
										"codebase",
										"Codebase maps to extensions.",
										{
											files: ["extensions/loop.ts"],
											existingTests: [],
											facts: [],
											boundaries: [],
											owners: [],
										},
										["Should state live in the profile?"],
									),
								),
							],
						},
						{
							when: "Start intent-advisor",
							messages: [
								helper(
									"intent-advisor",
									helperReport("intent", "Intent now clear.", {
										questions: [],
										doneCandidates: ["Brief approved."],
										ambiguities: [],
									}),
								),
								helper(
									"codebase-advisor",
									helperReport("codebase", "Codebase answer incorporated.", {
										files: ["extensions/loop.ts"],
										existingTests: [],
										facts: [],
										boundaries: [],
										owners: [],
									}),
								),
							],
						},
						{
							when: "Start test-design-advisor",
							messages: [
								helper(
									"test-design-advisor",
									helperReport("test-design", "Tests cover runner transitions.", {
										acceptanceTests: [
											{
												name: "loop transitions",
												proves: "slice one",
												targetFile: "test/loop.test.ts",
												command: "pnpm vitest run test/loop.test.ts",
											},
										],
									}),
								),
							],
						},
						{
							when: "Start architecture-advisor",
							messages: [
								helper(
									"architecture-advisor",
									helperReport("architecture", "Architecture approves.", {
										fitsExistingArchitecture: true,
										boundaryConcerns: [],
										needlessLayersOrCode: [],
										simplerShape: [],
										checklistEntriesUsed: [],
										checklist: { state: "absent", path: `${profile}/agents/checklists/architecture.md` },
									}),
								),
							],
						},
					]),
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		let buf = "";
		let stderr = "";
		child.stdout.on("data", (d) => {
			buf += d;
			for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
				const record = JSON.parse(buf.slice(0, i));
				buf = buf.slice(i + 1);
				records.push(record);
				const text = JSON.stringify(record);
				if (
					!answered &&
					text.includes("LOOPS needs one answer") &&
					text.includes("Use /loop start?") &&
					text.includes("Should state live in the profile?")
				) {
					answered = true;
					child.stdin.write(
						`${JSON.stringify({
							type: "prompt",
							message: "/loop answer Yes, use /loop start; yes, ask before build; yes, keep state in the profile.",
						})}\n`,
					);
				}
				if (!planned && text.includes("/loop plan <plan>")) {
					planned = true;
					child.stdin.write(
						`${JSON.stringify({
							type: "prompt",
							message: "/loop plan Keep transitions pure and Pi wiring thin.",
						})}\n`,
					);
				}
				if (!approved && text.includes("Architecture review is ready")) {
					approved = true;
					child.stdin.write(`${JSON.stringify({ type: "prompt", message: "/loop approve Approved for build." })}\n`);
				}
				if (text.includes("brief-approved")) {
					clearTimeout(fail);
					child.stdin.end();
				}
			}
		});
		child.stderr.on("data", (d) => {
			stderr += d;
		});
		child.on("exit", (code) => {
			clearTimeout(fail);
			if (code === 0) resolve();
			else reject(new Error(stderr || `pi exited with ${code}`));
		});
		child.on("error", reject);
		child.stdin.write(`${JSON.stringify({ type: "prompt", message: "/loop start Add the LOOPS runner" })}\n`);
	});

	expect(JSON.stringify(records)).toContain("intent-advisor");
	expect(JSON.stringify(records)).toContain("Should state live in the profile?");
	expect(JSON.stringify(records)).toContain("test-design-advisor");
	expect(JSON.stringify(records)).toContain("architecture-advisor");
	expect(JSON.stringify(records)).toContain("brief-approved");
}, 75_000);
