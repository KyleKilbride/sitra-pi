/**
 * `sitra grimoire …`: puts Grimoire in front of Claude Code and Codex agents too, and moves old `/kb` folders in.
 * Claude Code loads the root through `@` imports in `~/.claude/CLAUDE.md` (hook text is capped at 10,000 characters,
 * imports aren't) and the catalogue through a SessionStart hook. Codex loads both through a SessionStart hook with a
 * raised `additionalContextLimit`. With projects in use, the import is the global part (the same for every project)
 * and Claude Code's session hook adds the project's; the project is found once per session, from the folder it
 * started in. Pure functions here; files and processes are passed in.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	catalogueOverflowFile,
	type Entry,
	grimoireDir,
	grimoireSection,
	importKnowledge,
	LIMITS,
	linkReport,
	listEntries,
	listProposals,
	loadRoot,
	projectCatalogue,
	type RootText,
	scopeLabel,
	searchEntries,
	setScope,
} from "../extensions/grimoire.ts";
import {
	captureMoment,
	casesFromMoments,
	claimMoment,
	learnFromMoment,
	learningOn,
	pauseOutcomes,
	recordPause,
	recordPauseFollowUp,
	releaseMoment,
	undecidedMoments,
} from "../extensions/learn.ts";
import {
	normalizeRemote,
	PROJECTS_FILE,
	type Project,
	type ProjectRegistry,
	projectFor,
	projectIdOf,
	projectsOn,
	proposalScope,
	readProjects,
	refreshClaudeRoot,
	type SessionProject,
	sectionScopeOf,
	sessionProject,
	visibleEntries,
	writeProjects,
} from "../extensions/project.ts";
import { shellQuote } from "../extensions/runs.ts";
import { gitCheckout, mainCheckout, readLastLines } from "../extensions/sessions.ts";
import {
	actionFromHook,
	entriesForAction,
	evaluateTriggers,
	pauseMessage,
	type TriggerCase,
} from "../extensions/triggers.ts";

/** Claude Code saves hook text over 10,000 characters to a file and shows only a preview; stay under it. */
export const CLAUDE_CONTEXT_MAX = 9_500;
/** The most the Codex hook sends: a full root (32,000 characters), the catalogue (12,000) and the text around them. */
export const CODEX_CONTEXT_CHARS = 46_000;
/** Codex's limit is in tokens; at a conservative 2 characters per token, the whole text always fits. */
export const CODEX_CONTEXT_TOKENS = CODEX_CONTEXT_CHARS / 2;
/** The SessionStart sources sitra's session hook runs on: Claude Code has four, Codex also starts sessions on fork. */
export const CLAUDE_SESSION_MATCHER = "startup|resume|clear|compact";
export const CODEX_SESSION_MATCHER = `${CLAUDE_SESSION_MATCHER}|fork`;
const SESSION_MATCHER = { claude: CLAUDE_SESSION_MATCHER, codex: CODEX_SESSION_MATCHER };
/** sitra's own hook command: the quoted sitra executable, then `grimoire hook <tool>`. Nothing else matches. */
const OURS = /^'[^']*\/bin\/sitra\.ts' grimoire hook (claude|codex)( |$)/;
const BLOCK_START = "<!-- sitra grimoire: start (managed by `sitra grimoire install`) -->";
const BLOCK_END = "<!-- sitra grimoire: end -->";

export interface HooksCheck {
	installed: boolean;
	status: string;
	events: { SessionStart: boolean; UserPromptSubmit: boolean; PreToolUse: boolean };
	/** SessionStart sources sitra's session hook doesn't run on. */
	missing: string[];
}

/**
 * Whether a Claude Code settings.json or Codex hooks.json has sitra's three hooks, and which SessionStart sources its
 * session hook misses (an older or hand-edited install). Matchers are compared as sets of `|`-separated sources; a
 * group with no matcher, `""` or `"*"` runs on every source.
 */
export function checkHooksFile(filePath: string, tool: "claude" | "codex"): HooksCheck {
	const empty: HooksCheck = {
		installed: false,
		status: "not installed",
		events: { SessionStart: false, UserPromptSubmit: false, PreToolUse: false },
		missing: [],
	};
	if (!existsSync(filePath)) return empty;
	try {
		const raw = JSON.parse(readFileSync(filePath, "utf8")) as HooksFile;
		const hooks = raw?.hooks ?? {};
		const ours = (name: string) =>
			Array.isArray(hooks[name])
				? hooks[name].filter((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => isOurs(h)))
				: [];
		const events = {
			SessionStart: ours("SessionStart").length > 0,
			UserPromptSubmit: ours("UserPromptSubmit").length > 0,
			PreToolUse: ours("PreToolUse").length > 0,
		};
		const installed = events.SessionStart && events.UserPromptSubmit && events.PreToolUse;
		const matchers = ours("SessionStart").map((g) => g.matcher ?? "");
		const covered = new Set(matchers.flatMap((m) => m.split("|")));
		const everything = matchers.some((m) => m === "" || m === "*");
		const missing =
			events.SessionStart && !everything ? SESSION_MATCHER[tool].split("|").filter((s) => !covered.has(s)) : [];
		const status = !installed
			? "not installed"
			: missing.length > 0
				? `installed (session hook misses: ${missing.join(", ")}; run sitra grimoire install)`
				: "installed";
		return { installed, status, events, missing };
	} catch {
		return empty;
	}
}

