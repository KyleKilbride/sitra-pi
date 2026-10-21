import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { grimoireStoreStatus } from "../extensions/grimoire.ts";

test("a missing Grimoire store is typed separately from an unreadable one", () => {
	const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "sitra-grimoire-status-"))), "missing");
	expect(grimoireStoreStatus(dir)).toMatchObject({ state: "missing", dir });
});

test("a Grimoire store with an unreadable shape reports the reason", () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "sitra-grimoire-status-")));
	writeFileSync(join(dir, "root"), "not a directory\n");
	const status = grimoireStoreStatus(dir);
	expect(status.state).toBe("unreadable");
	if (status.state !== "unreadable") throw new Error("expected unreadable status");
	expect(status.reason).toContain("root");
});
