import { execFileSync } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { grimoireDir } from "./grimoire.ts";
import { collectRadarSnapshot, createRefreshScheduler, frameUpdate, TRANSCRIPT_TAIL_LINES } from "./radar.ts";
import { createRadarKeyDecoder, focusCommands, initialRadarState, reduceRadarKey } from "./radar-model.ts";
import { loadMailbox, type MailSnapshot } from "./radar-store.ts";
import { buildRadarLayout } from "./radar-view.ts";
import { createTailReader, sessionsDir } from "./sessions.ts";

/** Run the local read-only dashboard. Focus targets the actual lead tab; message/log views never execute content. */
export function runRadarTui(profileDir: string, options?: { towerName?: string; closePaneOnExit?: boolean }): void {
	if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Radar needs an interactive terminal.");
	const out = process.stdout;
	const readLines = createTailReader(TRANSCRIPT_TAIL_LINES);
	const collect = () =>
		collectRadarSnapshot(profileDir, { towerName: options?.towerName, includeHerdr: true, readLines });
	let state = initialRadarState();
	let snapshot = collect();
	let shown: string[] | undefined;
	let closed = false;
	let mailbox: MailSnapshot = { items: [], notice: "Connecting local mailbox…" };
	const mailAbort = new AbortController();
	let mailBusy = false;
	let lastMailRefresh = 0;
	const keys = createRadarKeyDecoder();
	const utf8 = new StringDecoder("utf8");
	let escapeTimer: ReturnType<typeof setTimeout> | undefined;
	const paint = () => {
		if (closed) return;
		const layout = buildRadarLayout(snapshot, { cols: out.columns ?? 100, rows: out.rows ?? 32, state });
		if (["message", "run", "summary"].includes(state.view)) state = { ...state, scroll: layout.scrollStart };
		const lines = [...layout.header, ...layout.body, ...layout.summary, ...layout.footer];
		out.write(frameUpdate(shown, lines));
		shown = lines;
	};
	const updateMail = () => {
		if (mailBusy || closed) return;
		mailBusy = true;
		lastMailRefresh = Date.now();
		void loadMailbox(profileDir, mailAbort.signal)
			.then(
				(value) => {
					mailbox = value;
				},
				(error: unknown) => {
					mailbox = {
						...mailbox,
						notice: error instanceof Error ? error.message : "Mailbox unavailable; last good messages retained",
					};
				},
			)
			.finally(() => {
				mailBusy = false;
				if (closed) return;
				const selectedId = snapshot.mail[state.selected]?.id;
				snapshot = { ...snapshot, mail: mailbox.items, mailNotice: mailbox.notice };
				if (state.view === "mail") {
					const selected = selectedId ? mailbox.items.findIndex((m) => m.id === selectedId) : state.selected;
					state = { ...state, selected: Math.max(0, Math.min(selected < 0 ? 0 : selected, mailbox.items.length - 1)) };
				}
				paint();
			});
	};
	const refresh = createRefreshScheduler(() => {
		if (closed) return;
		const selectedId =
			state.view === "workers"
				? snapshot.workers[state.selected]?.lead.id
				: state.view === "runs"
					? snapshot.runs[state.selected]?.id
					: undefined;
		snapshot = { ...collect(), mail: mailbox.items, mailNotice: mailbox.notice };
		if (state.view === "workers" || state.view === "runs") {
			const list = state.view === "workers" ? snapshot.workers.map((w) => w.lead.id) : snapshot.runs.map((r) => r.id);
			const selected = selectedId ? list.indexOf(selectedId) : state.selected;
			state = { ...state, selected: Math.max(0, Math.min(selected < 0 ? state.selected : selected, list.length - 1)) };
		}
		if (Date.now() - lastMailRefresh >= 5000) updateMail();
		paint();
	}, 500);
	const watchers: ReturnType<typeof watch>[] = [];
	for (const dir of [
		profileDir,
		sessionsDir(profileDir),
		join(profileDir, "runs"),
		join(grimoireDir({ ...process.env, PI_CODING_AGENT_DIR: profileDir }), "proposals"),
	]) {
		if (!existsSync(dir)) continue;
		try {
			watchers.push(watch(dir, () => refresh.request()));
		} catch {}
	}
	const wasRaw = process.stdin.isRaw;
	const cleanup = () => {
		if (closed) return;
		closed = true;
		mailAbort.abort();
		clearInterval(timer);
		if (escapeTimer) clearTimeout(escapeTimer);
		refresh.cancel();
		for (const watcher of watchers) watcher.close();
		process.stdin.off("data", onData);
		process.stdin.setRawMode(wasRaw);
		process.stdin.pause();
		out.off("resize", onResize);
		process.off("SIGINT", quit);
		process.off("SIGTERM", quit);
		process.off("exit", cleanup);
		out.write("\x1b[?25h\x1b[?1049l");
	};
	const quit = () => {
		cleanup();
		if (options?.closePaneOnExit && process.env.HERDR_ENV === "1" && process.env.HERDR_PANE_ID) {
			try {
				execFileSync("herdr", ["pane", "close", process.env.HERDR_PANE_ID], { stdio: "ignore", timeout: 1500 });
			} catch {}
		}
		process.exit(0);
	};
	const handle = (key: string) => {
		if (closed) return;
		const next = reduceRadarKey(state, key, snapshot);
		state = next.state;
		if (next.effect?.type === "quit") {
			quit();
			return;
		}
		if (next.effect?.type === "refresh") {
			lastMailRefresh = 0;
			refresh.request();
		}
		if (next.effect?.type === "focus") {
			const commands = focusCommands(next.effect.worker);
			if (!commands.length) state = { ...state, notice: "No workspace is attached to this session." };
			else {
				try {
					for (const args of commands) execFileSync("herdr", args, { stdio: "ignore", timeout: 1500 });
					state = { ...state, notice: "Focused workspace. Radar is still open here." };
				} catch {
					state = { ...state, notice: "Could not focus that workspace; press r to refresh." };
				}
			}
		}
		paint();
	};
	const onData = (data: Buffer) => {
		if (escapeTimer) clearTimeout(escapeTimer);
		for (const key of keys.feed(utf8.write(data))) handle(key);
		escapeTimer = setTimeout(() => {
			for (const key of keys.flush()) handle(key);
		}, 35);
	};
	const onResize = () => {
		shown = undefined;
		out.write("\x1b[2J");
		paint();
	};
	const timer = setInterval(() => refresh.request(), 2000);
	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.on("data", onData);
	process.once("SIGINT", quit);
	process.once("SIGTERM", quit);
	process.once("exit", cleanup);
	out.on("resize", onResize);
	out.write("\x1b]0;sitra radar\x07\x1b[?1049h\x1b[?25l\x1b[2J");
	paint();
	updateMail();
}
