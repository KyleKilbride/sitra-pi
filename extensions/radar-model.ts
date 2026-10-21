import { stripVTControlCharacters } from "node:util";
import type { RadarSnapshot, WorkerCard } from "./radar.ts";

export type RadarView = "workers" | "mail" | "message" | "runs" | "run" | "summary";
export interface RadarState {
	view: RadarView;
	selected: number;
	scroll: number;
	itemId?: string;
	notice?: string;
}
export type RadarEffect = { type: "focus"; worker: WorkerCard } | { type: "quit" } | { type: "refresh" };
export interface TowerSummary {
	done: string[];
	doing: string[];
	next: string[];
	updatedAt: string;
}

/** Initial view shared by the renderer and keyboard controller. */
export function initialRadarState(): RadarState {
	return { view: "workers", selected: 0, scroll: 0 };
}

/** Pure navigation; opening mail and logs never sends messages or runs commands. */
export function reduceRadarKey(
	state: RadarState,
	key: string,
	snapshot: RadarSnapshot,
): { state: RadarState; effect?: RadarEffect } {
	if (key === "interrupt") return { state, effect: { type: "quit" } };
	if (key === "q" || key === "escape") {
		if (state.view === "workers") return key === "q" ? { state, effect: { type: "quit" } } : { state };
		const view = state.view === "message" ? "mail" : state.view === "run" ? "runs" : "workers";
		const count =
			view === "workers" ? snapshot.workers.length : view === "mail" ? snapshot.mail.length : snapshot.runs.length;
		return {
			state: {
				...state,
				view,
				selected: Math.max(0, Math.min(state.selected, count - 1)),
				scroll: 0,
				itemId: undefined,
				notice: undefined,
			},
		};
	}
	if (key === "r") return { state, effect: { type: "refresh" } };
	const view = key === "m" ? "mail" : key === "b" ? "runs" : key === "s" ? "summary" : undefined;
	if (view) return { state: { view, selected: 0, scroll: 0 } };
	const detail = ["message", "run", "summary"].includes(state.view);
	const count =
		state.view === "workers"
			? snapshot.workers.length
			: state.view === "mail"
				? snapshot.mail.length
				: snapshot.runs.length;
	if (["up", "down", "pageup", "pagedown", "home", "end"].includes(key)) {
		const current = detail ? state.scroll : state.selected;
		const delta = key === "up" ? -1 : key === "down" ? 1 : key === "pageup" ? -8 : 8;
		const position =
			key === "home" ? 0 : key === "end" ? (detail ? 1_000_000 : Math.max(0, count - 1)) : Math.max(0, current + delta);
		return {
			state: {
				...state,
				...(detail ? { scroll: position } : { selected: Math.min(Math.max(0, count - 1), position) }),
			},
		};
	}
	if (state.view === "workers") {
		const selected = /^[1-9]$/.test(key) ? snapshot.workers.findIndex((w) => w.index === Number(key)) : state.selected;
		const worker = snapshot.workers[selected];
		if ((key === "enter" || /^[1-9]$/.test(key)) && worker)
			return { state: { ...state, selected }, effect: { type: "focus", worker } };
	} else if (key === "enter" && !detail) {
		const item = state.view === "mail" ? snapshot.mail[state.selected] : snapshot.runs[state.selected];
		if (item)
			return { state: { ...state, view: state.view === "mail" ? "message" : "run", itemId: item.id, scroll: 0 } };
	}
	return { state };
}

