import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const EXT = fileURLToPath(new URL("../extensions/replycheck-pi.ts", import.meta.url));
const MODEL = fileURLToPath(new URL("./fixtures/replycheck-model.ts", import.meta.url));

async function run(env: Record<string, string>): Promise<{ texts: string[]; settled: number }> {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "sitra-replycheck-")));
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
	writeFileSync(join(dir, "gh"), `#!/bin/sh\necho '{"state":"MERGED","mergedAt":"2026-01-02T00:00:00Z"}'\n`);
	chmodSync(join(dir, "gh"), 0o755);
	const texts: string[] = [];
	let settled = 0;
	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			"pi",
			["--mode", "rpc", "--no-extensions", "-e", MODEL, "-e", EXT, "--model", "sitra-faux/replycheck"],
			{
				cwd: dir,
				env: { ...process.env, PI_CODING_AGENT_DIR: dir, PATH: `${dir}:${process.env.PATH}`, ...env },
				stdio: ["pipe", "pipe", "inherit"],
			},
		);
		let buf = "";
		child.stdout.on("data", (d) => {
			buf += d;
			for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
				const r = JSON.parse(buf.slice(0, i));
				buf = buf.slice(i + 1);
				if (r.type === "message_end" && r.message?.role === "assistant")
					texts.push(r.message.content.map((p: { text?: string }) => p.text ?? "").join(""));
				if (r.type === "agent_settled") {
					settled++;
					setTimeout(() => child.stdin.end(), 200);
				}
			}
		});
		child.on("exit", () => resolve());
		child.on("error", reject);
		child.stdin.write(`${JSON.stringify({ type: "prompt", message: "What's waiting on me?" })}\n`);
	});
	return { texts, settled };
}

test("a real pi reply naming a merged PR as waiting is corrected before the run settles", async () => {
	const on = await run({});
	expect(on.settled).toBe(1);
	expect(on.texts).toHaveLength(2);
	expect(on.texts.at(-1)).toBe("CORRECTED: https://github.com/acme/app/pull/7 is merged.");
	const off = await run({ SITRA_REPLY_CHECK: "0" });
	expect(off.texts.at(-1)).toBe("Waiting on you: review https://github.com/acme/app/pull/7");
}, 60_000);
