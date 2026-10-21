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
	script: unknown[];
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
					SITRA_LOOP_MODEL_SCRIPT: JSON.stringify(options.script),
					...options.env,
				},
				stdio: ["pipe", "pipe", "inherit"],
			},
		);
		let buf = "";
		child.stdout.on("data", (d) => {
			buf += d;
			for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
				records.push(JSON.parse(buf.slice(0, i)));
				buf = buf.slice(i + 1);
				const last = records.at(-1) as { type?: string };
				if (last.type === "agent_settled") child.stdin.end();
			}
		});
		child.on("exit", () => resolve());
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
		script: [
			{
				tool: {
					name: "helper_report",
					arguments: {
						status: "done",
						summary: "Checked the parser tests.",
						evidence: ["test/parser.test.ts"],
						openQuestions: [],
						assumptions: ["No browser was needed."],
					},
				},
			},
			{ text: "done" },
		],
	});
	expect(JSON.stringify(records)).toContain("sitra-helper-report-v1");
	expect(JSON.stringify(records)).toContain("Checked the parser tests.");
}, 60_000);
