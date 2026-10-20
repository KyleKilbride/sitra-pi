import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { mainCheckout } from "../extensions/sessions.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

/** A repo with one commit, so worktrees can be added. */
function makeRepo(): string {
	const repo = realpathSync(mkdtempSync(join(tmpdir(), "sitra-kbrepo-")));
	git(repo, "init", "-q");
	git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
	return repo;
}

describe("mainCheckout", () => {
	test("is the checkout itself from anywhere inside the main checkout", () => {
		const repo = makeRepo();
		mkdirSync(join(repo, "sub"));
		expect(mainCheckout(repo)).toBe(repo);
		expect(mainCheckout(join(repo, "sub"))).toBe(repo);
	});

	test("is the main checkout from inside a linked worktree, so every worktree counts as one project", () => {
		const repo = makeRepo();
		const wt = join(repo, ".worktrees", "feature");
		git(repo, "worktree", "add", "-q", "-b", "feature", wt);
		mkdirSync(join(wt, "deep"));
		expect(mainCheckout(wt)).toBe(repo);
		expect(mainCheckout(join(wt, "deep"))).toBe(repo);
	});

	test("falls back to the folder itself outside git", () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "sitra-nogit-")));
		expect(mainCheckout(dir)).toBe(dir);
	});
});