/**
 * Whether sitra's Grimoire hooks are installed for a tool in this home: its hooks file, and for Claude Code also the
 * CLAUDE.md block that imports the root. `/grimoire-ui` and `sitra grimoire status` both report this.
 */
export function hooksStatus(
	home: string,
	tool: "claude" | "codex",
): HooksCheck & { path: string; claudeMd?: { path: string; imported: boolean } } {
	if (tool === "codex") {
		const path = join(home, ".codex", "hooks.json");
		return { ...checkHooksFile(path, "codex"), path };
	}
	const path = join(home, ".claude", "settings.json");
	const md = join(home, ".claude", "CLAUDE.md");
	const imported = existsSync(md) && readFileSync(md, "utf8").includes(BLOCK_START);
	const check = checkHooksFile(path, "claude");
	return {
		...check,
		installed: check.installed && imported,
		status: imported ? check.status : "not installed",
		path,
		claudeMd: { path: md, imported },
	};
}

const NO_CWD = "the hook's input had no cwd, so project entries weren't loaded";

/**
 * The project of a Claude Code or Codex session, found once from the folder it started in and kept in its
 * `sessionShown` folder, so later hook calls skip git and a `cd` mid-session doesn't switch it. With no projects in
 * use nothing is written. Without a session id it is found from `cwd` on every call.
 */
export function hookProject(dir: string, sessionId: string | undefined, cwd: string | undefined): SessionProject {
	const cache = sessionId === undefined ? undefined : join(shownFolder(dir, sessionId), "project.json");
	if (cache && existsSync(cache)) {
		try {
			return JSON.parse(readFileSync(cache, "utf8")) as SessionProject;
		} catch {
			// A damaged note is found again below.
		}
	}
	const { project } = sessionProject(
		cwd ?? "",
		dir,
		cwd
			? projectFor
			: () => {
					throw new Error(NO_CWD);
				},
	);
	if (cache && sessionId !== undefined && project.state !== "off") {
		try {
			sessionShown(dir, sessionId);
			const temp = `${cache}.${process.pid}.tmp`;
			writeFileSync(temp, JSON.stringify(project));
			renameSync(temp, cache);
		} catch {
			// Without the note, the next call finds the project again.
		}
	}
	return project;
}

/** The session id and folder from a hook's JSON input; anything missing or odd is left out. */
function hookInput(payload: string): { sessionId?: string; cwd?: string } {
	try {
		const input: unknown = JSON.parse(payload);
		if (!input || typeof input !== "object") return {};
		const { session_id, cwd } = input as Record<string, unknown>;
		return {
			...(session_id !== undefined && session_id !== null ? { sessionId: String(session_id) } : {}),
			...(typeof cwd === "string" && cwd ? { cwd } : {}),
		};
	} catch {
		return {};
	}
}

const shellSearch = (dir: string, flag: string) =>
	`\`sitra grimoire search --dir ${shellQuote(dir)}${flag} "<words>"\``;

/**
 * The SessionStart hook's answer for each tool, as the JSON both tools read from stdout. With projects in use, Codex
 * gets the global and project root and the catalogue of both; Claude Code, whose import already carries the global
 * part, gets the project's root and a `projectCatalogue` that fits what is left of its limit. With no project, both
 * say why.
 */
export function hookOutput(
	tool: "claude" | "codex",
	dir: string,
	who?: string,
	project: SessionProject = { state: "off" },
): string {
	const all = existsSync(dir) ? listEntries(dir) : [];
	const id = projectIdOf(project);
	const entries = visibleEntries(all, id, project.state !== "off");
	let text: string;
	const base = { shell: true, ...(who ? { who } : {}), scope: sectionScopeOf(project) };
	if (tool === "codex") {
		const frame = grimoireSection(dir, undefined, entries, base).length + 300;
		text = grimoireSection(
			dir,
			loadRoot(dir, id, Math.min(LIMITS.rootChars, CODEX_CONTEXT_CHARS - frame)),
			entries,
			base,
		);
	} else if (project.state === "off") {
		const frame = grimoireSection(dir, undefined, [], base).length + 200;
		text = grimoireSection(dir, undefined, entries, {
			...base,
			catalogueChars: Math.max(500, CLAUDE_CONTEXT_MAX - frame),
		});
	} else {
		const own = entries.filter((e) => e.scope);
		const loaded = id === undefined ? undefined : loadRoot(dir, id);
		const empty = { text: "", files: [], chars: 0, truncated: false };
		const root = loaded && { ...loaded, global: empty, text: loaded.project.text };
		const options = { ...base, globalIn: join(dir, ".sitra", "root.md") };
		const frame = grimoireSection(dir, root, own, { ...options, catalogueText: "" }).length + 100;
		const listed =
			project.state === "matched" && own.length > 0
				? projectCatalogue(
						own,
						Math.max(500, CLAUDE_CONTEXT_MAX - frame),
						catalogueOverflowFile(dir, project.project.id),
						{
							label: project.project.label,
							search: shellSearch(dir, ` --project ${project.project.id}`),
						},
					)
				: undefined;
		text = grimoireSection(dir, root, own, { ...options, catalogueText: listed?.text ?? "" });
	}
	return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } });
}

interface HookHandler {
	type: string;
	command?: string;
	[key: string]: unknown;
}
interface MatcherGroup {
	matcher?: string;
	hooks: HookHandler[];
}
export interface HooksFile {
	hooks?: Record<string, MatcherGroup[]>;
	[key: string]: unknown;
}

