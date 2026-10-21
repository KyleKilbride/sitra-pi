import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	collectMail,
	loadMailbox,
	parseMailSnapshot,
	readTowerSummary,
	writeTowerSummary,
} from "../extensions/radar-store.ts";

const dirs: string[] = [];
const tmp = () => {
	const dir = mkdtempSync(join(tmpdir(), "radar-store-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});
const mail = (id: string) => ({
	id,
	peer: "peer",
	direction: "in",
	state: "received",
	summary: `subject-${id}`,
	body: "payload",
	updatedAt: "2026-10-21T10:00:00Z",
});

describe("radar summary storage", () => {
	test("writes all three lists atomically and privately and rejects invalid data without losing last good summary", () => {
		const dir = tmp();
		expect(readTowerSummary(dir)).toBeUndefined();
		const value = { done: ["verified"], doing: [], next: ["review"], updatedAt: "2026-10-21T10:00:00Z" };
		writeTowerSummary(dir, value);
		expect(readTowerSummary(dir)).toEqual(value);
		expect(statSync(join(dir, "radar-status.json")).mode & 0o777).toBe(0o600);
		expect(() => writeTowerSummary(dir, { ...value, updatedAt: "bad" })).toThrow();
		expect(readTowerSummary(dir)).toEqual(value);
		writeFileSync(join(dir, "radar-status.json"), "{partial");
		expect(readTowerSummary(dir)).toBeUndefined();
	});
});

describe("local read-only mailbox source", () => {
	test("retains more than six messages, validates types, strips controls and rejects duplicates", () => {
		const items = Array.from({ length: 12 }, (_, i) => mail(String(i)));
		expect(parseMailSnapshot({ items }).items).toHaveLength(12);
		expect(parseMailSnapshot({ items: [{ ...mail("a"), body: "\x1b[2Jpayload" }] }).items[0]?.body).toBe("payload");
		for (const value of [
			[mail("a")],
			{ items: [mail("a"), mail("a")] },
			{ items: [{ ...mail("a"), body: 3 }] },
			{ items: [{ ...mail("a"), updatedAt: "invalid" }] },
		])
			expect(() => parseMailSnapshot(value)).toThrow();
	});
	test("canonicalizes a parseable timestamp rather than rendering its terminal-control prefix", () => {
		const updatedAt = "(\x1b[2J)Wed, 21 Oct 2026 00:00:00 GMT";
		expect(Number.isFinite(Date.parse(updatedAt))).toBe(true);
		expect(parseMailSnapshot({ items: [{ ...mail("timestamp"), updatedAt }] }).items[0]?.updatedAt).toBe(
			"2026-10-21T00:00:00.000Z",
		);
	});
	test("does not silently treat the old undated hand-maintained list as a live mailbox", async () => {
		const dir = tmp();
		writeFileSync(join(dir, "sitra-mail.json"), JSON.stringify([mail("old")]));
		expect(collectMail(dir)).toEqual([]);
		expect((await loadMailbox(dir)).items).toEqual([]);
		expect((await loadMailbox(dir)).notice).toBeDefined();
	});
	test("loads current file updates on every refresh", async () => {
		const dir = tmp();
		const file = join(dir, "sitra-mail.json");
		writeFileSync(file, JSON.stringify({ items: [mail("one")] }));
		expect((await loadMailbox(dir)).items[0]?.id).toBe("one");
		writeFileSync(file, JSON.stringify({ items: [mail("two")] }));
		expect((await loadMailbox(dir)).items[0]?.id).toBe("two");
	});
	test("cancels the active local provider when the dashboard closes", async () => {
		const dir = tmp();
		const started = join(dir, "started");
		const stopped = join(dir, "stopped");
		const script = join(dir, "slow.mjs");
		writeFileSync(
			script,
			`import {writeFileSync} from "node:fs";process.on("SIGTERM",()=>{writeFileSync(${JSON.stringify(stopped)},"stopped");process.exit(0)});writeFileSync(${JSON.stringify(started)},"started");setInterval(()=>{},1000);`,
		);
		writeFileSync(join(dir, "radar-mail-source.json"), JSON.stringify({ command: process.execPath, args: [script] }));
		const controller = new AbortController();
		const pending = loadMailbox(dir, controller.signal);
		const failure = expect(pending).rejects.toMatchObject({ name: "AbortError" });
		await expect.poll(() => existsSync(started), { timeout: 4000 }).toBe(true);
		controller.abort();
		await failure;
		await expect.poll(() => existsSync(stopped), { timeout: 4000 }).toBe(true);
	});
	test("executes the configured local adapter without a shell and reports failures without leaking its stderr", async () => {
		const dir = tmp();
		const script = join(dir, "adapter.mjs");
		writeFileSync(script, `console.log(JSON.stringify(${JSON.stringify({ items: [mail("adapter")] })}))`);
		chmodSync(script, 0o600);
		const config = join(dir, "radar-mail-source.json");
		writeFileSync(config, JSON.stringify({ command: process.execPath, args: [script] }));
		expect((await loadMailbox(dir)).items[0]?.id).toBe("adapter");
		writeFileSync(script, 'console.error("private data");process.exit(1)');
		await expect(loadMailbox(dir)).rejects.not.toThrow("private data");
		expect(readFileSync(config, "utf8")).toContain("adapter.mjs");
	});
});
