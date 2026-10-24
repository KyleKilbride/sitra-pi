import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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

	test("37 (Pi). passes the session's folder and its project, found once at session start, to the server", async () => {
		const dir = tmp();
		writeFileSync(
			join(dir, "projects.json"),
			JSON.stringify({ projects: [{ id: "app", label: "App", remotes: ["github.com/example/app"], paths: [] }] }),
		);
		const checkout = tmp();
		const git = (...args: string[]) => execFileSync("git", args, { cwd: checkout, stdio: "ignore" });
		git("init", "-q");
		git("remote", "add", "origin", "https://github.com/example/app.git");
		vi.stubEnv("SITRA_GRIMOIRE", dir);

		const handlers = new Map<string, (event: unknown, ctx: Ctx) => unknown>();
		const commands = new Map<string, { description: string; handler: (args: string, ctx: Ctx) => Promise<void> }>();
		const opened: string[] = [];
		sitraGrimoireUi(
			{ on: (n, h) => handlers.set(n, h), registerCommand: (n, c) => commands.set(n, c) },
			{ open: (url) => opened.push(url) },
		);
		const ctx = { cwd: checkout, hasUI: true, ui: { notify() {} } };
		await handlers.get("session_start")?.({}, ctx);
		// A later folder change doesn't switch the session's project.
		await commands.get("grimoire-ui")?.handler("", { ...ctx, cwd: tmp() });
		const url = new URL(opened[0] ?? "");
		const res = await fetch(`${url.origin}/api/snapshot${url.search}`);
		const snap = (await res.json()) as {
			session: { cwd: string; project: { state: string; project?: { id: string } }; remotes: unknown[] };
			preview: { state: string; project?: { id: string } };
		};
		expect(snap.session.cwd).toBe(checkout);
		expect(snap.session.project).toMatchObject({ state: "matched", project: { id: "app" } });
		expect(snap.session.remotes).toEqual([{ name: "origin", key: "github.com/example/app" }]);
		expect(snap.preview).toMatchObject({ state: "matched", project: { id: "app" } });
		await handlers.get("session_shutdown")?.({}, ctx);
	});

	test("chooses open on macOS, xdg-open on Linux, and start on Windows", () => {
		const url = "http://127.0.0.1:12345/?token=abc";
		expect(openBrowserCommand("darwin", url)).toEqual({ command: "open", args: [url] });
		expect(openBrowserCommand("linux", url)).toEqual({ command: "xdg-open", args: [url] });
		expect(openBrowserCommand("win32", url)).toEqual({ command: "cmd", args: ["/c", "start", "", url] });
	});
});
