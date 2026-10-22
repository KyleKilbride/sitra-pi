import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { loopStatePath, readLoopStateFile, writeLoopStateFile } from "../extensions/loop-pi.ts";
import { EXIT_MARKER, HEADER_MARKER } from "../extensions/runs.ts";

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

function commitAll(cwd: string, message: string): string {
	execFileSync("git", ["add", "."], { cwd, stdio: "ignore" });
	execFileSync("git", ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", message], {
		cwd,
		stdio: "ignore",
	});
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
}

function sha256(cwd: string, file: string): string {
	return execFileSync("sha256sum", [file], { cwd, encoding: "utf8" }).split(/\s+/)[0] ?? "";
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeRunLog(
	path: string,
	commit: string,
	testHashes: { file: string; sha256: string }[],
	exitCode: number,
	command = "pnpm vitest run loop.test.ts",
) {
	writeFileSync(
		path,
		[
			`${HEADER_MARKER}${JSON.stringify({
				pid: 12345,
				pidStart: "1",
				pidStartKind: "proc",
				meta: { command, loop: { commit, testHashes } },
			})}`,
			"output",
			`${EXIT_MARKER}${exitCode}`,
		].join("\n"),
	);
}

test("loop runner e2e: explicit start to advisor question, person answer, and advisor rerun", async () => {
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
		let continued = false;
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
										],
										doneCandidates: ["Brief approved."],
										ambiguities: [],
									}),
								),
								helper(
									"codebase-advisor",
									helperReport("codebase", "Codebase maps to extensions.", {
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
					record.type === "message_end" &&
					text.includes("LOOPS needs one answer") &&
					text.includes("Use /loop start?")
				) {
					answered = true;
					child.stdin.write(
						`${JSON.stringify({
							type: "prompt",
							message: "/loop answer Yes, use /loop start.",
						})}\n`,
					);
				}
				if (
					!continued &&
					record.type === "message_end" &&
					text.includes("LOOPS runner dispatch for stage advise") &&
					text.includes("Answers so far:") &&
					text.includes("Answer: Yes, use /loop start.")
				) {
					continued = true;
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
	expect(JSON.stringify(records)).toContain("LOOPS needs one answer");
	expect(JSON.stringify(records)).toContain("Yes, use /loop start.");
}, 75_000);

async function runBuildVerifyE2e(kind: "pass" | "miss") {
	const cwd = gitWorktree();
	const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-e2e-profile-")));
	const redLog = join(profile, `${kind}-red.log`);
	const greenLog = join(profile, `${kind}-green.log`);
	const records: { type?: string; message?: { role?: string; content?: unknown; customType?: string } }[] = [];
	const helper = (agent: string, report: unknown) => ({
		id: `${agent}-1`,
		name: agent,
		agent,
		status: "completed",
		outputTokens: 10,
		contextTokens: 20,
		sessionFile: sessionFileWithHelperReport(profile, report),
	});
	await new Promise<void>((resolve, reject) => {
		let planned = false;
		let approved = false;
		let buildStarted = false;
		let recordRequested = false;
		let finished = false;
		const fail = setTimeout(() => {
			child.kill();
			reject(new Error(`timed out\nrecords:\n${JSON.stringify(records, null, 2)}\nstderr:\n${stderr}`));
		}, 75_000);
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
									helperReport("intent", "Intent clear.", {
										questions: [],
										doneCandidates: ["Verifier passes."],
										ambiguities: [],
									}),
								),
								helper(
									"codebase-advisor",
									helperReport("codebase", "Codebase clear.", {
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
									helperReport("test-design", "Tests selected.", {
										acceptanceTests: [
											{
												name: "loop verify",
												proves: "slice 2a",
												targetFile: "loop.test.ts",
												command: "pnpm vitest run loop.test.ts",
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
						{
							when: "Start verifier",
							messages: [
								helper(
									"verifier",
									helperReport("verifier", kind === "pass" ? "Verifier passed." : "Verifier found a miss.", {
										checksRun: [],
										rerunChecks: [],
										acceptedLogs: [{ log: greenLog, reason: "exact commit and test hashes" }],
										testHashesChecked: ["loop.test.ts"],
										goalMatched: kind === "pass",
										...(kind === "miss" ? { missClass: "execution-slip" } : {}),
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
				if (!planned && text.includes("/loop plan <plan>")) {
					planned = true;
					child.stdin.write(`${JSON.stringify({ type: "prompt", message: "/loop plan Keep loop logic pure." })}\n`);
				}
				if (!approved && text.includes("Architecture review is ready")) {
					approved = true;
					child.stdin.write(`${JSON.stringify({ type: "prompt", message: "/loop approve Approved for build." })}\n`);
				}
				if (!buildStarted && text.includes("brief-approved")) {
					buildStarted = true;
					child.stdin.write(`${JSON.stringify({ type: "prompt", message: "/loop build" })}\n`);
				}
				if (!recordRequested && text.includes("stage: build")) {
					recordRequested = true;
					writeFileSync(join(cwd, "loop.test.ts"), "expect(true).toBe(true)\n");
					const redCommit = commitAll(cwd, "materialize loop test");
					writeFileSync(join(cwd, "impl.ts"), "green\n");
					const greenCommit = commitAll(cwd, "implement");
					const hashes = [{ file: "loop.test.ts", sha256: sha256(cwd, "loop.test.ts") }];
					writeRunLog(redLog, redCommit, hashes, 1);
					writeRunLog(greenLog, greenCommit, hashes, 0);
					const redRunId = `${kind}-red-run`;
					const greenRunId = `${kind}-green-run`;
					mkdirSync(join(profile, "runs"), { recursive: true });
					const storedRedLog = join(profile, "runs", `${redRunId}.log`);
					const storedGreenLog = join(profile, "runs", `${greenRunId}.log`);
					writeFileSync(storedRedLog, readFileSync(redLog, "utf8"));
					writeFileSync(storedGreenLog, readFileSync(greenLog, "utf8"));
					const statePath = loopStatePath(profile, cwd, "feature");
					const state = readLoopStateFile(statePath);
					writeLoopStateFile(statePath, {
						...state,
						build: {
							...state.build,
							evidence: [
								...(state.build.evidence ?? []),
								{
									runId: redRunId,
									sha256: sha256File(storedRedLog),
									phase: "red",
									commit: redCommit,
									command: "pnpm vitest run loop.test.ts",
									log: storedRedLog,
								},
								{
									runId: greenRunId,
									sha256: sha256File(storedGreenLog),
									phase: "green",
									commit: greenCommit,
									command: "pnpm vitest run loop.test.ts",
									log: storedGreenLog,
								},
							],
						},
					});
					child.stdin.write(
						`${JSON.stringify({
							type: "prompt",
							message: `/loop record-build ${JSON.stringify({
								redRunId,
								greenRunId,
							})}`,
						})}\n`,
					);
				}
				if (!finished && text.includes("Start verifier")) {
					finished = true;
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
	const transcript = JSON.stringify(records);
	expect(transcript).toContain("Start verifier");
	expect(transcript).toContain(kind === "pass" ? "pass-green-run.log" : "miss-green-run.log");
}

test("loop runner e2e: explicit build and verifier pass reach verifier dispatch", async () => {
	await runBuildVerifyE2e("pass");
}, 90_000);

test("loop runner e2e: explicit build and verifier miss reach verifier dispatch", async () => {
	await runBuildVerifyE2e("miss");
}, 90_000);