const isOurs = (h: HookHandler) => typeof h.command === "string" && OURS.test(h.command);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Refuses anything that isn't a settings object with lists of hook groups, so a strange file is never rewritten. */
function checkSettings(settings: unknown): asserts settings is HooksFile {
	const ok =
		isObject(settings) &&
		(settings.hooks === undefined ||
			(isObject(settings.hooks) &&
				Object.values(settings.hooks).every(
					(groups) => Array.isArray(groups) && groups.every((g) => isObject(g) && Array.isArray(g.hooks)),
				)));
	if (!ok) throw new Error("The hooks file is not a settings object with lists of hook groups; leaving it alone.");
}

/** The settings with sitra's hook handlers taken out, leaving everything else as it was. */
export function hooksWithoutGrimoire<T extends HooksFile>(settings: T): T & { hooks: Record<string, MatcherGroup[]> } {
	checkSettings(settings);
	const hooks: Record<string, MatcherGroup[]> = {};
	for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
		const kept = groups
			.map((g) => ({ ...g, hooks: g.hooks.filter((h) => !isOurs(h)) }))
			.filter((g, i) => g.hooks.length > 0 || (groups[i]?.hooks.length ?? 0) === 0);
		if (kept.length > 0) hooks[event] = kept;
	}
	return { ...settings, hooks };
}

/** The settings with exactly one sitra SessionStart hook (Claude Code's settings.json and Codex's hooks.json share this shape). */
export interface GrimoireHooks {
	/** The SessionStart command (root and catalogue). */
	session: string;
	/** The UserPromptSubmit command (records the moment for learning). */
	prompt?: string;
	/** The PreToolUse command (rules tied to actions), and which tools it watches. */
	tool?: string;
	toolMatcher?: string;
	/** The SessionStart sources, `|`-separated; Claude Code's four by default. */
	sessionMatcher?: string;
	additionalContextLimit?: number;
}

/**
 * The settings with exactly one sitra SessionStart hook and, when given, one sitra PreToolUse hook (Claude Code's
 * settings.json and Codex's hooks.json share this shape).
 */
export function hooksWithGrimoire<T extends HooksFile>(
	settings: T,
	ours: GrimoireHooks,
): T & { hooks: Record<string, MatcherGroup[]> } {
	const clean = hooksWithoutGrimoire(settings);
	const session: HookHandler = {
		type: "command",
		command: ours.session,
		timeout: 10,
		...(ours.additionalContextLimit ? { additionalContextLimit: ours.additionalContextLimit } : {}),
	};
	const hooks: Record<string, MatcherGroup[]> = {
		...clean.hooks,
		SessionStart: [
			...(clean.hooks.SessionStart ?? []),
			{ matcher: ours.sessionMatcher ?? CLAUDE_SESSION_MATCHER, hooks: [session] },
		],
	};
	if (ours.prompt) {
		hooks.UserPromptSubmit = [
			...(clean.hooks.UserPromptSubmit ?? []),
			{ hooks: [{ type: "command", command: ours.prompt, timeout: 10 }] },
		];
	}
	if (ours.tool) {
		const group: MatcherGroup = { hooks: [{ type: "command", command: ours.tool, timeout: 10 }] };
		if (ours.toolMatcher) group.matcher = ours.toolMatcher;
		hooks.PreToolUse = [...(clean.hooks.PreToolUse ?? []), group];
	}
	return { ...clean, hooks };
}

/** Tools whose calls the PreToolUse hook checks: shell, file edits and reads, and helpers. */
export const CLAUDE_TOOL_MATCHER = "Bash|Read|Edit|MultiEdit|Write|NotebookEdit|Task|Agent";
export const CODEX_TOOL_MATCHER = "Bash|apply_patch|spawn_agent";

function shownFolder(dir: string, sessionId: string): string {
	return join(dir, ".sitra", "shown", sessionId.replace(/[^\w.-]/g, "_").slice(0, 120) || "unknown");
}

/**
 * What a Claude Code or Codex session has already been shown, under `<grimoire>/.sitra/shown/<session>/`: one file per
 * rule, created atomically, so hook processes running in parallel never lose each other's notes. Every call touches
 * the session's folder; folders untouched for three days belong to finished sessions and are removed.
 */
export function sessionShown(dir: string, sessionId: string) {
	const root = join(dir, ".sitra", "shown");
	const folder = shownFolder(dir, sessionId);
	mkdirSync(folder, { recursive: true });
	const now = new Date();
	utimesSync(folder, now, now);
	const mark = (file: string) => join(folder, createHash("sha1").update(file).digest("hex").slice(0, 16));
	return {
		has: (file: string) => existsSync(mark(file)),
		/** True when this call is the one that recorded it. */
		claim(file: string): boolean {
			try {
				closeSync(openSync(mark(file), "wx"));
				return true;
			} catch {
				return false;
			}
		},
		cleanUp() {
			const cutoff = Date.now() - 3 * 86_400_000;
			for (const f of readdirSync(root)) {
				try {
					if (statSync(join(root, f)).mtimeMs < cutoff) rmSync(join(root, f), { recursive: true, force: true });
				} catch {
					// Another hook got there first.
				}
			}
		},
	};
}

/**
 * The PreToolUse hook's answer: a deny carrying the matching rules the first time an action needs them in this
 * session, otherwise "" (no opinion). Anything unexpected, from an odd payload to an unreadable folder, is "".
 */
