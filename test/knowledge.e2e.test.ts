import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { renderEntry } from "../extensions/kb.ts";

const EXT = fileURLToPath(new URL("../extensions/knowledge.ts", import.meta.url));
const MODEL = fileURLToPath(new URL("./fixtures/propose-model.ts", import.meta.url));

test("a real pi session sees the approved knowledge and can only propose, not write, knowledge", async () => {
	const repo = realpathSync(mkdtempSync(join(tmpdir(), "sitra-e2e-")));
	execFileSync("git", ["init", "-q", repo]);
	mkdirSync(join(repo, ".pi/knowledge/lessons"), { recursive: true });
	writeFileSync(
		join(repo, ".pi/knowledge/lessons/2026-10-08-read-evals.md"),
		renderEntry({
			kind: "lesson",
			title: "Read the eval failures before claiming anything",
			body: "b",
			date: "2026-10-08",
		}),
	);
	const records: { type: string; message?: { role?: string; sections?: Record<string, string> } }[] = [];
	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			"pi",
			[
				"--mode",
				"rpc",
				"--no-extensions",
				"-e",
				MODEL,
				"-e",
				EXT,
				"--no-session",
				"--model",
				"sitra-faux/script",
				"--tools",
				"read,kb_propose",
			],
			{
				cwd: repo,
				// A throwaway profile, so this test never adds its temp repo to the real tower's project list.
				env: { ...process.env, PI_CODING_AGENT_DIR: mkdtempSync(join(tmpdir(), "sitra-e2e-profile-")) },
				stdio: ["pipe", "pipe", "inherit"],
			},
		);
		let buf = "";
		child.stdout.on("data", (d) => {
			buf += d;
			for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
				const record = JSON.parse(buf.slice(0, i));
				buf = buf.slice(i + 1);
				records.push(record);
				if (record.type === "agent_settled") child.stdin.end();
			}
		});
		child.on("exit", () => resolve());
		child.on("error", reject);
		child.stdin.write(`${JSON.stringify({ type: "prompt", message: "go" })}\n`);
	});
	const system = records.find((r) => r.type === "message_end" && r.message?.role === "system");
	expect(system?.message?.sections?.["project-knowledge"]).toContain("Read the eval failures before claiming anything");
	expect(readdirSync(join(repo, ".pi/knowledge/proposals"))).toEqual([
		"2026-10-08-never-force-push-a-colleague-s-branch.md".replace("2026-10-08", new Date().toISOString().slice(0, 10)),
	]);
	expect(readdirSync(join(repo, ".pi/knowledge"))).not.toContain("warnings");
}, 60_000);
