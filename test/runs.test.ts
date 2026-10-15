import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { paneCommand, readRun } from "../extensions/runs.ts";

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
});

describe("the pane runs your shell, not bash", () => {
	test("the exit code is recorded when the line is typed into zsh", () => {
		const log = join(mkdtempSync(join(tmpdir(), "sitra-run-")), "run.log");
		execFileSync("zsh", ["-c", paneCommand("echo from zsh; exit 4", log)]);
		expect(readRun(readFileSync(log, "utf8"))).toMatchObject({ done: true, exitCode: 4, tail: "from zsh" });
	});
});