export function toolHookOutput(dir: string, payload: string): string {
	try {
		const input: unknown = JSON.parse(payload);
		if (!input || typeof input !== "object") return "";
		const { session_id, cwd, tool_name, tool_input, turn_id } = input as Record<string, unknown>;
		if (typeof tool_name !== "string" || !existsSync(dir)) return "";
		const tied = listEntries(dir).filter((e) => e.when?.length);
		if (tied.length === 0) return "";
		const here = hookInput(payload);
		const project = hookProject(dir, here.sessionId, here.cwd);
		const entries = visibleEntries(tied, projectIdOf(project), project.state !== "off");
		if (entries.length === 0) return "";
		const sessionId = String(session_id ?? "unknown");
		const when = typeof turn_id === "string" ? { turn: turn_id } : {};
		const call = {
			tool: tool_name,
			input: tool_input && typeof tool_input === "object" ? (tool_input as Record<string, unknown>) : {},
		};
		try {
			recordPauseFollowUp(dir, sessionId, call, when);
		} catch {
			// Measuring never gets in the way of a rule.
		}
		const session = sessionShown(dir, sessionId);
		const action = actionFromHook(tool_name, tool_input);
		const fresh = entriesForAction(entries, action, typeof cwd === "string" ? cwd : process.cwd()).filter(
			(e) => !session.has(e.file),
		);
		if (fresh.length === 0) return "";
		const claimed = pauseMessage(fresh, dir).included.filter((e) => session.claim(e.file));
		session.cleanUp();
		if (claimed.length === 0) return "";
		try {
			recordPause(
				dir,
				sessionId,
				claimed.map((e) => e.file),
				call,
				{ ...when, cwd: typeof cwd === "string" ? cwd : process.cwd() },
			);
		} catch {
			// Measuring never gets in the way of a rule.
		}
		return JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: pauseMessage(claimed, dir).text,
			},
		});
	} catch {
		return "";
	}
}

/**
 * CLAUDE.md with one sitra-managed block importing the root file, kept where it is; with no file, the block is removed.
 * With `projects` (projects in use), the block says the import is the global part and the session hook adds the rest.
 */
export function claudeMdWithGrimoire(text: string, rootFile: string | undefined, projects = false): string {
	const block = rootFile
		? [
				BLOCK_START,
				projects
					? "Grimoire global root and global entries; project entries come from the session hook."
					: "Grimoire root: the approved, always-loaded knowledge for every agent.",
				`@${rootFile.replaceAll(" ", "\\ ")}`,
				BLOCK_END,
			].join("\n")
		: "";
	const start = text.indexOf(BLOCK_START);
	const end = text.indexOf(BLOCK_END);
	if (start !== -1 && end > start) {
		const before = text.slice(0, start);
		const after = text.slice(end + BLOCK_END.length);
		if (block) return `${before}${block}${after}`;
		return `${before.replace(/\n+$/, "\n")}${after.replace(/^\n+/, before.trim() ? "\n" : "")}`;
	}
	if (!block) return text;
	return `${text}${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}${block}\n`;
}

export interface CliDeps {
	home: string;
	env: Record<string, string | undefined>;
	/** This repo's root, for the hook command. */
	repoRoot: string;
	cwd: string;
	readStdin(): string;
	log(line: string): void;
	/** Asks a model (system, user) for the learner; defaults to a non-interactive `pi -p` run. */
	ask?(system: string, user: string): Promise<string>;
}

/** The model the learner asks: `SITRA_LEARN_MODEL`, else Gemini 4 Argon (best on labelled corrections, see docs). */
export const DEFAULT_LEARN_MODEL = "google/gemini-4-argon";

/** One non-interactive Pi call with no extensions, tools or session: input closed, two-minute limit. */
function askPi(env: Record<string, string | undefined>): (system: string, user: string) => Promise<string> {
	const model = env.SITRA_LEARN_MODEL?.trim() || DEFAULT_LEARN_MODEL;
	return (system, user) =>
		new Promise((resolve, reject) => {
			const child = spawn(
				"pi",
				[
					"-p",
					"--no-session",
					"--no-extensions",
					"--no-skills",
					"--no-context-files",
					"--no-tools",
					"--no-mcp",
					"--no-prompt-templates",
					"--model",
					model,
					"--system-prompt",
					system,
					user,
				],
				{ env: { ...env, SITRA_LEARNING: "1" }, stdio: ["ignore", "pipe", "ignore"], timeout: 120_000 },
			);
			let out = "";
			child.stdout.on("data", (d) => {
				out += d;
			});
			child.on("error", reject);
			child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`pi exited ${code}`))));
		});
}

/** Decides undecided moments, oldest first, until `limit` have been claimed; claims keep parallel learners apart. */
export async function learnAll(
	dir: string,
	ask: (s: string, u: string) => Promise<string>,
	log: (l: string) => void,
	limit = 10,
): Promise<void> {
	let done = 0;
	for (const id of undecidedMoments(dir)) {
		if (done >= limit) break;
		if (!claimMoment(dir, id)) continue;
		done++;
		try {
			const r = await learnFromMoment(dir, id, ask);
			log(
				`${id}: ${r.verdict}${r.proposal ? ` → ${r.proposal}` : ""}${r.skipped ? ` (skipped: ${r.skipped})` : ""}${r.error ? ` (${r.error})` : ""}`,
			);
		} finally {
			releaseMoment(dir, id);
		}
	}
}

