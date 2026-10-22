import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const LOOP_EXT = fileURLToPath(new URL("../extensions/loop-pi.ts", import.meta.url));
const MODEL = fileURLToPath(new URL("./fixtures/loop-model.ts", import.meta.url));

const helper = (role: string, summary: string, details: unknown, openQuestions: string[] = [], tokenCount = 100) => ({
	sessionFile: "/tmp/sitra-loop-helper.jsonl",
	details: {
		status: openQuestions.length ? "needs-input" : "done",
		role,
		summary,
		evidence: [`${role}.md:1`],
		openQuestions,
		assumptions: [],
		details,
	},
	tokenCount,
});

test("loop runner e2e: explicit start to advisor reports, person answer, plan, architecture, and brief-approved", async () => {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-e2e-work-")));
	const profile = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-e2e-profile-")));
	const records: { type?: string; message?: { role?: string; content?: unknown; customType?: string } }[] = [];

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
								helper("intent", "Intent found one decision.", {
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
								helper("codebase", "Codebase maps to extensions.", {
									files: ["extensions/loop.ts"],
									existingTests: [],
									facts: [],
									boundaries: [],
									owners: [],
								}),
							],
						},
						{
							when: "Start intent-advisor",
							messages: [
								helper("intent", "Intent now clear.", {
									questions: [],
									doneCandidates: ["Brief approved."],
									ambiguities: [],
								}),
							],
						},
						{
							when: "Start test-design-advisor",
							messages: [
								helper("test-design", "Tests cover runner transitions.", {
									acceptanceTests: [
										{
											name: "loop transitions",
											proves: "slice one",
											targetFile: "test/loop.test.ts",
											command: "pnpm vitest run test/loop.test.ts",
										},
									],
								}),
							],
						},
						{
							when: "Start architecture-advisor",
							messages: [
								helper("architecture", "Architecture approves.", {
									fitsExistingArchitecture: true,
									boundaryConcerns: [],
									needlessLayersOrCode: [],
									simplerShape: [],
									checklistEntriesUsed: [],
									checklist: { state: "absent", path: `${profile}/agents/checklists/architecture.md` },
								}),
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
				if (!answered && text.includes("LOOPS needs one answer") && text.includes("Use /loop start?")) {
					answered = true;
					child.stdin.write(`${JSON.stringify({ type: "prompt", message: "/loop answer Yes, use /loop start." })}\n`);
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
	expect(JSON.stringify(records)).toContain("test-design-advisor");
	expect(JSON.stringify(records)).toContain("architecture-advisor");
	expect(JSON.stringify(records)).toContain("brief-approved");
}, 75_000);
