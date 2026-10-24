/**
 * Grimoire learns from corrections. When the person sends a message, sitra records the moment (their words, the
 * agent's last reply, its recent tool calls). A background process asks a model whether the message corrects the
 * agent and, if so, drafts the missing rule as a proposal, with a trigger when one fits. Corrections stay as
 * replayable cases, and each trigger pause records whether the agent changed course. No Pi imports.
 *
 * Everything lives in `<grimoire>/.sitra/`: `moments/<id>.json`, `pauses.jsonl`, `pending-pause/<session>.json`.
 */
import { spawn } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	linkSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Entry,
	KINDS,
	type Kind,
	listEntries,
	listProposals,
	listRejected,
	loadRoot,
	writeProposal,
} from "./grimoire.ts";
import { parseTrigger, type TriggerCase } from "./triggers.ts";

export interface Call {
	tool: string;
	input: Record<string, unknown>;
}

export interface Moment {
	id: string;
	at: string;
	harness: "pi" | "claude" | "codex";
	cwd: string;
	/** What the person said. */
	message: string;
	/** What the agent last said before it. */
	agentReply: string;
	/** The agent's most recent tool calls, oldest first. */
	calls: Call[];
	/** The session's project id, when it had one. */
	project?: string;
	/** Why the session had no project although projects exist. */
	scopeNote?: string;
	verdict?: "correction" | "other";
	proposal?: string;
	skipped?: string;
}

const MAX_CALLS = 12;
const REPLY_CHARS = 2_000;
const MESSAGE_CHARS = 2_000;
const INPUT_CHARS = 600;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function clipInput(input: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(input)) out[k] = typeof v === "string" ? clip(v, INPUT_CHARS) : v;
	return JSON.stringify(out).length > INPUT_CHARS * 4
		? {
				...(typeof out.command === "string" ? { command: out.command } : {}),
				...(typeof out.path === "string" ? { path: out.path } : {}),
				...(typeof out.file_path === "string" ? { file_path: out.file_path } : {}),
			}
		: out;
}

/** Codex's `response_item` records: assistant `output_text`, `function_call` (JSON `arguments`), `custom_tool_call`. */
function codexItem(p: Record<string, unknown>): { text?: string; call?: Call } | undefined {
	if (p.type === "message" && p.role === "assistant" && Array.isArray(p.content)) {
		const text = (p.content as { type?: string; text?: string }[])
			.filter((c) => c?.type === "output_text" && typeof c.text === "string")
			.map((c) => (c.text as string).trim())
			.join("\n");
		return text ? { text } : undefined;
	}
	if (p.type === "function_call" && typeof p.name === "string") {
		let input: Record<string, unknown> = {};
		try {
			const parsed = JSON.parse(String(p.arguments ?? "{}"));
			if (parsed && typeof parsed === "object") input = parsed;
		} catch {
			// Arguments that aren't JSON: keep the call, without input.
		}
		const shell = p.name === "exec_command" || p.name === "shell" || p.name === "local_shell";
		const raw = input.cmd ?? input.command;
		const cmd =
			typeof raw === "string"
				? raw
				: Array.isArray(raw) && raw.every((x) => typeof x === "string")
					? raw.join(" ")
					: undefined;
		if (shell && typeof cmd === "string")
			return { call: { tool: "Bash", input: clipInput({ ...input, cmd, command: cmd }) } };
		return { call: { tool: p.name, input: clipInput(input) } };
	}
	if (p.type === "custom_tool_call" && typeof p.name === "string") {
		return { call: { tool: p.name, input: typeof p.input === "string" ? clipInput({ input: p.input }) : {} } };
	}
	return undefined;
}

/**
 * The moment from a transcript's last lines: Pi (`message.role`, `toolCall`) and Claude Code (`type`, `tool_use`)
 * shapes; anything else is skipped, so an unknown format just gives an empty moment.
 */