/** The UserPromptSubmit hook: record the moment and hand it to the learner. Silent, and never in the way. */
function promptHook(
	dir: string,
	tool: "claude" | "codex",
	payload: string,
	env: Record<string, string | undefined>,
): void {
	try {
		const input: unknown = JSON.parse(payload);
		if (!input || typeof input !== "object") return;
		const { prompt, transcript_path, cwd } = input as Record<string, unknown>;
		if (typeof prompt !== "string" || !learningOn(env)) return;
		const transcript =
			typeof transcript_path === "string" && existsSync(transcript_path)
				? readLastLines(transcript_path, 400, { maxBytes: 1_000_000 })
				: "";
		const here = hookInput(payload);
		captureMoment(dir, env, {
			harness: tool,
			cwd: typeof cwd === "string" ? cwd : "",
			message: prompt,
			transcript,
			placement: proposalScope(hookProject(dir, here.sessionId, here.cwd)),
		});
	} catch {
		// Never block the person's message.
	}
}

function readJson(file: string): HooksFile {
	if (!existsSync(file)) return {};
	const raw = readFileSync(file, "utf8").trim();
	const parsed: unknown = raw ? JSON.parse(raw) : {};
	checkSettings(parsed);
	return parsed;
}

function writeJson(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);

/** Adds (or removes) Grimoire in Claude Code and Codex, for whichever of them is set up on this machine. */
export function installGrimoireHooks(
	deps: { home: string; repoRoot: string; log(line: string): void },
	dir: string,
	remove = false,
): void {
	const where = real(dir);
	const hook = (tool: string, kind?: "tool" | "prompt") =>
		`${shellQuote(join(deps.repoRoot, "bin", "sitra.ts"))} grimoire hook ${tool}${kind ? ` ${kind}` : ""} --dir ${shellQuote(where)}`;
	const claudeDir = join(deps.home, ".claude");
	const codexDir = join(deps.home, ".codex");
	let touched = false;
	if (existsSync(claudeDir)) {
		const settings = join(claudeDir, "settings.json");
		const current = readJson(settings);
		const md = join(claudeDir, "CLAUDE.md");
		const before = existsSync(md) ? readFileSync(md, "utf8") : "";
		const after = claudeMdWithGrimoire(before, remove ? undefined : refreshClaudeRoot(where), projectsOn(where));
		writeJson(
			settings,
			remove
				? hooksWithoutGrimoire(current)
				: hooksWithGrimoire(current, {
						session: hook("claude"),
						prompt: hook("claude", "prompt"),
						tool: hook("claude", "tool"),
						toolMatcher: CLAUDE_TOOL_MATCHER,
					}),
		);
		if (after !== before) writeFileSync(md, after);
		deps.log(`${remove ? "Removed Grimoire from" : "Claude Code loads Grimoire:"} ${settings} and ${md}`);
		touched = true;
	}
	if (existsSync(codexDir)) {
		const hooks = join(codexDir, "hooks.json");
		const current = readJson(hooks);
		writeJson(
			hooks,
			remove
				? hooksWithoutGrimoire(current)
				: hooksWithGrimoire(current, {
						session: hook("codex"),
						prompt: hook("codex", "prompt"),
						tool: hook("codex", "tool"),
						toolMatcher: CODEX_TOOL_MATCHER,
						sessionMatcher: CODEX_SESSION_MATCHER,
						additionalContextLimit: CODEX_CONTEXT_TOKENS,
					}),
		);
		deps.log(
			remove
				? `Removed Grimoire from ${hooks}`
				: `Codex loads Grimoire: ${hooks}. Codex asks you to trust new hooks once: open /hooks in Codex.`,
		);
		touched = true;
	}
	if (!touched) deps.log("Neither Claude Code (~/.claude) nor Codex (~/.codex) is set up here; nothing to do.");
}

/** A command's arguments: `valued` flags take the next argument (and may repeat), `switches` stand alone. */
function readFlags(
	args: readonly string[],
	valued: readonly string[],
	switches: readonly string[],
): { positional: string[]; values: Record<string, string[]>; on: Set<string>; error?: string } {
	const positional: string[] = [];
	const values: Record<string, string[]> = {};
	const on = new Set<string>();
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		if (valued.includes(arg)) {
			const value = args[i + 1];
			if (value === undefined || value.startsWith("--"))
				return { positional, values, on, error: `${arg} needs a value` };
			values[arg] = [...(values[arg] ?? []), value];
			i++;
		} else if (switches.includes(arg)) on.add(arg);
		else positional.push(arg);
	}
	return { positional, values, on };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The registered projects with these ids, or why not: no registry, an unreadable one, or an unknown id. */
function registeredProjects(dir: string, ids: readonly string[]): { projects: Project[] } | { error: string } {
	let registry: ProjectRegistry;
	try {
		registry = readProjects(dir);
	} catch (error) {
		return { error: errorText(error) };
	}
	if (registry.projects.length === 0)
		return {
			error: `No projects in ${join(dir, PROJECTS_FILE)}. Add one: sitra grimoire projects add <id> --remote <url>`,
		};
	const unknown = ids.filter((id) => !registry.projects.some((p) => p.id === id));
	if (unknown.length > 0)
		return {
			error: `No project ${unknown.map((id) => JSON.stringify(id)).join(", ")}; the projects are ${registry.projects.map((p) => p.id).join(", ")}.`,
		};
	return { projects: ids.flatMap((id) => registry.projects.filter((p) => p.id === id)) };
}

