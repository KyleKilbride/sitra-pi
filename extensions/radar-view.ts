import { drawBox, fitAnsi, type RadarSnapshot, statusBadge, visibleWidth } from "./radar.ts";
import { formatAge, initialRadarState, liveStatus, type RadarState, terminalText } from "./radar-model.ts";

const accent = (text: string) => `\x1b[38;2;95;225;255m${text}\x1b[0m`;
const muted = (text: string) => `\x1b[2m${text}\x1b[0m`;
const plain = (text: string) => terminalText(text).replace(/\n/g, " ");
const clock = (iso: string) =>
	new Date(iso).toLocaleString("en-GB", {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
const deliveryTag = (delivery: RadarSnapshot["mail"][number]["delivery"]): string => {
	if (!delivery) return "[delivery unknown] ";
	if (delivery.confirmed === true) return "";
	if (delivery.status) return `[${plain(delivery.status)}] `;
	if (delivery.confirmed === false) return "[not confirmed] ";
	return "[delivery unknown] ";
};

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
	const nowMs = options.nowMs ?? Date.now();
	const live = liveStatus(snapshot, nowMs);
	const working = snapshot.workers.filter((w) => w.visualState === "working").length;
	const waiting = snapshot.workers.filter((w) => ["waiting_for_user", "error_loop"].includes(w.visualState)).length;
	const activeRuns = snapshot.runs.filter((r) => r.state === "running").length;
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
			const when = m.direction === "out" || m.dateApproximate ? "date unknown" : clock(m.updatedAt);
			const tag = m.direction === "out" ? deliveryTag(m.delivery) : "";
			const preview = m.preview ? ` — ${plain(m.preview)}` : "";
			content.push(
				`${i === state.selected ? "▸" : " "} ${m.direction === "in" ? "←" : "→"} ${when}  ${plain(m.peer)}  ${tag}${plain(m.subject ?? m.summary)}${preview}`,
			);
		}
		cursor = state.selected;
	} else if (state.view === "runs") {
		title = "RUNS · TESTS, BUILDS & INSTALLS";
		for (let i = 0; i < snapshot.runs.length; i++) {
			const r = snapshot.runs[i];
			if (!r) continue;
			const word =
				r.state === "running"
					? "● running"
					: r.state === "passed"
						? "✓ passed"
						: r.state === "failed"
							? `✗ failed (exit ${r.exitCode ?? "?"})`
							: "◌ stopped";
			const owner = [
				r.agent,
				r.sessionId ? `session ${r.sessionId}` : undefined,
				r.project,
				r.branch ? `(${r.branch})` : undefined,
			]
				.filter(Boolean)
				.join(" ");
			content.push(
				`${i === state.selected ? "▸" : " "} ${word}  ${plain(r.label)} — ${owner ? plain(owner) : "owner unknown"} · ${formatAge(nowMs - Date.parse(r.updatedAt))} ago`,
			);
		}
		cursor = state.selected;
	} else {
		list = false;
		if (state.view === "message") {
			const mail = snapshot.mail.find((m) => m.id === state.itemId);
			title = "MESSAGE · READ ONLY";
			content = wrap(
				mail
					? `${mail.direction === "in" ? "From" : "To"}: ${mail.peer}\nSubject: ${mail.subject ?? mail.summary}\n${mail.updatedAt} · ${mail.state}\n\n${mail.body ?? mail.preview ?? mail.subject ?? mail.summary}`
					: "This message is no longer in the local mailbox.",
				width,
			);
		} else if (state.view === "run") {
			const run = snapshot.runs.find((r) => r.id === state.itemId);
			const owner = run
				? [
						run.agent,
						run.sessionId ? `session ${run.sessionId}` : undefined,
						run.project,
						run.branch ? `(${run.branch})` : undefined,
					]
						.filter(Boolean)
						.join(" ")
				: "";
			title = "RUN OUTPUT · LAST 80 LINES";
			content = wrap(
				run
					? `${run.label}${owner ? ` — ${owner}` : ""}\n${run.done ? `Finished · exit ${run.exitCode ?? "unknown"}` : "Running · output refreshes automatically"}\n\n${run.tail || "No output yet"}`
					: "This run is no longer available.",
				width,
			);
		} else {
			title = "TOWER STATUS";
			const section = (label: string, items: string[]) =>
				`${label}\n${items.length ? items.map((i) => `• ${i}`).join("\n") : "Nothing right now"}`;
			content = wrap(
				[
					`Live view, refreshed ${clock(live.updatedAt)}. Workers, runs and proposals update by themselves.`,
					live.notesUpdatedAt
						? `Tower notes last written ${formatAge(nowMs - Date.parse(live.notesUpdatedAt))} ago.`
						: "The tower has not written any notes.",
					"",
					section("● Being done", live.doing),
					"",
					section("✓ Done", live.done),
					"",
					section("→ Next", live.next),
				].join("\n"),
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
	const compact = (label: string, items: string[]) =>
		` ${label} ${items.length ? `${plain(items[0] ?? "")}${items.length > 1 ? ` (+${items.length - 1}; s)` : ""}` : "Nothing right now"}`;
	const notesAge = live.notesUpdatedAt ? formatAge(nowMs - Date.parse(live.notesUpdatedAt)) : undefined;
	const status = drawBox(
		`STATUS live${notesAge ? ` · notes ${notesAge} old` : ""}`,
		"",
		[compact("✓ Done:", live.done), compact("● Being done:", live.doing), compact("→ Next:", live.next)],
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
