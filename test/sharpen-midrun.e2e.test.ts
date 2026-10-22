import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const EXT = fileURLToPath(new URL("../extensions/sharpen-pi.ts", import.meta.url));
const MODEL = fileURLToPath(new URL("./fixtures/midrun-model.ts", import.meta.url));

test("a real pi run that crosses the line while working hands over and keeps going, without stopping", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "sitra-midrun-e2e-")));
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
	writeFileSync(join(dir, "f.txt"), "hello world\n".repeat(200));
	const events: { type: string; text?: string }[] = [];
	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			"pi",
			["--mode", "rpc", "--no-extensions", "-e", MODEL, "-e", EXT, "--model", "sitra-faux/midrun"],
			{
				cwd: dir,
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: dir,
					PI_SUBAGENT_NAME: "",
					SITRA_HANDOVER_TOKENS: "160000",
					SITRA_TEST_FILE: join(dir, "f.txt"),
				},
				stdio: ["pipe", "pipe", "inherit"],
			},
		);
		let buf = "";
		child.stdout.on("data", (d) => {
			buf += d;
			for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
				const r = JSON.parse(buf.slice(0, i));
				buf = buf.slice(i + 1);
				const text =
					r.type === "message_end" && r.message?.role === "assistant"
						? r.message.content
								?.filter((p: { type: string }) => p.type === "text")
								.map((p: { text: string }) => p.text)
								.join("")
						: undefined;
				events.push({ type: r.type, text });
				if (process.env.DBG) console.log("EV", r.type, text ?? "");
				if (r.type === "agent_settled") setTimeout(() => child.stdin.end(), 200);
			}
		});
		child.on("exit", () => resolve());
		child.on("error", reject);
		child.stdin.write(
			`${JSON.stringify({ type: "prompt", message: `Read f.txt five times. Keep going until done. ${"x".repeat(700_000)}` })}\n`,
		);
	});
	expect(events.filter((e) => e.type === "agent_settled")).toHaveLength(1);
	expect(events.filter((e) => e.text).at(-1)?.text).toBe("FINAL summary=true request=true");
	const files = readdirSync(join(dir, "handovers"));
	expect(files).toHaveLength(1);
	const handover = readFileSync(join(dir, "handovers", files[0] ?? ""), "utf8");
	expect(handover).toContain("MIDRUN SUMMARY");
	expect(handover).toContain("Keep going until done.");
}, 60_000);

test("the 400k default does not hand over at about 182k tokens", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "sitra-midrun-default-e2e-")));
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
	writeFileSync(join(dir, "f.txt"), "hello world\n".repeat(200));
	const events: { type: string; text?: string; totalTokens?: number }[] = [];
	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			"pi",
			["--mode", "rpc", "--no-extensions", "-e", MODEL, "-e", EXT, "--model", "sitra-faux/midrun"],
			{
				cwd: dir,
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: dir,
					PI_SUBAGENT_NAME: "",
					SITRA_HANDOVER_TOKENS: undefined,
					SITRA_TEST_FILE: join(dir, "f.txt"),
				},
				stdio: ["pipe", "pipe", "inherit"],
			},
		);
		let buf = "";
		child.stdout.on("data", (d) => {
			buf += d;
			for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
				const r = JSON.parse(buf.slice(0, i));
				buf = buf.slice(i + 1);
				const text =
					r.type === "message_end" && r.message?.role === "assistant"
						? r.message.content
								?.filter((p: { type: string }) => p.type === "text")
								.map((p: { text: string }) => p.text)
								.join("")
						: undefined;
				events.push({ type: r.type, text, totalTokens: r.message?.usage?.totalTokens });
				if (r.type === "agent_settled") setTimeout(() => child.stdin.end(), 200);
			}
		});
		child.on("exit", () => resolve());
		child.on("error", reject);
		child.stdin.write(
			`${JSON.stringify({ type: "prompt", message: `Read f.txt five times. Keep going until done. ${"x".repeat(700_000)}` })}\n`,
		);
	});
	expect(events.filter((e) => e.type === "agent_settled")).toHaveLength(1);
	expect(events.filter((e) => e.text).at(-1)?.text).toBe("FINAL summary=false request=true");
	const maxTokens = Math.max(...events.map((e) => e.totalTokens ?? 0));
	expect(maxTokens).toBeGreaterThan(180_000);
	expect(maxTokens).toBeLessThan(400_000);
	expect(existsSync(join(dir, "handovers"))).toBe(false);
}, 60_000);
