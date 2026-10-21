import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const KNOWLEDGE_EXT = fileURLToPath(new URL("../extensions/knowledge.ts", import.meta.url));
const LEAD_EXT = fileURLToPath(new URL("../extensions/lead.ts", import.meta.url));
const MODEL = fileURLToPath(new URL("./fixtures/loop-model.ts", import.meta.url));

function worktree(): string {
	const work = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-work-")));
	execFileSync("git", ["init"], { cwd: work, stdio: "ignore" });
	return work;
}

async function runPi(options: {
	cwd: string;
	extensions: string[];
	tools?: string;
	script?: unknown[];
	scriptRaw?: string;
	env?: Record<string, string>;
}): Promise<unknown[]> {
	const records: unknown[] = [];
	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			"pi",
			[
				"--mode",
				"rpc",
				"--no-extensions",
				...options.extensions.flatMap((ext) => ["-e", ext]),
				"-e",
				MODEL,
				"--no-session",
				"--model",
				"sitra-loop-faux/script",
				...(options.tools ? ["--tools", options.tools] : []),
			],
			{
				cwd: options.cwd,
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: mkdtempSync(join(tmpdir(), "sitra-loop-profile-")),
					SITRA_LOOP_MODEL_SCRIPT: options.scriptRaw ?? JSON.stringify(options.script ?? []),
					...options.env,
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		let buf = "";
		let stderr = "";
		child.stdout.on("data", (d) => {
			buf += d;
			for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
				records.push(JSON.parse(buf.slice(0, i)));
				buf = buf.slice(i + 1);
				const last = records.at(-1) as { type?: string };
				if (last.type === "agent_settled") child.stdin.end();
			}
		});
		child.stderr.on("data", (d) => {
			stderr += d;
		});
		child.on("exit", (code) => {
			const modelError = records.find((record) => JSON.stringify(record).includes("SITRA_LOOP_MODEL_SCRIPT"));
			if (modelError) reject(new Error(JSON.stringify(modelError)));
			else if (code === 0) resolve();
			else reject(new Error(stderr || `pi exited with code ${code}`));
		});
		child.on("error", reject);
		child.stdin.write(`${JSON.stringify({ type: "prompt", message: "go" })}\n`);
	});
	return records;
}

test("loop model e2e: unreadable Grimoire is present in the prompt as a visible status", async () => {
	const work = worktree();
	const grimoire = realpathSync(mkdtempSync(join(tmpdir(), "sitra-loop-grimoire-")));
	writeFileSync(join(grimoire, "root"), "not a directory\n");
	const records = (await runPi({
		cwd: work,
		extensions: [KNOWLEDGE_EXT],
		script: [{ text: "done" }],
		env: { SITRA_GRIMOIRE: grimoire, SITRA_USER_NAME: "Sam" },
	})) as { type?: string; message?: { role?: string; sections?: Record<string, string> } }[];
	const system = records.find((r) => r.type === "message_end" && r.message?.role === "system");
	expect(system?.message?.sections?.grimoire).toContain("Grimoire unavailable");
	expect(system?.message?.sections?.grimoire).toContain(grimoire);
}, 60_000);

test("loop model e2e: helper_report can return structured fields through a real Pi tool call", async () => {
	const work = worktree();
	const records = await runPi({
		cwd: work,
		extensions: [LEAD_EXT],
		tools: "helper_report",
		env: { PI_SUBAGENT_NAME: "scout" },
		script: [
			{
				tool: {
					name: "helper_report",
					arguments: {
						status: "done",
						role: "intent",
						summary: "Checked the parser tests.",
						evidence: ["test/parser.test.ts"],
						openQuestions: [],
						assumptions: ["No browser was needed."],
						details: {
							questions: [
								{
									id: "q1",
									text: "Keep the parser test in place?",
									recommended: "Yes, keep the existing test target.",
									dependsOn: [],
								},
							],
							doneCandidates: ["Parser tests describe the expected behavior."],
							ambiguities: [],
						},
					},
				},
			},
			{ text: "done" },
		],
	});
	expect(JSON.stringify(records)).toContain("sitra-helper-report-v1");
	expect(JSON.stringify(records)).toContain("Checked the parser tests.");
	expect(JSON.stringify(records)).toContain('"role":"intent"');
}, 60_000);

test("loop model e2e: invalid scripts and exhausted scripts fail loudly", async () => {
	await expect(
		runPi({
			cwd: worktree(),
			extensions: [LEAD_EXT],
			scriptRaw: "{",
		}),
	).rejects.toThrow(/Invalid SITRA_LOOP_MODEL_SCRIPT/);
	await expect(
		runPi({
			cwd: worktree(),
			extensions: [LEAD_EXT],
			script: [],
		}),
	).rejects.toThrow(/SITRA_LOOP_MODEL_SCRIPT ran out of steps/);
}, 60_000);
