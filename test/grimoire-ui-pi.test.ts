import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import sitraGrimoireUi, { type Ctx, openBrowserCommand } from "../extensions/grimoire-ui-pi.ts";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "sitra-grimoire-ui-pi-")));

afterEach(() => vi.unstubAllEnvs());

describe("/grimoire-ui Pi extension", () => {
	test("registers /grimoire-ui, opens the browser with the 127.0.0.1 token URL, notifies, and shuts down on session_shutdown", async () => {
		const dir = tmp();
		vi.stubEnv("SITRA_GRIMOIRE", dir);

		const handlers = new Map<string, (event: unknown, ctx: Ctx) => unknown>();
		const commands = new Map<string, { description: string; handler: (args: string, ctx: Ctx) => Promise<void> }>();
		const opened: string[] = [];
		const notes: string[] = [];

		sitraGrimoireUi(
			{
				on: (n, h) => handlers.set(n, h),
				registerCommand: (n, c) => commands.set(n, c),
			},
			{ open: (url) => opened.push(url) },
		);

		expect(commands.has("grimoire-ui")).toBe(true);
		const ctx = {
			hasUI: true,
			ui: { notify: (m: string) => notes.push(m) },
		};

		await commands.get("grimoire-ui")?.handler("", ctx);
		expect(opened).toHaveLength(1);
		const url = opened[0] ?? "";
		expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+$/);
		expect(notes[0]).toContain(url);

		const res = await fetch(url);
		expect(res.status).toBe(200);

		// Shutting down the session stops the server.
		await handlers.get("session_shutdown")?.({}, ctx);
		await expect(fetch(url)).rejects.toThrow();
	});

	test("chooses open on macOS, xdg-open on Linux, and start on Windows", () => {
		const url = "http://127.0.0.1:12345/?token=abc";
		expect(openBrowserCommand("darwin", url)).toEqual({ command: "open", args: [url] });
		expect(openBrowserCommand("linux", url)).toEqual({ command: "xdg-open", args: [url] });
		expect(openBrowserCommand("win32", url)).toEqual({ command: "cmd", args: ["/c", "start", "", url] });
	});
});
