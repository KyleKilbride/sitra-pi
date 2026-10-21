/**
 * sitra's Pi wiring for `/grimoire-ui`: starts the local Grimoire web server on `127.0.0.1` and opens the default
 * browser so the person can view and edit Grimoire by hand. Stops when the Pi session ends or after 30 minutes idle.
 */
import { spawn } from "node:child_process";
import { grimoireDir } from "./grimoire.ts";
import { type GrimoireServer, startGrimoireServer } from "./grimoire-ui.ts";

export interface Ctx {
	hasUI?: boolean;
	ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

export interface Pi {
	on(event: string, handler: (event: unknown, ctx: Ctx) => unknown): void;
	registerCommand(name: string, command: { description: string; handler(args: string, ctx: Ctx): Promise<void> }): void;
}

export function openBrowserCommand(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
	if (platform === "darwin") return { command: "open", args: [url] };
	if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
	return { command: "xdg-open", args: [url] };
}

function defaultOpenBrowser(url: string): void {
	try {
		const { command, args } = openBrowserCommand(process.platform, url);
		const child = spawn(command, args, { detached: true, stdio: "ignore" });
		child.on("error", () => {});
		child.unref();
	} catch {
		// The URL is shown with ctx.ui.notify either way.
	}
}

export default function sitraGrimoireUi(pi: Pi, options: { open?: (url: string) => void; idleMs?: number } = {}): void {
	const open = options.open ?? defaultOpenBrowser;
	let active: GrimoireServer | undefined;

	const stop = async () => {
		if (!active) return;
		const current = active;
		active = undefined;
		try {
			await current.close();
		} catch {
			// Already closed.
		}
	};

	pi.on("session_shutdown", async () => {
		await stop();
	});

	pi.registerCommand("grimoire-ui", {
		description: "Open Grimoire in your browser to view what agents receive, edit rules, and inspect today's log",
		handler: async (_args, ctx) => {
			await stop();
			const dir = grimoireDir(process.env);
			active = await startGrimoireServer({ dir, env: process.env, idleMs: options.idleMs });
			open(active.url);
			ctx.ui?.notify(`Grimoire UI: ${active.url}`, "info");
		},
	});
}
