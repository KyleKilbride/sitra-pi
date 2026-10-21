import { describe, expect, test } from "vitest";
import type { RadarSnapshot, WorkerCard } from "../extensions/radar.ts";
import { renderRadarFrame, visibleWidth } from "../extensions/radar.ts";
import {
	createRadarKeyDecoder,
	focusCommands,
	initialRadarState,
	reduceRadarKey,
	terminalText,
	validSummary,
} from "../extensions/radar-model.ts";
import { buildRadarLayout } from "../extensions/radar-view.ts";

const worker = (index: number): WorkerCard => ({
	index,
	title: `worker-${index}`,
	workspaceId: `w${index}`,
	tabId: `w${index}:t2`,
	lead: {
		id: `lead-${index}`,
		role: "lead",
		pid: process.pid,
		cwd: "/work/app",
		repo: "/work/app",
		paneId: `w${index}:p3`,
		status: "idle",
		startedAt: "2026-10-21T10:00:00Z",
		updatedAt: "2026-10-21T10:00:00Z",
	},
	teammates: [],
	activeHelpers: 0,
	visualState: "idle",
	activity: [],
});
const snapshot: RadarSnapshot = {
	towerName: "Tower",
	workers: [worker(2), worker(7), worker(12)],
	alerts: [],
	pendingProposals: 0,
	runs: [{ id: "r1", label: "tests", done: true, exitCode: 1, updatedAt: "2026-10-21T10:00:00Z", tail: "a\nb\nc" }],
	mail: [
		{
			id: "m1",
			peer: "peer",
			direction: "in",
			state: "received",
			summary: "subject",
			body: "first\nsecond",
			updatedAt: "2026-10-21T10:00:00Z",
		},
	],
};

describe("radar keyboard protocols", () => {
	test("decodes fragmented and coalesced legacy, application and Kitty keys; ignores release/focus/paste", () => {
		const decoder = createRadarKeyDecoder();
		expect(decoder.feed("j\x1b[")).toEqual(["down"]);
		expect(decoder.feed("B\x1bOA\r7")).toEqual(["down", "up", "enter", "7"]);
		expect(decoder.feed("\x1b[109u\x1b[57353;1:1u\x1b[13;1u")).toEqual(["m", "down", "enter"]);
		expect(decoder.feed("\x1b[113;1:3u\x1b[I\x1b[O\x1b[200~qmr\x1b[201~")).toEqual([]);
		expect(decoder.feed("\x1b[1;1A\x1b[6~\x1b[5~\x1b[27u")).toEqual(["up", "pagedown", "pageup", "escape"]);
		expect(decoder.feed("\x1b[4~")).toEqual(["end"]);
		expect(decoder.feed("\x1b")).toEqual([]);
		expect(decoder.flush()).toEqual(["escape"]);
		expect(decoder.feed("\x03")).toEqual(["interrupt"]);
		expect(decoder.feed("\x1b[99;5u")).toEqual(["interrupt"]);
		expect(decoder.feed("\x1b[")).toEqual([]);
		expect(decoder.flush()).toEqual([]);
		expect(decoder.feed("A")).toEqual(["up"]);
	});
	test("does not turn unknown or modified escape sequences into shortcuts", () => {
		const decoder = createRadarKeyDecoder();
		expect(decoder.feed("\x1b[1;5A\x1b[109;5u\x1bq\x1b[999~")).toEqual([]);
	});
});

describe("radar navigation", () => {
	test("selects by workspace number, never by accidental array fallback", () => {
		const initial = initialRadarState();
		expect(reduceRadarKey(initial, "7", snapshot).effect).toEqual({ type: "focus", worker: snapshot.workers[1] });
		expect(reduceRadarKey(initial, "1", snapshot).effect).toBeUndefined();
		const down = reduceRadarKey(initial, "down", snapshot).state;
		expect(down.selected).toBe(1);
		expect(reduceRadarKey(down, "enter", snapshot).effect).toEqual({ type: "focus", worker: snapshot.workers[1] });
	});
	test("mail opens selected message, scrolls, returns to mail, then radar without quitting", () => {
		let state = reduceRadarKey(initialRadarState(), "m", snapshot).state;
		expect(state.view).toBe("mail");
		state = reduceRadarKey(state, "enter", snapshot).state;
		expect(state.view).toBe("message");
		expect(state.itemId).toBe("m1");
		state = reduceRadarKey(state, "pagedown", snapshot).state;
		expect(state.scroll).toBeGreaterThan(0);
		state = reduceRadarKey(state, "escape", snapshot).state;
		expect(state.view).toBe("mail");
		const back = reduceRadarKey(state, "q", snapshot);
		expect(back.state.view).toBe("workers");
		expect(back.effect).toBeUndefined();
		expect(reduceRadarKey(back.state, "q", snapshot).effect?.type).toBe("quit");
	});
	test("run details and summary have a return path and never focus a worker", () => {
		let state = reduceRadarKey(initialRadarState(), "b", snapshot).state;
		expect(state.view).toBe("runs");
		const opened = reduceRadarKey(state, "enter", snapshot);
		expect(opened.effect).toBeUndefined();
		expect(opened.state.view).toBe("run");
		expect(opened.state.itemId).toBe("r1");
		state = reduceRadarKey(opened.state, "escape", snapshot).state;
		expect(state.view).toBe("runs");
		expect(reduceRadarKey(state, "escape", snapshot).state.view).toBe("workers");
		expect(reduceRadarKey(initialRadarState(), "s", snapshot).state.view).toBe("summary");
		expect(reduceRadarKey(initialRadarState(), "r", snapshot).effect?.type).toBe("refresh");
	});
	test("empty lists do not open undefined details or negative selections", () => {
		const empty = { ...snapshot, workers: [], mail: [], runs: [] };
		for (const view of ["workers", "mail", "runs"] as const) {
			let state: ReturnType<typeof initialRadarState> = { ...initialRadarState(), view };
			state = reduceRadarKey(state, "down", empty).state;
			expect(state.selected).toBe(0);
			expect(reduceRadarKey(state, "enter", empty).state.view).toBe(view);
		}
	});
	test("focus targets the lead tab, not whichever helper tab was last visible", () => {
		expect(focusCommands(worker(7))).toEqual([
			["workspace", "focus", "w7"],
			["tab", "focus", "w7:t2"],
		]);
		expect(focusCommands({ ...worker(7), workspaceId: undefined, tabId: undefined })).toEqual([
			["workspace", "focus", "w7"],
		]);
	});
});