/** The line saying which project a command used, and why; nothing with projects off. */
function describeProject(project: SessionProject): string | undefined {
	if (project.state === "off") return undefined;
	if (project.state === "global") return `No project here (${project.why}): global entries only.`;
	const { id, label } = project.project;
	const from =
		project.via === "--project"
			? "chosen with --project"
			: project.via === "path"
				? "from its folder, listed in projects.json"
				: `from remote ${project.via}`;
	return [`Project: ${label} (${id}), ${from}.`, ...project.warnings.map((w) => `Warning: ${w}`)].join("\n");
}

/** Which entries a command works on: every project's (`--all`), or one session's view. */
type View = { all: true } | { all?: false; project: SessionProject; line?: string };

/** `--project <id>`, `--global-only` or `--all`; with none, the project of the folder the command runs in. */
function chooseView(dir: string, cwd: string, flags: ReturnType<typeof readFlags>): View | { error: string } {
	const wanted = flags.values["--project"] ?? [];
	const picked = [
		...(wanted.length > 0 ? ["--project"] : []),
		...(flags.on.has("--all") ? ["--all"] : []),
		...(flags.on.has("--global-only") ? ["--global-only"] : []),
	];
	if (picked.length > 1) return { error: `Use one of ${picked.join(", ")}, not several.` };
	if (wanted.length > 1) return { error: "Give one --project." };
	if (flags.on.has("--all")) return { all: true };
	if (flags.on.has("--global-only"))
		return { project: { state: "global", why: "--global-only" }, line: "Global entries only (--global-only)." };
	if (wanted.length === 1) {
		const found = registeredProjects(dir, wanted);
		if ("error" in found) return found;
		const [chosen] = found.projects;
		if (!chosen) return { error: `No project ${wanted[0]}.` };
		const project: SessionProject = { state: "matched", project: chosen, via: "--project", warnings: [] };
		return { project, line: describeProject(project) };
	}
	const { project } = sessionProject(cwd, dir);
	return { project, line: describeProject(project) };
}

function viewEntries(view: View, entries: readonly Entry[]): Entry[] {
	return view.all ? [...entries] : visibleEntries(entries, projectIdOf(view.project), view.project.state !== "off");
}

function printStatus(dir: string, view: View, deps: CliDeps): void {
	const entries = listEntries(dir);
	const proposals = listProposals(dir);
	const learned = proposals.filter((p) => p.proposedBy === "sitra-learn").length;
	const waiting = `waiting for review: ${proposals.length}${learned ? ` (${learned} learned from corrections)` : ""}`;
	const over = (r: RootText, limit: number) =>
		r.truncated ? ` (over the ${limit} limit; agents see the first part)` : "";
	deps.log(`Grimoire: ${dir}`);
	if (!view.all && view.project.state === "off") {
		const root = loadRoot(dir);
		deps.log(`  root: ${root.files.length} files, ${root.chars} characters${over(root, LIMITS.rootChars)}`);
		deps.log(`  approved: ${entries.length}, ${waiting}`);
	} else if (view.all) {
		deps.log("All projects (--all).");
		let ids: string[] = [];
		try {
			ids = readProjects(dir).projects.map((p) => p.id);
		} catch (error) {
			deps.log(`  ${errorText(error)}`);
		}
		for (const e of entries) for (const id of e.scope ?? []) if (!ids.includes(id)) ids.push(id);
		const global = entries.filter((e) => !e.scope).length;
		const roots = ids.map((id) => `${id} ${loadRoot(dir, id).project.files.length}`);
		deps.log(`  root files: ${[`${loadRoot(dir).global.files.length} global`, ...roots].join(", ")}`);
		const counts = ids.map((id) => `${id} ${entries.filter((e) => e.scope?.includes(id)).length}`);
		deps.log(`  approved: ${entries.length} (${[`${global} global`, ...counts].join(", ")}), ${waiting}`);
	} else {
		if (view.line) deps.log(view.line);
		const id = projectIdOf(view.project);
		const label = view.project.state === "matched" ? view.project.project.label : undefined;
		const root = loadRoot(dir, id);
		const parts = [
			`global ${root.global.files.length} files, ${root.global.chars} characters${over(root.global, id ? LIMITS.globalRootChars : LIMITS.rootChars)}`,
			...(label
				? [
						`${label} ${root.project.files.length} files, ${root.project.chars} characters${over(root.project, LIMITS.projectRootChars)}`,
					]
				: []),
		];
		deps.log(`  root: ${parts.join("; ")}`);
		for (const p of root.problems) deps.log(`  root file ${p.file} can't be read: ${p.problem}`);
		const visible = viewEntries(view, entries);
		const global = visible.filter((e) => !e.scope).length;
		deps.log(
			`  approved: ${label ? `${global} global + ${visible.length - global} for ${label}` : `${global} global`}, ${waiting}`,
		);
		const links = linkReport(dir, id);
		if (links.length > 0) {
			deps.log(
				`  links ${label ? `${label} sessions` : "sessions with no project"} won't follow (links never load their target):`,
			);
			for (const l of links) deps.log(`    ${l.from} → ${l.target}: ${l.problem}`);
		}
	}
	const cases = casesFromMoments(dir);
	if (cases.length > 0) deps.log(`  corrections recorded: ${cases.length} (sitra grimoire eval replays them)`);
	const outcomes = pauseOutcomes(dir);
	if (outcomes.length > 0) {
		deps.log("  rules tied to actions (paused → agent changed course / repeated the call):");
		for (const o of outcomes) deps.log(`    ${o.pauses} → ${o.changed} / ${o.repeated}  ${o.file}`);
	}
	for (const tool of ["claude", "codex"] as const) {
		if (!existsSync(join(deps.home, tool === "claude" ? ".claude" : ".codex"))) continue;
		deps.log(`  ${tool === "claude" ? "Claude Code" : "Codex"} hooks: ${hooksStatus(deps.home, tool).status}`);
	}
}

