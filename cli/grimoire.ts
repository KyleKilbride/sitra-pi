/**
 * `sitra grimoire …`: puts Grimoire in front of Claude Code and Codex agents too, and moves old `/kb` folders in.
 * Claude Code loads the root through `@` imports in `~/.claude/CLAUDE.md` (hook text is capped at 10,000 characters,
 * imports aren't) and the catalogue through a SessionStart hook. Codex loads both through a SessionStart hook with a
 * raised `additionalContextLimit`. Pure functions here; files and processes are passed in.
 */
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	grimoireDir,
	grimoireSection,
	importKnowledge,
	LIMITS,
	listEntries,
	listProposals,
	loadRoot,
	searchEntries,
	writeClaudeRoot,
} from "../extensions/grimoire.ts";
import { shellQuote } from "../extensions/runs.ts";
import { mainCheckout } from "../extensions/sessions.ts";
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
const MATCHER = "startup|resume|clear|compact";
/** sitra's own hook command: the quoted sitra executable, then `grimoire hook <tool>`. Nothing else matches. */
const OURS = /^'[^']*\/bin\/sitra\.ts' grimoire hook (claude|codex)( |$)/;
const BLOCK_START = "<!-- sitra grimoire: start (managed by `sitra grimoire install`) -->";
const BLOCK_END = "<!-- sitra grimoire: end -->";

/** The SessionStart hook's answer for each tool, as the JSON both tools read from stdout. */
export function hookOutput(tool: "claude" | "codex", dir: string, who?: string): string {
	const entries = existsSync(dir) ? listEntries(dir) : [];
	let text: string;
	const base = { shell: true, ...(who ? { who } : {}) };
	if (tool === "codex") {
		const frame = grimoireSection(dir, undefined, entries, base).length + 300;
		text = grimoireSection(dir, loadRoot(dir, Math.min(LIMITS.rootChars, CODEX_CONTEXT_CHARS - frame)), entries, base);
	} else {
		const frame = grimoireSection(dir, undefined, [], base).length + 200;
		text = grimoireSection(dir, undefined, entries, {
			...base,
			catalogueChars: Math.max(500, CLAUDE_CONTEXT_MAX - frame),
		});
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
	/** The PreToolUse command (rules tied to actions), and which tools it watches. */
	tool?: string;
	toolMatcher?: string;
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
		SessionStart: [...(clean.hooks.SessionStart ?? []), { matcher: MATCHER, hooks: [session] }],
	};
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

/**
 * What a Claude Code or Codex session has already been shown, under `<grimoire>/.sitra/shown/<session>/`: one file per
 * rule, created atomically, so hook processes running in parallel never lose each other's notes. Every call touches
 * the session's folder; folders untouched for three days belong to finished sessions and are removed.
 */
export function sessionShown(dir: string, sessionId: string) {
	const root = join(dir, ".sitra", "shown");
	const folder = join(root, sessionId.replace(/[^\w.-]/g, "_").slice(0, 120) || "unknown");
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
		const { session_id, cwd, tool_name, tool_input } = input as Record<string, unknown>;
		if (typeof tool_name !== "string" || !existsSync(dir)) return "";
		const entries = listEntries(dir).filter((e) => e.when?.length);
		if (entries.length === 0) return "";
		const session = sessionShown(dir, String(session_id ?? "unknown"));
		const action = actionFromHook(tool_name, tool_input);
		const fresh = entriesForAction(entries, action, typeof cwd === "string" ? cwd : process.cwd()).filter(
			(e) => !session.has(e.file),
		);
		if (fresh.length === 0) return "";
		const claimed = pauseMessage(fresh, dir).included.filter((e) => session.claim(e.file));
		session.cleanUp();
		if (claimed.length === 0) return "";
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

/** CLAUDE.md with one sitra-managed block importing the root file, kept where it is; with no file, the block is removed. */
export function claudeMdWithGrimoire(text: string, rootFile: string | undefined): string {
	const block = rootFile
		? [
				BLOCK_START,
				"Grimoire root: the approved, always-loaded knowledge for every agent.",
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
	const hook = (tool: string, kind?: "tool") =>
		`${shellQuote(join(deps.repoRoot, "bin", "sitra.ts"))} grimoire hook ${tool}${kind ? ` ${kind}` : ""} --dir ${shellQuote(where)}`;
	const claudeDir = join(deps.home, ".claude");
	const codexDir = join(deps.home, ".codex");
	let touched = false;
	if (existsSync(claudeDir)) {
		const settings = join(claudeDir, "settings.json");
		const current = readJson(settings);
		const md = join(claudeDir, "CLAUDE.md");
		const before = existsSync(md) ? readFileSync(md, "utf8") : "";
		const after = claudeMdWithGrimoire(before, remove ? undefined : writeClaudeRoot(where));
		writeJson(
			settings,
			remove
				? hooksWithoutGrimoire(current)
				: hooksWithGrimoire(current, {
						session: hook("claude"),
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
						tool: hook("codex", "tool"),
						toolMatcher: CODEX_TOOL_MATCHER,
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

/** Runs `sitra grimoire <command>`. Returns the exit code. */
export function runGrimoireCli(args: readonly string[], deps: CliDeps): number {
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
				// The session hook doesn't need its input; the tool hook without input has nothing to check.
			}
			if (rest[1] === "tool") {
				const out = toolHookOutput(dir, payload);
				if (out) deps.log(out);
				return 0;
			}
			if (tool === "claude" && existsSync(dir)) writeClaudeRoot(dir);
			deps.log(hookOutput(tool, dir, who));
			return 0;
		}
		case "eval": {
			const file = rest[0];
			if (!file || !existsSync(file)) {
				deps.log("Usage: sitra grimoire eval <cases.jsonl>  (one JSON case per line: id, harness, cwd, calls, expect)");
				return 1;
			}
			const cases = readFileSync(file, "utf8")
				.split("\n")
				.filter((l) => l.trim())
				.map((l) => JSON.parse(l) as TriggerCase);
			const report = evaluateTriggers(listEntries(dir), cases);
			deps.log(report.summary);
			for (const c of report.caught) deps.log(`  caught ${c.id}: ${c.fired.join(", ")}`);
			for (const c of report.wrongOnly) deps.log(`  other  ${c.id}: ${c.fired.join(", ")}`);
			return 0;
		}
		case "search": {
			const query = rest.join(" ").trim();
			if (!query) {
				deps.log('Usage: sitra grimoire search "<words>"');
				return 1;
			}
			deps.log(`Paths are in ${dir}.`);
			deps.log(searchEntries(listEntries(dir), query));
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
			const result = importKnowledge(source, dir, repo);
			deps.log(
				`Imported ${result.imported.length} entries from ${source} into ${join(dir, "proposals")} for you to review with /grimoire; skipped ${result.skipped.length} that Grimoire already has. The old folder is untouched.`,
			);
			return 0;
		}
		case "status":
		case undefined: {
			const root = loadRoot(dir);
			deps.log(`Grimoire: ${dir}`);
			deps.log(
				`  root: ${root.files.length} files, ${root.chars} characters${root.truncated ? ` (over the ${LIMITS.rootChars} limit; agents see the first part)` : ""}`,
			);
			deps.log(`  approved: ${listEntries(dir).length}, waiting for review: ${listProposals(dir).length}`);
			return 0;
		}
		default:
			deps.log(
				"Usage: sitra grimoire [status | search <words> | eval <cases.jsonl> | install | uninstall | import [repo] | hook claude|codex [tool]]",
			);
			return 1;
	}
}