test("back-navigation clamps the selected item to the destination list", () => {
	const state = { ...initialRadarState(), view: "mail" as const, selected: 7 };
	const back = reduceRadarKey(state, "escape", snapshot).state;
	expect(back.view).toBe("workers");
	expect(back.selected).toBeLessThan(snapshot.workers.length);
	expect(reduceRadarKey(back, "enter", snapshot).effect?.type).toBe("focus");
});

describe("viewport budget", () => {
	test("pins status and controls in every view with more workers and messages than fit", () => {
		const many = {
			...snapshot,
			workers: Array.from({ length: 50 }, (_, i) => worker(i + 1)),
			summary: {
				done: ["done-marker"],
				doing: ["doing-marker"],
				next: ["next-marker"],
				updatedAt: "2026-10-21T10:00:00Z",
			},
		};
		for (const cols of [20, 36, 84, 120])
			for (const rows of [12, 24, 40])
				for (const view of ["workers", "mail", "runs", "message", "run", "summary"] as const) {
					const state = { ...initialRadarState(), view, selected: 49, itemId: view === "message" ? "m1" : "r1" };
					const layout = buildRadarLayout(many, { cols, rows, state });
					const lines = renderRadarFrame(many, { cols, rows, state }).split("\n");
					expect(lines).toHaveLength(rows);
					for (const line of lines) expect(visibleWidth(line)).toBe(cols);
					expect(layout.summary).toHaveLength(5);
					expect(layout.footer).toHaveLength(2);
					if (cols >= 36)
						for (const marker of ["done-marker", "doing-marker", "next-marker"])
							expect(layout.summary.join("\n")).toContain(marker);
					if (view === "workers") expect(layout.body.join("\n")).toContain("worker-50");
				}
	});
	test("mail and focus notices cannot replace pinned controls", () => {
		const value = { ...snapshot, mailNotice: "mail-notice-marker" };
		const layout = buildRadarLayout(value, { cols: 84, rows: 24, state: { ...initialRadarState(), view: "mail" } });
		expect(layout.header.join("\n")).toContain("mail-notice-marker");
		expect(layout.footer.join("\n")).not.toContain("mail-notice-marker");
	});
	test("freshness remains visible in a narrow pinned summary", () => {
		const value = {
			...snapshot,
			summary: { done: [], doing: ["outside report"], next: [], updatedAt: "2026-10-21T10:00:00Z" },
		};
		const layout = buildRadarLayout(value, { cols: 36, rows: 24, nowMs: Date.parse("2026-10-21T10:17:00Z") });
		expect(layout.summary[0]).toContain("17m");
	});
	test("full message and log scroll clamp to the final page without losing stored identity", () => {
		const message = snapshot.mail[0];
		if (!message) throw new Error("Missing message fixture");
		const big = {
			...snapshot,
			mail: [{ ...message, body: Array.from({ length: 40 }, (_, i) => `mail-line-${i}`).join("\n") }],
		};
		const state = { ...initialRadarState(), view: "message" as const, itemId: "m1", scroll: 1_000_000 };
		const layout = buildRadarLayout(big, { cols: 84, rows: 24, state });
		expect(layout.body.join("\n")).toContain("mail-line-39");
		expect(layout.body.join("\n")).not.toContain("mail-line-0");
		const normalized = { ...state, scroll: layout.scrollStart };
		const previous = reduceRadarKey(normalized, "up", big).state;
		expect(previous.scroll).toBe(layout.scrollStart - 1);
	});
});

test("very small terminal sizes stay bounded rather than writing beyond the screen", () => {
	for (const cols of [8, 19, 50])
		for (const rows of [1, 6, 11]) {
			const lines = renderRadarFrame(snapshot, { cols, rows }).split("\n");
			expect(lines).toHaveLength(rows);
			for (const line of lines) expect(visibleWidth(line)).toBe(cols);
		}
});

describe("dashboard boundaries", () => {
	test("untrusted mail cannot inject terminal actions, bidi overrides or styling", () => {
		expect(terminalText("Hello\x1b]52;c;secret\x07\x1b[2J\x1b[31mworld\r\u202e\nnext\tcol")).toBe(
			"Helloworld\nnext  col",
		);
	});
	test("accepts only bounded structured summaries with a real timestamp", () => {
		expect(validSummary({ done: ["checked"], doing: ["building"], next: [], updatedAt: "2026-10-21T10:00:00Z" })).toBe(
			true,
		);
		for (const value of [
			null,
			{},
			{ done: [], doing: [], next: [], updatedAt: "yesterday" },
			{ done: [17], doing: [], next: [], updatedAt: "2026-10-21T10:00:00Z" },
		])
			expect(validSummary(value)).toBe(false);
	});
});