const USAGE =
	"Usage: sitra grimoire [status | search <words> | eval [cases.jsonl] | learn | install | uninstall | import [repo] | scope <file>... (--project <id>... | --global) | projects [list | add <id> (--remote <url> | --path <dir>)... [--label <name>]] | hook claude|codex [tool|prompt]]\n  status, search and eval take --project <id>, --global-only or --all; without one they use the project of the current folder.";

/** Runs `sitra grimoire <command>`. Returns the exit code. */
export function runGrimoireCli(args: readonly string[], deps: CliDeps): number | Promise<number> {
	const at = args.indexOf("--dir");
	const given = at === -1 ? undefined : args[at + 1];
	const [command, ...rest] = at === -1 ? args : [...args.slice(0, at), ...args.slice(at + 2)];
	const dir = given ?? grimoireDir(deps.env, deps.home);
	const who = deps.env.SITRA_USER_NAME?.trim() || undefined;
	switch (command) {
		case "hook": {
			const tool = rest[0] === "codex" ? "codex" : "claude";
			let payload = "";
			try {
				payload = deps.readStdin();
			} catch {
				// The tool hook without input has nothing to check; the session hook then has no folder to find a project from.
			}
			if (rest[1] === "tool") {
				const out = toolHookOutput(dir, payload);
				if (out) deps.log(out);
				return 0;
			}
			if (rest[1] === "prompt") {
				promptHook(dir, tool, payload, deps.env);
				return 0;
			}
			const here = hookInput(payload);
			const project = hookProject(dir, here.sessionId, here.cwd);
			if (tool === "claude" && existsSync(dir)) refreshClaudeRoot(dir);
			deps.log(hookOutput(tool, dir, who, project));
			return 0;
		}
		case "learn":
			return learnAll(dir, deps.ask ?? askPi(deps.env), deps.log).then(() => 0);
		case "eval": {
			const flags = readFlags(rest, ["--project"], ["--all", "--global-only"]);
			const file = flags.positional[0];
			if (flags.error || flags.positional.length > 1 || (file && !existsSync(file))) {
				deps.log(
					"Usage: sitra grimoire eval [cases.jsonl] [--project <id> | --global-only | --all]  (default: the corrections Grimoire has recorded)",
				);
				return 1;
			}
			const view = chooseView(dir, deps.cwd, flags);
			if ("error" in view) {
				deps.log(view.error);
				return 1;
			}
			const cases = file
				? readFileSync(file, "utf8")
						.split("\n")
						.filter((l) => l.trim())
						.map((l) => JSON.parse(l) as TriggerCase)
				: casesFromMoments(dir);
			const inUse = projectsOn(dir);
			const chosen = flags.positional.length + flags.on.size + (flags.values["--project"]?.length ?? 0) > 1;
			let selected = cases;
			if (view.all) deps.log("All projects (--all): every case, each against global rules and its own project's.");
			else if (view.project.state !== "off" && file && !chosen) {
				deps.log(`Every case in ${file}, each against global rules and its own project's.`);
			} else if (view.project.state !== "off") {
				const id = projectIdOf(view.project);
				selected = cases.filter((c) => c.project === id);
				if (view.line) deps.log(view.line);
				deps.log(
					`Replaying the ${selected.length} of ${cases.length} cases recorded ${view.project.state === "matched" ? `in ${view.project.project.label}` : "with no project"} (--all replays every case).`,
				);
			}
			const report = evaluateTriggers(listEntries(dir), selected, { projects: inUse });
			deps.log(report.summary);
			for (const c of report.caught) deps.log(`  caught ${c.id}: ${c.fired.join(", ")}`);
			for (const c of report.wrongOnly) deps.log(`  other  ${c.id}: ${c.fired.join(", ")}`);
			return 0;
		}
		case "search": {
			const flags = readFlags(rest, ["--project"], ["--all", "--global-only"]);
			const query = flags.positional.join(" ").trim();
			if (flags.error || !query) {
				deps.log('Usage: sitra grimoire search "<words>" [--project <id> | --global-only | --all]');
				return 1;
			}
			const view = chooseView(dir, deps.cwd, flags);
			if ("error" in view) {
				deps.log(view.error);
				return 1;
			}
			if (view.all) deps.log("All projects (--all): every entry, labelled with its scope.");
			else if (view.line) deps.log(view.line);
			deps.log(`Paths are in ${dir}.`);
			deps.log(searchEntries(viewEntries(view, listEntries(dir)), query, 8, view.all ? scopeLabel : undefined));
			return 0;
		}
		case "install":
		case "uninstall":
			installGrimoireHooks(deps, dir, command === "uninstall");
			return 0;
		case "import": {
			const repo = mainCheckout(rest[0] ?? deps.cwd);
			const source = join(repo, ".pi", "knowledge");
			if (!existsSync(source)) {
				deps.log(`No old knowledge base in ${repo}.`);
				return 1;
			}
			const { project } = sessionProject(repo, dir);
			const result = importKnowledge(source, dir, repo, proposalScope(project));
			const where =
				project.state === "matched"
					? `, scoped to ${project.project.label},`
					: project.state === "global"
						? `, as global (${project.why}),`
						: "";
			deps.log(
				`Imported ${result.imported.length} entries from ${source} into ${join(dir, "proposals")}${where} for you to review with /grimoire; skipped ${result.skipped.length} that Grimoire already has. The old folder is untouched.`,
			);
			return 0;
		}
		case "scope": {
			const flags = readFlags(rest, ["--project"], ["--global"]);
			const ids = flags.values["--project"] ?? [];
			const files = flags.positional;
			if (flags.error || files.length === 0 || ids.length > 0 === flags.on.has("--global")) {
				deps.log(
					"Usage: sitra grimoire scope <file>... (--project <id>... | --global)  (files as paths from the Grimoire folder, like kinds/facts/x.md)",
				);
				return 1;
			}
			if (ids.length > 0) {
				const found = registeredProjects(dir, ids);
				if ("error" in found) {
					deps.log(found.error);
					return 1;
				}
			}
			try {
				const changed = setScope(
					dir,
					files.map((f) => (isAbsolute(f) ? relative(dir, f) : f)),
					ids.length > 0 ? ids : undefined,
				);
				deps.log(
					`${ids.length > 0 ? `Scoped to ${ids.join(", ")}` : "Made global"}: ${changed.join(", ")}. Sessions started from now on see the change.`,
				);
				return 0;
			} catch (error) {
				deps.log(errorText(error));
				return 1;
			}
		}
		case "projects":
			return projectsCommand(dir, rest, deps);
		case "status":
		case undefined: {
			const flags = readFlags(rest, ["--project"], ["--all", "--global-only"]);
			const view = flags.error ? { error: flags.error } : chooseView(dir, deps.cwd, flags);
			if ("error" in view) {
				deps.log(view.error);
				return 1;
			}
			printStatus(dir, view, deps);
			return 0;
		}
		default:
			deps.log(USAGE);
			return 1;
	}
}

