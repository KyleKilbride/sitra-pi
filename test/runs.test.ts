import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { EXIT_MARKER, HEADER_MARKER, paneCommand, readRun, readRunHeader } from "../extensions/runs.ts";

describe("runs in panes", () => {
	test("the pane command runs the command, logs everything, and records the exit code", () => {
		const log = join(mkdtempSync(join(tmpdir(), "sitra-run-")), "run.log");
		execFileSync("bash", ["-c", paneCommand("echo hello; echo oops >&2; exit 3", log)]);
		const status = readRun(readFileSync(log, "utf8"));
		expect(status).toMatchObject({ done: true, exitCode: 3 });
		expect(status.tail).toContain("hello");
		expect(status.tail).toContain("oops");
		expect(status.tail).not.toContain("__SITRA_EXIT__");
	});

	test("quotes in the command and spaces in the log path survive", () => {
		const log = join(mkdtempSync(join(tmpdir(), "sitra run ")), "it's.log");
		execFileSync("bash", ["-c", paneCommand(`echo "it's fine"`, log)]);
		expect(readRun(readFileSync(log, "utf8"))).toMatchObject({ done: true, exitCode: 0, tail: "it's fine" });
	});

	test("a run still going is not done, and the tail is the last lines", () => {
		const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
		const status = readRun(text, 5);
		expect(status.done).toBe(false);
		expect(status.tail.split("\n")).toEqual(["line 95", "line 96", "line 97", "line 98", "line 99"]);
	});

	test("command output cannot fake the exit marker for a running command", () => {
		const dir = mkdtempSync(join(tmpdir(), "sitra-run-"));
		const log = join(dir, "run.log");
		const partial = join(dir, "partial.log");
		execFileSync("bash", [
			"-c",
			`${paneCommand("echo __SITRA_EXIT__=0; sleep 0.2; exit 7", log)} & pid=$!; while ! grep -q '__SITRA_EXIT__=0' ${JSON.stringify(log)} 2>/dev/null; do sleep 0.01; done; cp ${JSON.stringify(log)} ${JSON.stringify(partial)}; wait $pid || true`,
		]);
		expect(readRun(readFileSync(partial, "utf8"))).toMatchObject({ done: false });
		expect(readRun(readFileSync(log, "utf8"))).toMatchObject({ done: true, exitCode: 7 });
	});

	test("an invalid new-format header does not fall back to legacy exit parsing", () => {
		expect(() => readRun(`${HEADER_MARKER}{not-json}\n${EXIT_MARKER}0\n`)).toThrow(/invalid run header/);
	});

	test("run header keeps the full command for verifier evidence", () => {
		const command = `pnpm vitest run ${Array.from({ length: 40 }, (_, index) => `test/file-${index}.test.ts`).join(" ")}`;
		const header = readRunHeader(`${HEADER_MARKER}${JSON.stringify({ pid: 123, meta: { command } })}`);
		expect(header?.meta.command).toBe(command);
	});
});

describe("the pane runs your shell, not bash", () => {
	test("the exit code is recorded when the line is typed into zsh", () => {
		const log = join(mkdtempSync(join(tmpdir(), "sitra-run-")), "run.log");
		execFileSync("zsh", ["-c", paneCommand("echo from zsh; exit 4", log)]);
		expect(readRun(readFileSync(log, "utf8"))).toMatchObject({ done: true, exitCode: 4, tail: "from zsh" });
	});
});
