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
import { mainCheckout } from "./sessions.ts";

interface Ctx {
	cwd: string;
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

	pi.on("session_start", (_event, ctx) => {
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

	pi.on("before_agent_start", (event) => {
		// A resumed conversation restores the tool list it was saved with, so one saved before Grimoire never sees
		// these tools. Helpers keep the list their agent definition chose.
		if (!process.env.PI_SUBAGENT_NAME && pi.getActiveTools && pi.setActiveTools) {
			const active = pi.getActiveTools();
			const missing = GRIMOIRE_TOOLS.filter((t) => !active.includes(t));
			if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
		}
		const g = dir();
		event.systemPromptOptions.sections.grimoire = grimoireSection(g, loadRoot(g), listEntries(g), { who: who() });
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
			};
			const file = writeProposal(dir(), { ...p, proposedBy: "agent", date: new Date().toISOString() });
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
