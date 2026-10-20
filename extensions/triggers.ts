/**
 * Rules tied to actions: a Grimoire entry with `when` triggers reaches the agent at the moment it is about to do one of
 * those things (run a matching command, touch a matching file, use a matching tool), whatever the conversation says.
 * Pure: Pi's tool_call handler and the Claude Code / Codex PreToolUse hooks all go through these functions.
 */
import { basename, isAbsolute, join, matchesGlob, relative } from "node:path";
import type { Entry } from "./grimoire.ts";
import { readShell, stripWrappers } from "./shell.ts";

/** What the agent is about to do, the same shape for every tool. */
export interface Action {
	/** Normalised tool name: bash, read, edit, write, subagent, or the tool's own name in lower case. */
	tool: string;
	/** Each command the call executes, as its words (see `readShell`). */
	commands: string[][];
	/** Files the action reads or writes, as given (relative or absolute). */
	paths: string[];
}

export interface Trigger {
	type: "command" | "path" | "tool";
	value: string;
}

/** Tool names from Pi, Claude Code and Codex mapped onto one vocabulary. */
const TOOL_ALIASES: Record<string, string> = {
	bash: "bash",
	shell: "bash",
	exec_command: "bash",
	read: "read",
	edit: "edit",
	multiedit: "edit",
	notebookedit: "edit",
	apply_patch: "edit",
	write: "write",
	task: "subagent",
	agent: "subagent",
	spawn_agent: "subagent",
	subagent: "subagent",
};

const normalTool = (name: string) => TOOL_ALIASES[name.toLowerCase()] ?? name.toLowerCase();

/** Whether the command starts with these words, skipping flags (words starting with `-`) the trigger doesn't name. */
function startsWithWords(words: readonly string[], want: readonly string[]): boolean {
	let i = 0;
	for (const w of want) {
		while (i < words.length && words[i] !== w && (words[i] ?? "").startsWith("-") && !w.startsWith("-")) i++;
		if (words[i] !== w) return false;
		i++;
	}
	return true;
}

function patchPaths(patch: string): string[] {
	return [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => (m[1] ?? "").trim());
}

/** The action behind a Pi tool call: any string `command` is shell, `path` is a file. */
export function actionFromPi(toolName: string, input: Record<string, unknown>): Action {
	const command = typeof input.command === "string" ? input.command : undefined;
	const path = typeof input.path === "string" ? input.path : undefined;
	const tool = normalTool(toolName);
	const fileTool = ["read", "edit", "write"].includes(tool);
	const shell = command ? readShell(command) : { commands: [], writes: [] };
	return { tool, commands: shell.commands, paths: [...(path && fileTool ? [path] : []), ...shell.writes] };
}

/** The action behind a Claude Code or Codex PreToolUse hook (`tool_name`, `tool_input`). */
export function actionFromHook(toolName: string, toolInput: unknown): Action {
	const input = (toolInput && typeof toolInput === "object" ? toolInput : {}) as Record<string, unknown>;
	if (toolName === "apply_patch") {
		return { tool: "edit", commands: [], paths: typeof input.command === "string" ? patchPaths(input.command) : [] };
	}
	const tool = normalTool(toolName);
	const command = typeof input.command === "string" ? input.command : undefined;
	const path =
		typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : undefined;
	const shell = command ? readShell(command) : { commands: [], writes: [] };
	return { tool, commands: shell.commands, paths: [...(path ? [path] : []), ...shell.writes] };
}

/**
 * One trigger: conditions joined by `+`, all of which must hold, each `command:<words>`, `path:<glob>` or `tool:<name>`.
 * Anything else isn't a trigger.
 */
export function parseTrigger(text: string): Trigger[] | undefined {
	const parts = text.split(/\s\+\s/);
	const out: Trigger[] = [];
	for (const part of parts) {
		const m = /^\s*(command|path|tool)\s*:\s*(.+?)\s*$/i.exec(part);
		if (!m?.[1] || !m[2]) return undefined;
		const type = m[1].toLowerCase() as Trigger["type"];
		out.push({ type, value: type === "tool" ? normalTool(m[2]) : m[2] });
	}
	return out.length > 0 ? out : undefined;
}

export function triggerMatches(trigger: readonly Trigger[], action: Action, cwd: string): boolean {
	return trigger.every((t) => conditionHolds(t, action, cwd));
}