/** Streaming decoder for legacy, application-cursor and Kitty/CSI-u keyboard protocols. */
export function createRadarKeyDecoder(): { feed(chunk: string): string[]; flush(): string[] } {
	let pending = "";
	let pasting = false;
	const normalize = (value: string): string | undefined => {
		if (value === "\x03") return "interrupt";
		if (value === "\x1b") return "escape";
		if (value === "\r" || value === "\n") return "enter";
		if (value === "j") return "down";
		if (value === "k") return "up";
		return /^[qmrbs1-9]$/.test(value) ? value : undefined;
	};
	return {
		feed(chunk) {
			pending += chunk;
			const keys: string[] = [];
			while (pending) {
				if (pasting) {
					const end = pending.indexOf("\x1b[201~");
					if (end < 0) {
						pending = pending.slice(-5);
						break;
					}
					pending = pending.slice(end + 6);
					pasting = false;
					continue;
				}
				let key: string | undefined;
				if (pending[0] !== "\x1b") {
					key = normalize(pending[0] ?? "");
					pending = pending.slice(1);
				} else {
					if (pending.length === 1) break;
					if (pending[1] !== "[" && pending[1] !== "O") {
						pending = pending.slice(2);
						continue;
					}
					const match = /^(?:\[[0-9:;?<>]*[A-Za-z~]|O[A-Za-z])/.exec(pending.slice(1));
					if (!match) {
						if (pending.length > 64) pending = "";
						break;
					}
					const sequence = `\x1b${match[0]}`;
					pending = pending.slice(sequence.length);
					if (sequence === "\x1b[200~") {
						pasting = true;
						continue;
					}
					const arrow = /^(?:\[|O)(?:1;1)?([ABHF])$/.exec(sequence.slice(1));
					if (arrow) key = ({ A: "up", B: "down", H: "home", F: "end" } as Record<string, string>)[arrow[1] ?? ""];
					const page = /^\[([145678])~$/.exec(sequence.slice(1));
					if (page)
						key = ({ 1: "home", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end" } as Record<string, string>)[
							page[1] ?? ""
						];
					const kitty = /^\[(\d+)(?::\d+)*(?:;(\d+)(?::(\d+))?)?u$/.exec(sequence.slice(1));
					if (kitty?.[1] === "99" && kitty[2] === "5" && kitty[3] !== "3") key = "interrupt";
					if (kitty && (!kitty[2] || kitty[2] === "1") && kitty[3] !== "3") {
						const code = Number(kitty[1]);
						key =
							(
								{
									57344: "escape",
									57345: "enter",
									57352: "up",
									57353: "down",
									57354: "pageup",
									57355: "pagedown",
									57356: "home",
									57357: "end",
								} as Record<number, string>
							)[code] ?? (code <= 0x10ffff ? normalize(String.fromCodePoint(code)) : undefined);
					}
				}
				if (key) keys.push(key);
			}
			return keys;
		},
		flush() {
			const keys = pending === "\x1b" && !pasting ? ["escape"] : [];
			if (pending === "\x1b") pending = "";
			return keys;
		},
	};
}

/** Focus the workspace and its actual lead tab, rather than a previously focused helper. */
export function focusCommands(worker: WorkerCard): string[][] {
	const workspace = worker.workspaceId ?? worker.lead.paneId?.split(":")[0];
	return workspace
		? [["workspace", "focus", workspace], ...(worker.tabId ? [["tab", "focus", worker.tabId]] : [])]
		: [];
}

/** Plain terminal-safe text at the boundary; peer content must never become terminal control bytes. */
export function terminalText(text: string): string {
	return Array.from(stripVTControlCharacters(text))
		.filter((ch) => {
			const code = ch.codePointAt(0) ?? 0;
			return (
				code === 9 ||
				code === 10 ||
				(code >= 32 &&
					!(code >= 127 && code <= 159) &&
					!(code >= 0x202a && code <= 0x202e) &&
					!(code >= 0x2066 && code <= 0x2069))
			);
		})
		.join("")
		.replace(/\t/g, "  ");
}

/** Validate persisted summary updates before exposing them on the shared dashboard. */
export function validSummary(value: unknown): value is TowerSummary {
	if (!value || typeof value !== "object") return false;
	const summary = value as TowerSummary;
	return (
		typeof summary.updatedAt === "string" &&
		Number.isFinite(Date.parse(summary.updatedAt)) &&
		[summary.done, summary.doing, summary.next].every(
			(items) =>
				Array.isArray(items) &&
				items.length <= 20 &&
				items.every((line) => typeof line === "string" && line.length <= 1000),
		)
	);
}
