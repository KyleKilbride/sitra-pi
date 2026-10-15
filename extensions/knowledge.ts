/**
 * sitra knowledge: every agent starts with the repo's approved knowledge (.pi/knowledge), can propose
 * new entries with `kb_propose`, and only you turn a proposal into knowledge (`/kb`). `/kb-reflect`
 * asks the agent to look back over the session and propose what future agents should know.
 */
import { execFileSync } from "node:child_process";
import { Type } from "typebox";
import {
	decide,
	KINDS,
	type Kind,
	knowledgeIndex,
	knowledgeRoot,
	listEntries,
	listProposals,
	writeProposal,
} from "./kb.ts";

interface Ctx {
	cwd: string;
	hasUI: boolean;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		select(title: string, options: string[]): Promise<string | undefined>;
		setStatus(key: string, text: string | undefined): void;
	};
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
			params: { kind: Kind; title: string; body: string; evidence?: string },
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: Ctx,
		): Promise<{ content: { type: "text"; text: string }[]; details: unknown }>;
	}): void;
	registerCommand(name: string, command: { description: string; handler(args: string, ctx: Ctx): Promise<void> }): void;
	sendUserMessage(content: string): void;
}

function repoRoot(cwd: string): string {
	try {
		return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
	} catch {
		return cwd;
	}
}

export default function sitraKnowledge(pi: Pi): void {
	const status = (ctx: Ctx) => {
		const root = knowledgeRoot(repoRoot(ctx.cwd));
		const proposals = listProposals(root).length;
		ctx.ui.setStatus("sitra-kb", `kb ${listEntries(root).length}${proposals ? ` · ${proposals} to review (/kb)` : ""}`);
	};

	pi.on("session_start", (_event, ctx) => status(ctx));

	pi.on("before_agent_start", (event, ctx) => {
		const root = knowledgeRoot(repoRoot(ctx.cwd));
		event.systemPromptOptions.sections["project-knowledge"] = knowledgeIndex(listEntries(root), root);
	});

	pi.registerTool({
		name: "kb_propose",
		label: "Propose knowledge",
		description:
			"Propose an entry for this repo's knowledge base: something future agents must know (a lesson, a fact about how the app really works, a decision and its reason, a warning, or a change to the agent setup). The human reviews every proposal; nothing is saved as knowledge until they accept it. Include evidence: a file:line, a command and its output, or a link.",
		promptSnippet: "kb_propose: propose a knowledge-base entry for the human to approve",
		parameters: Type.Object({
			kind: Type.Union(KINDS.map((k) => Type.Literal(k))),
			title: Type.String({ description: "One line, specific." }),
			body: Type.String({ description: "What to know and why, in a few sentences." }),
			evidence: Type.Optional(
				Type.String({ description: "Where this was observed: file:line, command output, link." }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const root = knowledgeRoot(repoRoot(ctx.cwd));
			const file = writeProposal(root, { ...params, proposedBy: "agent", date: new Date().toISOString() });
			status(ctx);
			return {
				content: [
					{
						type: "text",
						text: `Proposed (${file}). The human will review it with /kb; don't treat it as knowledge until then.`,
					},
				],
				details: { file },
			};
		},
	});

	pi.registerCommand("kb", {
		description: "Review knowledge proposals one at a time: accept, reject, or skip",
		async handler(_args, ctx) {
			const root = knowledgeRoot(repoRoot(ctx.cwd));
			const proposals = listProposals(root);
			if (proposals.length === 0) {
				ctx.ui.notify(`No proposals. ${listEntries(root).length} entries in ${root}.`, "info");
				return;
			}
			for (const [i, p] of proposals.entries()) {
				const title = `(${i + 1}/${proposals.length}) [${p.kind}] ${p.title}\n\n${p.body}${p.evidence ? `\n\nEvidence: ${p.evidence}` : ""}`;
				const choice = await ctx.ui.select(title, [
					"Accept",
					"Reject",
					"Skip",
					"Accept this and all the rest",
					"Stop reviewing",
				]);
				if (choice === "Accept this and all the rest") {
					for (const rest of proposals.slice(i)) decide(root, rest.file, "accept");
					break;
				}
				if (choice === "Accept") decide(root, p.file, "accept");
				else if (choice === "Reject") decide(root, p.file, "reject");
				else if (choice !== "Skip") break;
			}
			status(ctx);
		},
	});

	pi.registerCommand("kb-reflect", {
		description: "Ask the agent to look back over this session and propose what future agents should know",
		async handler() {
			pi.sendUserMessage(
				"Look back over this session. What did we learn that a future agent working in this repo must know — about how the app really works, mistakes to avoid, decisions and their reasons, or changes to the agent setup itself? Propose at most 3 entries with kb_propose, each with evidence. Skip anything obvious or already in the project knowledge. Then stop.",
			);
		},
	});
}