function conditionHolds(trigger: Trigger, action: Action, cwd: string): boolean {
	if (trigger.type === "tool") return action.tool === trigger.value;
	if (trigger.type === "command") {
		const want = trigger.value.split(/\s+/);
		return action.commands.some((c) => startsWithWords(stripWrappers(c), want));
	}
	const pattern = trigger.value;
	return action.paths.some((p) => {
		const abs = isAbsolute(p) ? p : join(cwd, p);
		const rel = relative(cwd, abs);
		return (
			matchesGlob(abs, pattern) ||
			(!rel.startsWith("..") && matchesGlob(rel, pattern)) ||
			(!pattern.includes("/") && matchesGlob(basename(abs), pattern))
		);
	});
}

/** Entries with a trigger matching the action, minus those already shown in this session. */
export function entriesForAction(
	entries: readonly Entry[],
	action: Action,
	cwd: string,
	shown?: ReadonlySet<string>,
): Entry[] {
	return entries.filter(
		(e) =>
			!shown?.has(e.file) &&
			(e.when ?? []).some((w) => {
				const t = parseTrigger(w);
				return t ? triggerMatches(t, action, cwd) : false;
			}),
	);
}

const PAUSE_MAX = 6_000;
const PAUSE_HEAD =
	"Paused once so these approved Grimoire rules are in front of you before this action. If the action follows them, run it again unchanged and it will go through; if not, change course.";

/**
 * Why the action was paused: each rule's title, path and as much of its body as fits in PAUSE_MAX characters. Rules
 * that don't fit at all are left out of `included`, so callers only count the ones the agent actually saw.
 */
export function pauseMessage(entries: readonly Entry[], dir: string): { text: string; included: Entry[] } {
	const header = (e: Entry) => `## [${e.kind}] ${e.title}\nFull entry: ${join(dir, e.file)}`;
	const included: Entry[] = [];
	let used = PAUSE_HEAD.length;
	for (const e of entries) {
		const size = header(e).length + 2;
		if (used + size > PAUSE_MAX) break;
		included.push(e);
		used += size;
	}
	const share = included.length ? Math.floor((PAUSE_MAX - used) / included.length) - 2 : 0;
	const parts = included.map((e) => {
		const room = Math.max(0, share);
		const body =
			e.body.length <= room
				? e.body
				: room > 40
					? `${e.body.slice(0, room - 25).trimEnd()}… (read the full entry)`
					: "";
		return `## [${e.kind}] ${e.title}\n${body ? `${body}\n` : ""}Full entry: ${join(dir, e.file)}`;
	});
	return { text: `${PAUSE_HEAD}\n\n${parts.join("\n\n")}`, included };
}

/** One replayed moment: the calls an agent made before someone had to correct it, and the entries that would have helped. */
export interface TriggerCase {
	id: string;
	harness: "pi" | "claude" | "codex";
	cwd: string;
	calls: { tool: string; input: Record<string, unknown> }[];
	expect: string[];
}

export interface TriggerReport {
	cases: number;
	/** Cases whose expected entries have at least one trigger at all. */
	coverable: number;
	/** An expected entry would have paused one of the calls. */
	caught: { id: string; fired: string[] }[];
	/** Something paused, but none of the expected entries. */
	wrongOnly: { id: string; fired: string[] }[];
	/** Calls that would have been paused (one per call, however many rules it brought up). */
	pauses: number;
	/** Rules shown across all cases. */
	delivered: number;
	summary: string;
}

/** Replays each case's calls through the triggers, pausing each entry at most once, as a live session would. */
export function evaluateTriggers(entries: readonly Entry[], cases: readonly TriggerCase[]): TriggerReport {
	const tied = entries.filter((e) => e.when?.length);
	const tiedFiles = new Set(tied.map((e) => e.file));
	const caught: TriggerReport["caught"] = [];
	const wrongOnly: TriggerReport["wrongOnly"] = [];
	let pauses = 0;
	let delivered = 0;
	for (const c of cases) {
		const shown = new Set<string>();
		for (const call of c.calls) {
			const action = c.harness === "pi" ? actionFromPi(call.tool, call.input) : actionFromHook(call.tool, call.input);
			const { included } = pauseMessage(entriesForAction(tied, action, c.cwd, shown), "");
			if (included.length > 0) pauses++;
			for (const e of included) shown.add(e.file);
		}
		delivered += shown.size;
		const fired = [...shown];
		if (fired.some((f) => c.expect.includes(f))) caught.push({ id: c.id, fired });
		else if (fired.length > 0) wrongOnly.push({ id: c.id, fired });
	}
	const coverable = cases.filter((c) => c.expect.some((f) => tiedFiles.has(f))).length;
	return {
		cases: cases.length,
		coverable,
		caught,
		wrongOnly,
		pauses,
		delivered,
		summary: `Caught ${caught.length} of ${cases.length} corrections (${coverable} have an expected entry with triggers). ${wrongOnly.length} cases paused only on other rules; ${pauses} pauses showing ${delivered} rules in total.`,
	};
}
