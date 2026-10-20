import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const EXT = fileURLToPath(new URL("../extensions/sharpen-pi.ts", import.meta.url));
const MODEL = fileURLToPath(new URL("./fixtures/handover-model.ts", import.meta.url));

test("a real pi session past the handover threshold still recovers from a retryable error, then hands over", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "sitra-handover-e2e-")));
	writeFileSync(
		join(dir, "settings.json"),
		JSON.stringify({
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
			compaction: { keepRecentTokens: 2_000 },
		}),
	);
	writeFileSync(join(dir, "small.txt"), "hello world\n".repeat(2_000));
	const types: { type: string; aborted?: boolean; text?: string; errorMessage?: string }[] = [];
	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			"pi",
			["--mode", "rpc", "--no-extensions", "-e", MODEL, "-e", EXT, "--model", "sitra-faux/handover"],
			{
				cwd: dir,
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: dir,
					PI_SUBAGENT_NAME: "",
					SITRA_TEST_FILE: join(dir, "small.txt"),
				},
				stdio: ["pipe", "pipe", "inherit"],
			},
		);
		let buf = "";
		let settled = false;
		child.stdout.on("data", (d) => {
			buf += d;
			for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
				const r = JSON.parse(buf.slice(0, i));
				buf = buf.slice(i + 1);
				const text =
					r.message?.role === "assistant"
						? r.message.content
								?.filter((p: { type: string }) => p.type === "text")
								.map((p: { text: string }) => p.text)
								.join("")
						: undefined;
				types.push({ type: r.type, aborted: r.aborted, text, errorMessage: r.errorMessage });
				if (process.env.DBG) console.log("EV", r.type, r.reason ?? "", r.errorMessage ?? "");
				if (r.type === "compaction_end") setTimeout(() => child.stdin.end(), 100);
				if (r.type === "agent_settled") {
					if (!settled) {
						settled = true;
						child.stdin.write(`${JSON.stringify({ type: "prompt", message: "Now read the file." })}\n`);
					} else setTimeout(() => child.stdin.end(), 2_000);
				}
			}
		});
		child.on("exit", () => resolve());
		child.on("error", reject);
		child.stdin.write(
			`${JSON.stringify({ type: "prompt", message: `Read the file then answer. ${"x".repeat(700_000)}` })}\n`,
		);
	});
	expect(types.some((t) => t.type === "auto_retry_start")).toBe(true);
	expect(types.filter((t) => t.text).at(-1)?.text).toBe("RECOVERED AFTER RETRY");
	expect(types.filter((t) => t.type === "agent_settled").every((t) => t.aborted === false)).toBe(true);
	const end = types.find((t) => t.type === "compaction_end");
	expect(end?.errorMessage).toBeUndefined();
	expect(readdirSync(join(dir, "handovers"))).toHaveLength(1);
}, 60_000);