/** `sitra grimoire projects [list | add <id> --remote <url> | add <id> --path <dir>]`: the registry, validated on save. */
function projectsCommand(dir: string, args: readonly string[], deps: CliDeps): number {
	const flags = readFlags(args, ["--remote", "--path", "--label"], []);
	const [sub = "list", id, ...extra] = flags.positional;
	const usage = () => {
		deps.log("Usage: sitra grimoire projects [list | add <id> (--remote <url> | --path <dir>)... [--label <name>]]");
		return 1;
	};
	let registry: ProjectRegistry;
	try {
		registry = readProjects(dir);
	} catch (error) {
		deps.log(errorText(error));
		return 1;
	}
	if (sub === "list" && id === undefined) {
		if (registry.projects.length === 0)
			deps.log("No projects yet, so every entry is global. Add one: sitra grimoire projects add <id> --remote <url>");
		for (const p of registry.projects) {
			deps.log(`${p.id}  ${p.label}`);
			if (p.remotes.length > 0) deps.log(`  remotes: ${p.remotes.join(", ")}`);
			if (p.paths.length > 0) deps.log(`  paths: ${p.paths.join(", ")}`);
		}
		const here = describeProject(sessionProject(deps.cwd, dir).project);
		if (here) deps.log(`Here (${deps.cwd}): ${here}`);
		return 0;
	}
	const remotes = flags.values["--remote"] ?? [];
	const paths = flags.values["--path"] ?? [];
	if (flags.error || sub !== "add" || id === undefined || extra.length > 0 || remotes.length + paths.length === 0)
		return usage();
	let keys: string[];
	let folders: string[];
	try {
		keys = remotes.map((url) => normalizeRemote(url, deps.cwd));
		folders = paths.map((p) => {
			const full = resolve(deps.cwd, p);
			if (!existsSync(full)) throw new Error(`There is no folder at ${full}.`);
			return realpathSync(full);
		});
	} catch (error) {
		deps.log(errorText(error));
		return 1;
	}
	const label = flags.values["--label"]?.at(-1);
	const unique = (list: string[]) => [...new Set(list)];
	const existing = registry.projects.find((p) => p.id === id);
	const project: Project = existing
		? {
				...existing,
				label: label ?? existing.label,
				remotes: unique([...existing.remotes, ...keys]),
				paths: unique([...existing.paths, ...folders]),
			}
		: { id, label: label ?? id, remotes: unique(keys), paths: unique(folders) };
	try {
		writeProjects(dir, {
			projects: existing ? registry.projects.map((p) => (p.id === id ? project : p)) : [...registry.projects, project],
		});
	} catch (error) {
		deps.log(errorText(error));
		return 1;
	}
	deps.log(
		`Saved project ${id} (${project.label}) in ${join(dir, PROJECTS_FILE)}: remotes ${project.remotes.join(", ") || "none"}; paths ${project.paths.join(", ") || "none"}.`,
	);
	for (const folder of folders) {
		const checkout = gitCheckout(folder);
		if (checkout !== undefined && realpathSync(checkout) !== folder)
			deps.log(
				`Warning: ${folder} is inside the git checkout ${checkout}; a path matches only a checkout's main folder, so sessions there won't match it. Attach the checkout's remote, or add ${checkout}.`,
			);
	}
	deps.log("Sessions started from now on use it; sessions already running keep the project they started with.");
	if (registry.projects.length === 0)
		deps.log(
			"This is the first project: run sitra grimoire install so Claude Code's CLAUDE.md note and Codex's session hook match.",
		);
	return 0;
}
