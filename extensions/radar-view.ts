import { drawBox, fitAnsi, type RadarSnapshot, statusBadge, visibleWidth } from "./radar.ts";
import { initialRadarState, type RadarState, terminalText } from "./radar-model.ts";

const accent = (text: string) => `\x1b[38;2;95;225;255m${text}\x1b[0m`;
const muted = (text: string) => `\x1b[2m${text}\x1b[0m`;
const plain = (text: string) => terminalText(text).replace(/\n/g, " ");

function wrap(text: string, width: number): string[] {
	const out: string[] = [];
	for (const line of terminalText(text).split("\n")) {
		let current = "";
		for (const ch of line) {
			if (visibleWidth(current + ch) > width) {
				out.push(current);
				current = "";
			}
			current += ch;
		}
		out.push(current);
	}
	return out;
}

export interface RadarLayout {
	scrollStart: number;
	header: string[];
	body: string[];
	summary: string[];
	footer: string[];
}

/** Allocate the viewport before rendering; status and controls cannot be pushed off-screen by more workers. */
export function buildRadarLayout(
	snapshot: RadarSnapshot,
	options: { cols: number; rows: number; state?: RadarState; nowMs?: number },
): RadarLayout {
	const cols = Math.max(1, options.cols);
	const rows = Math.max(1, options.rows);
	if (cols < 20 || rows < 12) {
		const header = ["Enlarge terminal to 20×12", "q quit · m mail · Esc back"]
			.slice(0, rows)
			.map((line) => fitAnsi(line, cols));
		while (header.length < rows) header.push(fitAnsi("", cols));
		return { header, body: [], summary: [], footer: [], scrollStart: 0 };
	}
	const state = options.state ?? initialRadarState();
	const working = snapshot.workers.filter((w) => w.visualState === "working").length;
	const waiting = snapshot.workers.filter((w) => ["waiting_for_user", "error_loop"].includes(w.visualState)).length;
	const activeRuns = snapshot.runs.filter((r) => !r.done).length;
	const notice = state.notice ?? (state.view === "mail" || state.view === "message" ? snapshot.mailNotice : undefined);
	const header = [
		fitAnsi(accent(` SITRA · ${plain(snapshot.towerName)} · ${working} working · ${waiting} need you`), cols),
		fitAnsi(
			notice
				? plain(notice)
				: ` Workspaces ${snapshot.workers.length}   [m] Mail ${snapshot.mail.length}   [b] Runs ${activeRuns} active   [s] Status`,
			cols,
		),
	];
	const bodyHeight = rows - 9;
	const viewport = Math.max(1, bodyHeight - 2);
	const width = cols - 4;
	let title = "WORKSPACES";
	let content: string[] = [];
	let cursor = 0;
	let list = true;
	if (state.view === "workers") {
		for (let i = 0; i < snapshot.workers.length; i++) {
			const w = snapshot.workers[i];
			if (!w) continue;
			content.push(
				`${i === state.selected ? "▸" : " "} #${w.index} ${plain(w.title)} ${statusBadge(w.visualState, w.activeHelpers)}`,
			);
			content.push(`  ${plain(w.nowLine ?? w.lead.waitingFor ?? w.lead.task ?? "Standing by")}`);
			content.push(muted(`  ${plain(w.lastLine ?? w.lead.branch ?? w.subtitle ?? "No recent update")}`));
		}
		cursor = state.selected * 3;
	} else if (state.view === "mail") {
		title = "MAILBOX · READ ONLY";
		for (let i = 0; i < snapshot.mail.length; i++) {
			const m = snapshot.mail[i];
			if (!m) continue;
			content.push(
				`${i === state.selected ? "▸" : " "} ${m.direction === "in" ? "←" : "→"} ${plain(m.peer)} · ${plain(m.state)} · ${plain(m.updatedAt).slice(0, 16).replace("T", " ")}`,
			);
			content.push(`  ${plain(m.summary)}`);
		}
		cursor = state.selected * 2;
	} else if (state.view === "runs") {
		title = "RUNS · TESTS, BUILDS & INSTALLS";
		for (let i = 0; i < snapshot.runs.length; i++) {
			const r = snapshot.runs[i];
			if (!r) continue;
			content.push(
				`${i === state.selected ? "▸" : " "} ${!r.done ? "● running" : r.exitCode === 0 ? "✓ passed" : `✗ exit ${r.exitCode ?? "unknown"}`} · ${plain(r.label)}`,
			);
			content.push(muted(`  ${r.updatedAt.slice(0, 16).replace("T", " ")} · Enter to read output`));
		}
		cursor = state.selected * 2;
	} else {
		list = false;
		if (state.view === "message") {
			const mail = snapshot.mail.find((m) => m.id === state.itemId);
			title = "MESSAGE · READ ONLY";
			content = wrap(
				mail
					? `${mail.direction === "in" ? "From" : "To"}: ${mail.peer}\n${mail.updatedAt} · ${mail.state}\n\n${mail.body ?? mail.summary}`
					: "This message is no longer in the local mailbox.",
				width,
			);
		} else if (state.view === "run") {
			const run = snapshot.runs.find((r) => r.id === state.itemId);
			title = "RUN OUTPUT · LAST 80 LINES";
			content = wrap(
				run
					? `${run.label}\n${run.done ? `Finished · exit ${run.exitCode ?? "unknown"}` : "Running · output refreshes automatically"}\n\n${run.tail || "No output yet"}`
					: "This run is no longer available.",
				width,
			);
		} else {
			title = "TOWER STATUS";
			const summary = snapshot.summary;
			content = wrap(
				summary
					? `Updated ${summary.updatedAt}\n\n✓ Done\n${summary.done.join("\n") || "Nothing recorded"}\n\n● Being done\n${summary.doing.join("\n") || "Nothing recorded"}\n\n→ Next\n${summary.next.join("\n") || "Nothing recorded"}`
					: "The tower has not published a status update yet.",
				width,
			);
		}
		cursor = state.scroll;
	}
	if (!content.length)
		content = [
			muted(
				state.view === "mail"
					? (snapshot.mailNotice ?? "No locally available messages.")
					: state.view === "runs"
						? "No tracked tests, builds or installs."
						: "No worker sessions found.",
			),
		];
	const start = Math.max(0, Math.min(cursor, content.length - viewport));
	const page = content.slice(start, start + viewport);
	while (page.length < viewport) page.push("");
	const body = drawBox(
		title,
		`${start + 1}–${Math.min(content.length, start + viewport)}/${content.length}${list ? "" : " lines"}`,
		page.map((line) => ` ${line}`),
		cols,
		[65, 180, 215],
	);
	const summary = snapshot.summary;
	const age = summary
		? Math.max(0, Math.floor(((options.nowMs ?? Date.now()) - Date.parse(summary.updatedAt)) / 60_000))
		: undefined;
	const compact = (label: string, items: string[] | undefined) =>
		` ${label} ${items?.length ? `${plain(items[0] ?? "")}${items.length > 1 ? ` (+${items.length - 1}; s)` : ""}` : "Not recorded"}`;
	const ageLabel =
		age === undefined
			? "unknown"
			: age < 60
				? `${age}m`
				: age < 1440
					? `${Math.floor(age / 60)}h`
					: `${Math.floor(age / 1440)}d`;
	const status = drawBox(
		`STATUS ${ageLabel}${age === undefined ? "" : " old"}`,
		"",
		[compact("✓ Done:", summary?.done), compact("● Being done:", summary?.doing), compact("→ Next:", summary?.next)],
		cols,
		[100, 160, 140],
	);
	const detail = ["message", "run", "summary"].includes(state.view);
	const primaryControls =
		cols < 80
			? ` ↑↓ ${detail ? "PgUp/Dn" : "↵"}${state.view === "workers" ? " 1-9" : ""} · m b s`
			: detail
				? " ↑/↓ / PgUp/PgDn scroll · Home/End · m mail · b runs · s status"
				: state.view === "workers"
					? " ↑/↓ select · Enter focus · 1-9 workspace · m mail · b runs · s status"
					: " ↑/↓ select · Enter read · m mail · b runs · s status";
	const backControls =
		state.view === "workers" ? " q quit · r refresh" : cols < 24 ? " q back · r refresh" : " Esc/q back · r refresh";
	const footer = [primaryControls, backControls];
	return { header, body, summary: status, footer: footer.map((line) => fitAnsi(line, cols)), scrollStart: start };
}
