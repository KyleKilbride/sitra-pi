import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const EXT = fileURLToPath(new URL("../extensions/lead.ts", import.meta.url));
const MODEL = fileURLToPath(new URL("./fixtures/run-model.ts", import.meta.url));

test("a run's result reaches the lead on its own when it finishes, without the model polling", async () => {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sitra-lead-")));
	const env = { ...process.env, PI_CODING_AGENT_DIR: join(cwd, "agent"), HERDR_ENV: "", HERDR_PANE_ID: "" };
	const seen: { type: string; message?: { role?: string; customType?: string; content?: unknown } }[] = [];
	await new Promise<void>((resolve) => {
		const child = spawn(
			"pi",
			["--mode", "rpc", "--no-extensions", "-e", MODEL, "-e", EXT, "--no-session", "--model", "sitra-faux/script"],
			{
				cwd,
				env,
				stdio: ["pipe", "pipe", "inherit"],
			},
		);
		let buf = "";
		child.stdout.on("data", (d) => {
			buf += d;
			for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
				const r = JSON.parse(buf.slice(0, i));
				buf = buf.slice(i + 1);
				seen.push(r);
				if (r.type === "message_end" && r.message?.customType === "sitra-run")
					setTimeout(() => child.stdin.end(), 3000);
			}
		});
		child.on("exit", () => resolve());
		setTimeout(() => child.stdin.end(), 25_000);
		child.stdin.write(`${JSON.stringify({ type: "prompt", message: "go" })}\n`);
	});
	const result = seen.find((r) => r.type === "message_end" && r.message?.customType === "sitra-run");
	expect(JSON.stringify(result?.message?.content)).toContain("exit code 2");
	expect(JSON.stringify(result?.message?.content)).toContain("quick-run-output");
	// Pi opens the new run before delivering the message, so the proof is that the model answers after it.
	const repliesAfter = seen
		.slice(seen.indexOf(result as never))
		.filter((r) => r.type === "message_end" && r.message?.role === "assistant");
	expect(repliesAfter.length).toBeGreaterThan(0);
}, 40_000);
