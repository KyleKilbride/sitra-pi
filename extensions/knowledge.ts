/**
 * sitra's Pi wiring for Grimoire: every agent starts with the root and a one-line catalogue of approved entries, can
 * search (`grimoire_search`) and propose (`grimoire_propose`), and only the person approves (`/grimoire`).
 * `/grimoire-reflect` asks the agent what this session taught that future agents need. `/kb` still works and points here.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import {
	decide,
	grimoireDir,
	grimoireSection,
	importedRepos,
	KINDS,
	type Kind,
	listEntries,
	listProposals,
	loadRoot,
	searchEntries,
	unreadableProposals,
	writeClaudeRoot,
	writeProposal,
} from "./grimoire.ts";
import { captureMoment, learningOn, recordPause, recordPauseFollowUp } from "./learn.ts";
import { mainCheckout, readLastLines } from "./sessions.ts";
import { actionFromPi, entriesForAction, parseTrigger, pauseMessage } from "./triggers.ts";

interface Ctx {
	cwd: string;
	sessionManager?: { getSessionFile?(): string | undefined; getSessionId?(): string };
	hasUI: boolean;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		select(title: string, options: string[]): Promise<string | undefined>;
		setStatus(key: string, text: string | undefined): void;
	};
}

interface ToolResult {
	content: { type: "text"; text: string }[];
	details: unknown;
}

interface Pi {
	on(event: "session_start", handler: (event: unknown, ctx: Ctx) => void): void;
	on(event: "tool_call", handler: (event: ToolCall, ctx: Ctx) => { block: true; reason: string } | undefined): void;
	on(
		event: "before_agent_start",
		handler: (event: { systemPromptOptions: { sections: Record<string, string> } }, ctx: Ctx) => void,
	): void;
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		promptSnippet?: string;
		parameters: unknown;
		execute(
			id: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: Ctx,
		): Promise<ToolResult>;
	}): void;
	registerCommand(name: string, command: { description: string; handler(args: string, ctx: Ctx): Promise<void> }): void;
	sendUserMessage(content: string): void;
	getActiveTools?(): string[];
	setActiveTools?(tools: string[]): void;
}

interface ToolCall {
	toolName: string;
	input: Record<string, unknown>;
}

const GRIMOIRE_TOOLS = ["grimoire_propose", "grimoire_search"];

const REFLECT =
	"Look back over this session. What did we learn that a future agent must know: a mistake and what would have caught it, how something really works, a decision and its reason, or a change to the agent setup? Check Grimoire first (the catalogue in your prompt, or grimoire_search) and skip anything it already says. Propose at most 3 entries with grimoire_propose, each with evidence. For a lesson, say what failed, the verified cause, the fix, whether it held, and what would catch it next time. Then stop.";

export default function sitraKnowledge(pi: Pi): void {
	const dir = () => grimoireDir(process.env);
	const who = () => process.env.SITRA_USER_NAME?.trim() || "the person you work with";

	/** A repo whose old `/kb` folder hasn't been moved into Grimoire yet. */
	const oldKnowledgeBase = (cwd: string): string | undefined => {
		const repo = mainCheckout(cwd);
		return existsSync(join(repo, ".pi", "knowledge")) && !importedRepos(dir()).includes(repo) ? repo : undefined;
	};

	const status = (ctx: Ctx) => {
		const g = dir();
		const approved = listEntries(g).length;
		const waiting = listProposals(g).length;
		const parts = [`grimoire ${approved}`];
		if (waiting) parts.push(`${waiting} to review (/grimoire)`);
		if (loadRoot(g).truncated) parts.push("root over its limit");
		if (oldKnowledgeBase(ctx.cwd)) parts.push("old /kb here: sitra grimoire import");
		ctx.ui.setStatus("sitra-grimoire", parts.join(" · "));
	};

	/** The agent turn tool calls belong to, so calls sent together aren't mistaken for a reaction to a pause. */
	let turn = 0;
	(pi.on as unknown as (e: "turn_start", h: () => void) => void)("turn_start", () => {
		turn++;
	});
	/** Rules tied to actions already shown in this session; each pauses one action, once. */
	let shown = new Set<string>();

	pi.on("tool_call", (event, ctx) => {
		// Anything unexpected (an odd event, a Grimoire it can't read) means no opinion: never block a tool by mistake.
		try {
			if (typeof event?.toolName !== "string") return undefined;
			const g = dir();
			const session = ctx?.sessionManager?.getSessionId?.() ?? `pi-${process.pid}`;
			const call = { tool: event.toolName, input: event.input && typeof event.input === "object" ? event.input : {} };
			try {
				recordPauseFollowUp(g, session, call, { turn: String(turn) });
			} catch {
				// Measuring never gets in the way of a rule.
			}
			const tied = listEntries(g).filter((e) => e.when?.length);
			if (tied.length === 0) return undefined;
			const input = event.input && typeof event.input === "object" ? event.input : {};
			const matched = entriesForAction(tied, actionFromPi(event.toolName, input), ctx.cwd, shown);
			if (matched.length === 0) return undefined;
			const { text, included } = pauseMessage(matched, g);
			if (included.length === 0) return undefined;
			for (const e of included) shown.add(e.file);
			try {
				recordPause(
					g,
					session,
					included.map((e) => e.file),
					call,
					{ turn: String(turn) },
				);
			} catch {
				// Measuring never gets in the way of a rule.
			}
			return { block: true, reason: text };
		} catch {
			return undefined;
		}
	});

	pi.on("session_start", (_event, ctx) => {
		shown = new Set();
		// Claude Code imports the root from this file once `sitra grimoire install` has run; keep it current.
		const g = dir();
		if (existsSync(join(g, ".sitra", "root.md"))) {
			try {
				writeClaudeRoot(g);
			} catch {
				// Claude Code's copy is a convenience; never block a Pi session on it.
			}
		}
		status(ctx);
	});

	pi.on("before_agent_start", (event, ctx) => {
		// Nothing here may stop a turn: each step fails on its own.
		const e = event as { messageType?: string; prompt?: string };
		const person = !process.env.PI_SUBAGENT_NAME && e.messageType === "user" && typeof e.prompt === "string";
		if (person && learningOn(process.env)) {
			// Every message the person sends is a moment Grimoire may learn from; a detached learner decides it.
			try {
				const file = ctx?.sessionManager?.getSessionFile?.();
				captureMoment(dir(), process.env, {
					harness: "pi",
					cwd: ctx?.cwd ?? process.cwd(),
					message: e.prompt as string,
					transcript: file ? readLastLines(file, 400, { maxBytes: 1_000_000 }) : "",
				});
			} catch {
				// Learning never gets in the way of the turn.
			}
		}
		if (person && ctx?.ui) {
			// Background learning and other sessions write proposals; keep the review count current.
			try {
				status(ctx);
			} catch {
				// A status line is never worth a failed turn.
			}
		}
		// A resumed conversation restores the tool list it was saved with, so one saved before Grimoire never sees
		// these tools. Helpers keep the list their agent definition chose.
		try {
			if (!process.env.PI_SUBAGENT_NAME && pi.getActiveTools && pi.setActiveTools) {
				const active = pi.getActiveTools();
				const missing = GRIMOIRE_TOOLS.filter((t) => !active.includes(t));
				if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
			}
		} catch {
			// Tools stay as they were.
		}
		try {
			const g = dir();
			event.systemPromptOptions.sections.grimoire = grimoireSection(g, loadRoot(g), listEntries(g), { who: who() });
		} catch {
			// An unreadable Grimoire leaves the prompt without it rather than failing the turn.
		}
	});

	pi.registerTool({
		name: "grimoire_propose",
		label: "Propose to Grimoire",
		description:
			"Propose an entry for Grimoire, the shared approved knowledge every agent starts with: something future agents must know (a lesson from a mistake, a fact about how things really work, a decision and its reason, a warning, or a change to the agent setup). The person reviews every proposal; nothing counts as knowledge until they accept it. Include evidence: a file:line, a command and its output, or a link.",
		promptSnippet: "grimoire_propose: propose a Grimoire entry for the person to approve",
		parameters: Type.Object({
			kind: Type.Union(KINDS.map((k) => Type.Literal(k))),
			title: Type.String({ description: "One line, specific." }),
			summary: Type.String({ description: "One plain sentence: what to do and when." }),
			body: Type.String({
				description:
					"What to know and why, in a few sentences. For a lesson: what failed, the verified cause, the fix, whether it held, what would catch it next time.",
			}),
			evidence: Type.Optional(
				Type.String({ description: "Where this was observed: file:line, command output, link." }),
			),
			tags: Type.Optional(Type.Array(Type.String(), { description: "A few words for what it's about." })),
			links: Type.Optional(
				Type.Array(Type.String(), { description: "Related entries, as paths like kinds/lessons/<file>.md." }),
			),
			when: Type.Optional(
				Type.Array(Type.String(), {
					description:
						'Actions that should bring this rule up, if the mistake happens at one: "command:<leading words of a shell command>", "path:<glob of files touched>" or "tool:<tool name>"; join conditions with " + ".',
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as {
				kind: Kind;
				title: string;
				summary: string;
				body: string;
				evidence?: string;
				tags?: string[];
				links?: string[];
				when?: string[];
			};
			const when = p.when?.filter((w) => parseTrigger(w));
			const file = writeProposal(dir(), {
				...p,
				...(when?.length ? { when } : { when: undefined }),
				proposedBy: "agent",
				date: new Date().toISOString(),
			});
			status(ctx);
			return {
				content: [
					{
						type: "text",
						text: `Proposed (${file}). ${who()} will review it with /grimoire; don't treat it as knowledge until then.`,
					},
				],
				details: { file },
			};
		},
	});

	pi.registerTool({
		name: "grimoire_search",
		label: "Search Grimoire",
		description:
			"Search Grimoire's approved entries by words. Returns one line per match (kind, title, summary, path); read the path for the full entry. Set proposals to true to also search unapproved proposals, which are leads, not rules.",
		promptSnippet: "grimoire_search: find approved Grimoire entries about a topic",
		parameters: Type.Object({
			query: Type.String({ description: "Words for what you need, e.g. 'feature flags evals production'." }),
			proposals: Type.Optional(Type.Boolean({ description: "Also search unapproved proposals." })),
		}),
		async execute(_id, params) {
			const p = params as { query: string; proposals?: boolean };
			const g = dir();
			const approved = searchEntries(listEntries(g), p.query);
			const text = p.proposals
				? `${approved}\n\nUnapproved proposals (leads, not rules):\n${searchEntries(listProposals(g), p.query)}`
				: approved;
			return { content: [{ type: "text", text: `Paths are in ${g}.\n${text}` }], details: { query: p.query } };
		},
	});

	const review = async (ctx: Ctx) => {
		const g = dir();
		const proposals = listProposals(g);
		const unreadable = unreadableProposals(g);
		if (unreadable.length > 0) {
			ctx.ui.notify(`${unreadable.length} proposal(s) can't be read as entries: ${unreadable.join(", ")}`, "warning");
		}
		if (proposals.length === 0) {
			ctx.ui.notify(`No proposals. ${listEntries(g).length} approved entries in ${g}.`, "info");
			return;
		}
		for (const [i, p] of proposals.entries()) {
			const lines = [
				`(${i + 1}/${proposals.length}) [${p.kind}] ${p.title}`,
				...(p.summary ? ["", p.summary] : []),
				"",
				p.body,
				...(p.tags ? ["", `Tags: ${p.tags.join(", ")}`] : []),
				...(p.when ? ["", `Pauses the agent when: ${p.when.join("; ")}`] : []),
				...(p.evidence ? ["", `Evidence: ${p.evidence}`] : []),
			];
			const choice = await ctx.ui.select(lines.join("\n"), [
				"Accept",
				"Reject",
				"Skip",
				"Accept this and all the rest",
				"Stop reviewing",
			]);
			if (choice === "Accept this and all the rest") {
				for (const rest of proposals.slice(i)) decide(g, rest.file, "accept");
				break;
			}
			if (choice === "Accept") decide(g, p.file, "accept");
			else if (choice === "Reject") decide(g, p.file, "reject");
			else if (choice !== "Skip") break;
		}
		status(ctx);
	};

	pi.registerCommand("grimoire", {
		description: "Review Grimoire proposals one at a time: accept, reject, or skip",
		handler: async (_args, ctx) => review(ctx),
	});
	pi.registerCommand("grimoire-reflect", {
		description: "Ask the agent what this session taught that future agents need, as Grimoire proposals",
		handler: async () => pi.sendUserMessage(REFLECT),
	});
	pi.registerCommand("kb", {
		description: "Renamed to /grimoire",
		async handler(_args, ctx) {
			ctx.ui.notify("/kb is now /grimoire: one approved knowledge base for every repo and tool.", "info");
			await review(ctx);
		},
	});
	pi.registerCommand("kb-reflect", {
		description: "Renamed to /grimoire-reflect",
		handler: async () => pi.sendUserMessage(REFLECT),
	});
}