export function momentFromTranscript(
	jsonl: string,
	options: { message: string; harness: Moment["harness"]; cwd: string },
): Omit<Moment, "id" | "at"> {
	let agentReply = "";
	const calls: Call[] = [];
	for (const line of jsonl.split("\n")) {
		let e: { type?: string; message?: { role?: string; content?: unknown }; payload?: Record<string, unknown> };
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (e?.type === "response_item" && e.payload && typeof e.payload === "object") {
			let r: ReturnType<typeof codexItem>;
			try {
				r = codexItem(e.payload);
			} catch {
				continue; // One odd record never costs the whole moment.
			}
			if (r?.text) agentReply = r.text;
			if (r?.call) calls.push(r.call);
			continue;
		}
		const role = e?.message?.role ?? e?.type;
		if (role !== "assistant" || !Array.isArray(e.message?.content)) continue;
		const texts: string[] = [];
		for (const part of e.message.content as {
			type?: string;
			text?: string;
			name?: string;
			arguments?: unknown;
			input?: unknown;
		}[]) {
			if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) texts.push(part.text.trim());
			else if ((part?.type === "toolCall" || part?.type === "tool_use") && typeof part.name === "string") {
				const input = (part.arguments ?? part.input ?? {}) as Record<string, unknown>;
				calls.push({ tool: part.name, input: input && typeof input === "object" ? clipInput(input) : {} });
			}
		}
		if (texts.length > 0) agentReply = texts.join("\n");
	}
	return {
		harness: options.harness,
		cwd: options.cwd,
		message: clip(options.message, MESSAGE_CHARS),
		agentReply: clip(agentReply, REPLY_CHARS),
		calls: calls.slice(-MAX_CALLS),
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// Prompts. Measured on 183 labelled messages (59 corrections): a mid-size model with this wording caught 54 with
// 1 false alarm; fast decision models caught about 40.
// ---------------------------------------------------------------------------------------------------------------------

const CORRECTION =
	"The person's message tells the agent that something it did, said, assumed or planned was wrong or unwanted, repeats a rule or preference the agent failed to follow, or asks it to undo or stop something it did. A new task, an approval, a plain question, extra information, or a change of mind that doesn't fault the agent is not this.";

export function detectionPrompt(m: { agentReply: string; message: string }): { system: string; user: string } {
	return {
		system: `${CORRECTION} Reply with exactly YES if the person's message is this, else NO.`,
		user: `AGENT'S LAST REPLY:\n${m.agentReply || "(none)"}\n\nPERSON'S MESSAGE:\n${m.message}`,
	};
}

/** Only a reply that is YES (alone, any case, optional full stop) counts. */
export function parseVerdict(text: string): boolean {
	return /^\s*yes\.?\s*$/i.test(text);
}

export function draftPrompt(
	m: Pick<Moment, "message" | "agentReply" | "calls">,
	catalogue: string,
): { system: string; user: string } {
	const calls = m.calls.map((c) => `- ${c.tool}: ${JSON.stringify(c.input)}`).join("\n") || "(none)";
	return {
		system: [
			"A person corrected their AI coding agent. Draft the one rule that, had the agent followed it, would have prevented this, for the person's approved knowledge base (Grimoire).",
			"Use the person's own words where you can. Keep it general enough to apply again, but no broader than what they said.",
			'If the existing entries listed below already cover it, or it is a one-off with no lasting rule, reply with only {"skip":"<why, naming the covering entry if any>"}.',
			'Otherwise reply with only a JSON object: {"kind":"lesson|fact|decision|warning|setup","title":"…","summary":"one sentence: what to do and when","body":"a few sentences: what went wrong and the rule","tags":["…"],"when":["…"]}.',
			'"when" is optional: include it only when the mistake happens at a recognisable action. Each item is "command:<leading words of a shell command>", "path:<glob of files touched>", or "tool:<tool name>"; join conditions that must all hold with " + ". Leave it out if no action marks the moment.',
		].join("\n"),
		user: `EXISTING ENTRIES:\n${catalogue || "(none)"}\n\nAGENT'S RECENT TOOL CALLS (oldest first):\n${calls}\n\nAGENT'S LAST REPLY:\n${m.agentReply || "(none)"}\n\nPERSON'S CORRECTION:\n${m.message}`,
	};
}

export type Draft =
	| { kind: Kind; title: string; summary: string; body: string; tags?: string[]; when?: string[] }
	| { skip: string };

/** The first JSON object in the reply, checked; triggers that don't parse are dropped. */
export function parseDraft(text: string): Draft | undefined {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) return undefined;
	let o: Record<string, unknown>;
	try {
		o = JSON.parse(text.slice(start, end + 1));
	} catch {
		return undefined;
	}
	if (typeof o.skip === "string") return { skip: o.skip };
	const str = (k: string) =>
		typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim() : undefined;
	const kind = str("kind");
	const title = str("title");
	const summary = str("summary");
	const body = str("body");
	if (!KINDS.includes(kind as Kind) || !title || !summary || !body) return undefined;
	const strings = (k: string) =>
		Array.isArray(o[k]) ? (o[k] as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
	const tags = strings("tags");
	const when = strings("when").filter((w) => parseTrigger(w));
	return {
		kind: kind as Kind,
		title,
		summary,
		body,
		...(tags.length ? { tags } : {}),
		...(when.length ? { when } : {}),
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// Moments on disk
// ---------------------------------------------------------------------------------------------------------------------

const momentsDir = (dir: string) => join(dir, ".sitra", "moments");
const momentFile = (dir: string, id: string) => join(momentsDir(dir), `${id.replace(/[^\w.-]/g, "_")}.json`);

export function recordMoment(dir: string, moment: Moment): string {
	mkdirSync(momentsDir(dir), { recursive: true });
	const file = momentFile(dir, moment.id);
	writeFileSync(file, `${JSON.stringify(moment, null, "\t")}\n`);
	return file;
}

function readMoment(dir: string, id: string): Moment | undefined {
	try {
		return JSON.parse(readFileSync(momentFile(dir, id), "utf8")) as Moment;
	} catch {
		return undefined;
	}
}

export interface LearnResult {
	verdict: "correction" | "other" | "already-done" | "error";
	proposal?: string;
	skipped?: string;
	error?: string;
}

/**
 * Decides whether the moment is a correction and, if so, drafts and writes the proposal. `ask(system, user)` calls the
 * model. A moment is decided once; a failing model leaves it undecided and changes nothing else.
 */
export async function learnFromMoment(
	dir: string,
	id: string,
	ask: (system: string, user: string) => Promise<string>,
): Promise<LearnResult> {
	const moment = readMoment(dir, id);
	if (!moment) return { verdict: "error", error: "no such moment" };
	if (moment.verdict) return { verdict: "already-done" };
	try {
		const d = detectionPrompt(moment);
		if (!parseVerdict(await ask(d.system, d.user))) {
			// Not a correction: keep nothing about it beyond the verdict.
			writeFileSync(
				momentFile(dir, moment.id),
				`${JSON.stringify({ id: moment.id, at: moment.at, harness: moment.harness, verdict: "other" })}\n`,
			);
			return { verdict: "other" };
		}
		const line = (e: Entry) => `- [${e.kind}] ${e.title}${e.summary ? `: ${e.summary}` : ""}`;
		const root = loadRoot(dir).text;
		const catalogue = [
			...(root ? ["Always-loaded root:", root, ""] : []),
			"Approved entries:",
			...listEntries(dir).map(line),
			"",
			"Already proposed, waiting for review:",
			...listProposals(dir).map(line),
			"",
			"Rejected by the person (never propose these again):",
			...listRejected(dir).map(line),
		].join("\n");
		const p = draftPrompt(moment, catalogue);
		const draft = parseDraft(await ask(p.system, p.user));
		if (!draft) throw new Error("the draft wasn't a valid entry");
		if ("skip" in draft) {
			recordMoment(dir, { ...moment, verdict: "correction", skipped: draft.skip });
			return { verdict: "correction", skipped: draft.skip };
		}
		const proposal = writeProposal(dir, {
			...draft,
			proposedBy: "sitra-learn",
			date: moment.at,
			evidence: `The person, correcting an agent (${moment.harness}, ${moment.cwd}): "${clip(moment.message, 400)}" (moment ${moment.id})`,
		});
		recordMoment(dir, { ...moment, verdict: "correction", proposal });
		return { verdict: "correction", proposal };
	} catch (e) {
		return { verdict: "error", error: e instanceof Error ? e.message : String(e) };
	}
}

/** Every recorded correction as a replay case; its expected entry is its proposal once accepted into `kinds/`. */
export function casesFromMoments(dir: string): TriggerCase[] {
	if (!existsSync(momentsDir(dir))) return [];
	const accepted = new Map(listEntries(dir).map((e) => [basename(e.file), e.file]));
	const out: TriggerCase[] = [];
	for (const f of readdirSync(momentsDir(dir)).sort()) {
		let m: Moment;
		try {
			m = JSON.parse(readFileSync(join(momentsDir(dir), f), "utf8"));
		} catch {
			continue;
		}
		if (m.verdict !== "correction") continue;
		const approved = m.proposal ? accepted.get(basename(m.proposal)) : undefined;
		out.push({ id: m.id, harness: m.harness, cwd: m.cwd, calls: m.calls, expect: approved ? [approved] : [] });
	}
	return out;
}

/** Moments not yet decided, oldest first (a background run that died leaves some behind). */
export function undecidedMoments(dir: string): string[] {
	if (!existsSync(momentsDir(dir))) return [];
	return readdirSync(momentsDir(dir))
		.sort()
		.flatMap((f) => {
			try {
				const m = JSON.parse(readFileSync(join(momentsDir(dir), f), "utf8")) as Moment;
				return m.verdict ? [] : [m.id];
			} catch {
				return [];
			}
		});
}

// ---------------------------------------------------------------------------------------------------------------------
// Pause outcomes: after a trigger pauses a call, the agent's next call shows whether it changed course.
// ---------------------------------------------------------------------------------------------------------------------

const pendingDir = (dir: string, session: string) =>
	join(dir, ".sitra", "pending-pause", session.replace(/[^\w.-]/g, "_").slice(0, 120) || "unknown");

/** Inputs compared regardless of key order. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
const sameCall = (a: Call, b: Call) => a.tool === b.tool && canonical(a.input) === canonical(b.input);

/** The stable identity used for pause follow-up comparisons: exact tool name plus canonical input. */
export function callKey(call: Call): string {
	return `${JSON.stringify(call.tool)}:${canonical(call.input)}`;
}

/**
 * When a call happened: the agent turn it belongs to, if the tool says, else the time. Calls the agent sends together
 * share a turn; a reaction to a pause needs a new turn (or, without turn ids, at least SAME_TURN_MS later).
 */
export interface CallTime {
	turn?: string;
	now?: number;
	/** The folder the agent works in, shown in the day log. */
	cwd?: string;
}
const SAME_TURN_MS = 1_500;

/** One file per pause, so parallel pauses in a session never overwrite each other. */
export function recordPause(
	dir: string,
	session: string,
	files: readonly string[],
	call: Call,
	when: CallTime = {},
): void {
	const folder = pendingDir(dir, session);
	mkdirSync(folder, { recursive: true });
	writeFileSync(
		join(folder, `${newMomentId()}.json`),
		JSON.stringify({ files, call, turn: when.turn, at: when.now ?? Date.now(), cwd: when.cwd }),
	);
}

/**
 * Called with every call: each pause from an earlier turn is taken atomically by exactly one later call, which settles
 * whether the agent changed course. Leftovers from a crash are cleared after a minute.
 */
export function recordPauseFollowUp(dir: string, session: string, call: Call, when: CallTime = {}): void {
	const folder = pendingDir(dir, session);
	if (!existsSync(folder)) return;
	const now = when.now ?? Date.now();
	for (const f of readdirSync(folder).sort()) {
		const path = join(folder, f);
		if (f.endsWith(".taken")) {
			try {
				if (now - statSync(path).mtimeMs > 60_000) rmSync(path, { force: true });
			} catch {
				// Gone.
			}
			continue;
		}
		if (!f.endsWith(".json")) continue;
		try {
			const peek = JSON.parse(readFileSync(path, "utf8")) as { turn?: string; at?: number };
			const sameTurn =
				peek.turn !== undefined && when.turn !== undefined
					? peek.turn === when.turn
					: now - (peek.at ?? 0) < SAME_TURN_MS;
			if (sameTurn) continue;
		} catch {
			continue;
		}
		const taken = `${path}.${process.pid}.taken`;
		try {
			renameSync(path, taken);
		} catch {
			continue; // Another call took it.
		}
		try {
			const pending = JSON.parse(readFileSync(taken, "utf8")) as { files: string[]; call: Call; cwd?: string };
			const outcome = sameCall(pending.call, call) ? "repeated" : "changed";
			for (const file of pending.files) {
				appendFileSync(
					join(dir, ".sitra", "pauses.jsonl"),
					`${JSON.stringify({ at: new Date(now).toISOString(), file, outcome, session, cwd: pending.cwd, call: pending.call })}\n`,
				);
			}
		} catch {
			// A damaged record is dropped.
		} finally {
			rmSync(taken, { force: true });
		}
	}
}

export interface PauseOutcome {
	file: string;
	pauses: number;
	/** The agent did something else after the pause: the rule changed its course. */
	changed: number;
	/** The agent ran the same call again: it already followed the rule, or ignored it. */
	repeated: number;
}

export function pauseOutcomes(dir: string): PauseOutcome[] {
	const by = new Map<string, PauseOutcome>();
	let text = "";
	try {
		text = readFileSync(join(dir, ".sitra", "pauses.jsonl"), "utf8");
	} catch {
		return [];
	}
	for (const line of text.split("\n")) {
		try {
			const r = JSON.parse(line) as { file: string; outcome: "changed" | "repeated" };
			const o = by.get(r.file) ?? { file: r.file, pauses: 0, changed: 0, repeated: 0 };
			o.pauses++;
			o[r.outcome]++;
			by.set(r.file, o);
		} catch {
			// Partial line.
		}
	}
	return [...by.values()].sort((a, b) => b.pauses - a.pauses || a.file.localeCompare(b.file));
}

// ---------------------------------------------------------------------------------------------------------------------
// Capture and hand-off: record the moment, then let a detached `sitra grimoire learn` decide it, so nothing waits.
// ---------------------------------------------------------------------------------------------------------------------

const SITRA_BIN = fileURLToPath(new URL("../bin/sitra.ts", import.meta.url));

/** Whether moments should be captured: on unless `SITRA_GRIMOIRE_LEARN=0`, and never inside the learner itself. */
export function learningOn(env: Record<string, string | undefined>): boolean {
	return env.SITRA_GRIMOIRE_LEARN !== "0" && env.SITRA_LEARNING !== "1";
}

export function newMomentId(now = new Date()): string {
	return `${now.toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Starts a detached learner for the Grimoire (it decides every undecided moment). `SITRA_LEARN_SPAWN=0` skips it. */
export function startLearner(dir: string, env: Record<string, string | undefined>): void {
	if (env.SITRA_LEARN_SPAWN === "0") return;
	try {
		const child = spawn(process.execPath, [SITRA_BIN, "grimoire", "learn", "--dir", dir], {
			detached: true,
			stdio: "ignore",
			env: { ...env, SITRA_LEARNING: "1" },
		});
		child.on("error", () => {});
		child.unref();
	} catch {
		// Learning is best effort; never disturb the session.
	}
}

/** Records the moment the person sent `message` and starts the learner. Never throws. */
export function captureMoment(
	dir: string,
	env: Record<string, string | undefined>,
	parts: { harness: Moment["harness"]; cwd: string; message: string; transcript: string },
): string | undefined {
	try {
		if (!learningOn(env) || !parts.message.trim() || !existsSync(dir)) return undefined;
		const at = new Date();
		const moment: Moment = {
			id: newMomentId(at),
			at: at.toISOString(),
			...momentFromTranscript(parts.transcript, parts),
		};
		recordMoment(dir, moment);
		startLearner(dir, env);
		return moment.id;
	} catch {
		return undefined;
	}
}

function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** This process's claim token: its pid (so others can tell when it's gone) and a random part (so it's unique). */
const TOKEN = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
const claimPath = (dir: string, id: string) => join(dir, ".sitra", "learning", id.replace(/[^\w.-]/g, "_"));

/** Runs `fn` holding a short lock (a directory, created atomically); a lock left by a crash expires after a minute. */
function withLock<T>(path: string, fn: () => T): T | undefined {
	const lock = `${path}.lock`;
	try {
		mkdirSync(lock);
	} catch {
		try {
			if (Date.now() - statSync(lock).mtimeMs < 60_000) return undefined;
			rmSync(lock, { recursive: true, force: true });
			mkdirSync(lock);
		} catch {
			return undefined;
		}
	}
	try {
		return fn();
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}

/**
 * A per-moment claim, so two learners never decide the same moment. A claim is only taken over when its learner is
 * gone, inside a lock, after checking again; a live learner keeps its claim (each model call has a time limit).
 */
export function claimMoment(dir: string, id: string): boolean {
	const file = claimPath(dir, id);
	// Write the token first, then publish it with a hard link, which fails if a claim exists: a claim is never empty.
	const draft = `${file}.${TOKEN}`;
	try {
		mkdirSync(join(dir, ".sitra", "learning"), { recursive: true });
		writeFileSync(draft, TOKEN);
		try {
			linkSync(draft, file);
			return true;
		} catch {
			return (
				withLock(file, () => {
					let owner: string;
					try {
						owner = readFileSync(file, "utf8");
					} catch {
						return false; // Released meanwhile; the next run picks it up.
					}
					if (owner === TOKEN || !owner || pidAlive(Number(owner.split("-")[0]))) return false;
					renameSync(draft, file);
					return true;
				}) ?? false
			);
		}
	} catch {
		return false;
	} finally {
		rmSync(draft, { force: true });
	}
}

/** Frees the claim only if it is still this process's. */
export function releaseMoment(dir: string, id: string): void {
	const file = claimPath(dir, id);
	try {
		if (readFileSync(file, "utf8") === TOKEN) rmSync(file, { force: true });
	} catch {
		// Already gone.
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// The tally on the status line, and repeats: corrections Grimoire already had a rule for.
// ---------------------------------------------------------------------------------------------------------------------

function readMoments(dir: string): Moment[] {
	if (!existsSync(momentsDir(dir))) return [];
	return readdirSync(momentsDir(dir))
		.sort()
		.flatMap((f) => {
			try {
				return [JSON.parse(readFileSync(join(momentsDir(dir), f), "utf8")) as Moment];
			} catch {
				return [];
			}
		});
}

export interface Tally {
	/** Rule pauses after which the agent changed course: mistakes stopped before they happened. */
	caught: number;
	/** Corrections that became new proposals. */
	learned: number;
	/** Corrections Grimoire already had a rule for: the rule didn't reach the agent in time. */
	repeats: number;
}

/** Today's tally (local day of `now`). */
export function tally(dir: string, now = new Date()): Tally {
	const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const today = (iso: string | undefined) => {
		const t = Date.parse(iso ?? "");
		return Number.isFinite(t) && t >= start && t <= now.getTime();
	};
	let caught = 0;
	try {
		for (const line of readFileSync(join(dir, ".sitra", "pauses.jsonl"), "utf8").split("\n")) {
			try {
				const r = JSON.parse(line) as { at?: string; outcome?: string };
				if (r.outcome === "changed" && today(r.at)) caught++;
			} catch {
				// Partial line.
			}
		}
	} catch {
		// No pauses yet.
	}
	let learned = 0;
	let repeats = 0;
	for (const m of readMoments(dir)) {
		if (m.verdict !== "correction" || !today(m.at)) continue;
		if (m.proposal) learned++;
		else if (m.skipped) repeats++;
	}
	return { caught, learned, repeats };
}

export interface Repeat {
	id: string;
	at: string;
	message: string;
	/** What the learner said already covers it. */
	covered: string;
	harness: Moment["harness"];
	cwd: string;
}

/** Repeats the person hasn't looked at yet, oldest first. */
export function repeats(dir: string): Repeat[] {
	return readMoments(dir)
		.filter((m) => m.verdict === "correction" && m.skipped && !(m as Moment & { repeatSeen?: boolean }).repeatSeen)
		.sort((a, b) => a.at.localeCompare(b.at))
		.map((m) => ({
			id: m.id,
			at: m.at,
			message: m.message,
			covered: m.skipped as string,
			harness: m.harness,
			cwd: m.cwd,
		}));
}

export function markRepeatSeen(dir: string, id: string): void {
	const m = readMoment(dir, id);
	if (m) recordMoment(dir, { ...m, repeatSeen: true } as Moment);
}
