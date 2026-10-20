import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { renderEntry } from "../extensions/grimoire.ts";

const EXT = fileURLToPath(new URL("../extensions/knowledge.ts", import.meta.url));
const MODEL = fileURLToPath(new URL("./fixtures/propose-model.ts", import.meta.url));

test("a real pi session starts with Grimoire's root and catalogue, and can only propose, not write, knowledge", async () => {
	const work = realpathSync(mkdtempSync(join(tmpdir(), "sitra-e2e-")));
	const grimoire = realpathSync(mkdtempSync(join(tmpdir(), "sitra-e2e-grimoire-")));
	mkdirSync(join(grimoire, "root"));
	writeFileSync(join(grimoire, "root", "README.md"), "# How Sam works\nShort replies, the ask first.\n");
	mkdirSync(join(grimoire, "kinds", "lessons"), { recursive: true });
	const approved = join(grimoire, "kinds", "lessons", "2026-10-08-read-evals.md");
	writeFileSync(
		approved,
		renderEntry({
			kind: "lesson",
			title: "Read the eval failures before claiming anything",
			summary: "Open the failing cases first.",
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
				"read,grimoire_propose,grimoire_search",
			],
			{
				cwd: work,
				env: {
					...process.env,
					SITRA_GRIMOIRE: grimoire,
					SITRA_USER_NAME: "Sam",
					PI_CODING_AGENT_DIR: mkdtempSync(join(tmpdir(), "sitra-e2e-profile-")),
				},
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
	const section = system?.message?.sections?.grimoire ?? "";
	expect(section).toContain("Short replies, the ask first.");
	expect(section).toContain("Read the eval failures before claiming anything: Open the failing cases first.");
	expect(section).toContain("Only Sam approves");
	expect(readdirSync(join(grimoire, "proposals"))).toEqual([
		`${new Date().toISOString().slice(0, 10)}-never-force-push-a-colleague-s-branch.md`,
	]);
	expect(readdirSync(join(grimoire, "kinds"))).toEqual(["lessons"]);
	expect(readdirSync(join(grimoire, "kinds", "lessons"))).toEqual(["2026-10-08-read-evals.md"]);
	expect(readFileSync(approved, "utf8")).toContain("Open the failing cases first.");
}, 60_000);
