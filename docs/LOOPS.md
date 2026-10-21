# Advisor-first agent graph

The first loop in sitra should be an advisor-first graph, not a blind build -> review -> fix retry loop.
The graph starts only when the person explicitly asks for it with a command or tool. It gathers advice, asks every
ready question in one round, freezes a brief, builds once, verifies independently, and turns misses into Grimoire
proposals the person can approve.

```
explicit start -> advisors + questions -> lead plan -> architecture review -> person approval
               -> build -> independent verify -> done, blocked, or classified rework proposal
```

One check stays because every self-improving system in the research needed an outside signal: tests, an environment, or
an evaluator. The check is measurement and learning, not an automatic fix loop.

## What success looks like

- The person starts the graph explicitly; the lead does not infer it from a normal request.
- Four read-only advisors run before implementation: intent, codebase, test-design, and architecture.
- The intake works like a grill-with-docs pattern, but with sitra structure: every ready question is asked in one round,
  each question includes a recommended answer, agents find facts, the person makes decisions, and intake stops only
  when nothing is open.
- One builder, normally the lead, works from a frozen brief.
- One independent verifier checks the frozen brief, diff, test hashes, and run logs from a fresh context.
- Misses become classified rework entries and Grimoire proposals. A retry is allowed only for real new information or a
  specific learning. There are no blind retries.

## What exists today

Verified against `main` at `997e0e5`:

- **Lead and teammates.** `extensions/lead.ts` gives only the lead the lead rules. The teammate profiles in
  `templates/profile/agents/` include scout, builder, reviewer, and app-tester. Scout and reviewer are read-only.
- **The lead is the normal builder.** `leadRules` says "You do the building"; the builder teammate is for narrow,
  fully specified pieces.
- **Grimoire reaches helpers.** `extensions/knowledge.ts` injects the Grimoire root and catalogue on every
  `before_agent_start`, with no helper guard.
- **Learning already drafts proposals.** `extensions/learn.ts` records correction moments, drafts proposals into
  `proposals/`, records repeats, and reports `caught / learned / repeats`.
- **The person approves knowledge.** `grimoire_propose` writes proposals only; `/grimoire` moves accepted entries into
  `kinds/`. Agents are told never to edit `root/` or `kinds/`.
- **Helper briefs and handovers exist.** `extensions/sharpen-pi.ts` appends the helper brief to subagent tasks and
  writes structured handovers at run end and mid-run.
- **Verifier isolation needs a new path.** `extensions/sharpen-pi.ts` currently appends the lead's latest request and
  rules to every subagent task at lines 110-112. The verifier must avoid that path so it starts fresh with only the
  runner-written task.
- **Profiles need explicit permissions.** `templates/profile/agents/scout.md` has explicit `tools:` and `skills: none`,
  but it allows `bash`; `bash` is read-only by instruction only. `templates/profile/agents/reviewer.md` has
  `skills: none` but no `tools:` list. New advisor and verifier profiles must set both lists explicitly, with no MCP
  write access. The pi-subagents and codemode permission risks come from an audit, not from code verified in this repo.

## First-slice files

Keep pure logic separate from Pi wiring:

- `extensions/loop.ts`: pure state, TypeBox schemas, stage transitions, report validation, metric helpers.
- `extensions/loop-pi.ts`: Pi command/tool wiring, helper starts, run_in_pane integration, Grimoire proposal drafting.
- `package.json`: add `./extensions/loop-pi.ts` to `pi.extensions` when implemented.
- New profile templates for advisors and verifier: each must set explicit `tools:` and `skills:` lists and use the
  `helper_report` tool.

## State and brief schema

The runner is the only writer of the state file. Helpers report facts; they never mutate state directly. The state lives
under the private sitra profile, keyed by worktree path and branch.

Use TypeBox in the implementation because it is already a dependency:

```ts
import { Type } from "typebox";

const Question = Type.Object({
	id: Type.String(),
	text: Type.String(),
	recommended: Type.String(),
	answer: Type.Optional(Type.String()),
});

const Approval = Type.Object({
	approvedBy: Type.String(),
	approvedAt: Type.String(),
	summary: Type.String(),
});

const AdvisorRun = Type.Object({
	status: Type.Union([Type.Literal("done"), Type.Literal("blocked"), Type.Literal("needs-input")]),
	summary: Type.String(),
	evidence: Type.Array(Type.String()),
	openQuestions: Type.Array(Question),
	assumptions: Type.Array(Type.String()),
	tokenCount: Type.Number(),
});

const BuildState = Type.Object({
	testFiles: Type.Array(Type.String()),
	testHashes: Type.Array(Type.Object({ file: Type.String(), sha256: Type.String() })),
	redRunLog: Type.Optional(Type.String()),
	greenRunLog: Type.Optional(Type.String()),
});

const ReworkClass = Type.Union([
	Type.Literal("context-missed"),
	Type.Literal("context-missing"),
	Type.Literal("wrong-intent"),
	Type.Literal("new-information"),
	Type.Literal("execution-slip"),
	Type.Literal("check-gap"),
]);

const ReworkEntry = Type.Object({
	class: ReworkClass,
	evidence: Type.Array(Type.String()),
	proposalPath: Type.Optional(Type.String()),
	overriddenBy: Type.Optional(Type.String()),
});

export const LoopState = Type.Object({
	version: Type.Literal(1),
	worktree: Type.String(),
	branch: Type.String(),
	baseHead: Type.String(),
	stage: Type.Union([
		Type.Literal("advise"),
		Type.Literal("needs-person"),
		Type.Literal("plan"),
		Type.Literal("architecture-review"),
		Type.Literal("brief-approved"),
		Type.Literal("build"),
		Type.Literal("verify"),
		Type.Literal("classify"),
		Type.Literal("blocked"),
		Type.Literal("done"),
	]),
	goal: Type.String(),
	limits: Type.Array(Type.String()),
	done: Type.Array(Type.String()),
	questions: Type.Array(Question),
	advisorRuns: Type.Object({
		intent: Type.Optional(AdvisorRun),
		codebase: Type.Optional(AdvisorRun),
		testDesign: Type.Optional(AdvisorRun),
		architecture: Type.Optional(AdvisorRun),
	}),
	plan: Type.Optional(Type.Object({ author: Type.Literal("lead"), text: Type.String() })),
	approval: Type.Optional(Approval),
	frozenBriefHash: Type.Optional(Type.String()),
	build: BuildState,
	verification: Type.Optional(
		Type.Object({
			status: Type.Union([Type.Literal("passed"), Type.Literal("missed"), Type.Literal("blocked")]),
			runLogs: Type.Array(Type.String()),
			summary: Type.String(),
		}),
	),
	rework: Type.Array(ReworkEntry),
});
```

There is one terminal `done` stage. A completed graph can have many advisor runs and rework entries, but only one
state-level `done`.

## Helper report contract

PR #25 adds the shared `helper_report` shape:

```ts
const HelperReport = Type.Object({
	status: Type.Union([Type.Literal("done"), Type.Literal("blocked"), Type.Literal("needs-input")]),
	summary: Type.String(),
	evidence: Type.Array(Type.String()),
	openQuestions: Type.Array(Type.String()),
	assumptions: Type.Array(Type.String()),
});
```

Each role uses that transport plus a role-specific schema in `details` or an equivalent validated payload. The transport
decision is part of the runner slice because PR #25 removes lead-side text parsing. Options:

1. Pi tool result details carry the validated report to the runner.
2. The helper tool emits a custom message the runner consumes.
3. The helper writes a report file in the private profile and returns its path.

The doc should not choose the transport yet; it should require that the runner receives validated fields, not prose.

Role schemas:

```ts
const IntentDetails = Type.Object({
	questions: Type.Array(Question),
	doneCandidates: Type.Array(Type.String()),
	ambiguities: Type.Array(Type.String()),
});

const CodebaseDetails = Type.Object({
	files: Type.Array(Type.String()),
	existingTests: Type.Array(Type.String()),
	facts: Type.Array(Type.String()),
	boundaries: Type.Array(Type.String()),
});

const TestDesignDetails = Type.Object({
	acceptanceTests: Type.Array(Type.String()),
	testFiles: Type.Array(Type.String()),
	commands: Type.Array(Type.String()),
});

const ArchitectureDetails = Type.Object({
	fitsExistingArchitecture: Type.Boolean(),
	boundaryConcerns: Type.Array(Type.String()),
	needlessLayersOrCode: Type.Array(Type.String()),
	simplerShape: Type.Array(Type.String()),
	privateChecklistEntriesUsed: Type.Array(Type.String()),
});

const VerifierDetails = Type.Object({
	checksRun: Type.Array(Type.String()),
	runLogs: Type.Array(Type.String()),
	testHashesChecked: Type.Array(Type.String()),
	goalMatched: Type.Boolean(),
	missClass: Type.Optional(ReworkClass),
});
```

## Advisor inputs and ordering

All advisors are read-only and must report through `helper_report`.

| Role | Inputs | Sees other advisor output? | When it runs |
|---|---|---|---|
| Intent | Goal, limits, Grimoire root/catalogue, current questions | No | First, in parallel with codebase |
| Codebase | Goal, limits, Grimoire root/catalogue, repository files/history | No | First, in parallel with intent |
| Test-design | Goal, limits, Grimoire root/catalogue, intent and codebase reports | Yes: intent and codebase | After intent/codebase are done |
| Architecture | Goal, limits, frozen advisor brief, lead-authored plan, private checklist from profile or Grimoire | Yes: all brief sections and plan | After the lead drafts the plan |

The architecture checklist is private user material. It lives in the person's profile or Grimoire, not in this repo.
The repo ships only the generic advisor role.

The intake keeps the good grill-with-docs behavior: ask all ready questions at once, include recommended answers, let
agents gather facts, leave decisions to the person, and stop only when no open question remains. Sitra adds structured
brief fields, Grimoire instead of an ad-hoc context file, tests before implementation, and learning from misses.

## Stage transitions

| From | Event | Writer/decider | To |
|---|---|---|---|
| none | Person explicitly starts graph with command/tool | Runner | advise |
| advise | Intent/codebase/test-design reports have open questions | Runner asks one grouped question | needs-person |
| needs-person | Person answers | Runner updates state | advise |
| advise | Only affected context changed | Runner reruns affected advisors only | advise |
| advise | No open questions remain | Lead writes a high-level plan | plan |
| plan | Plan is ready | Runner starts Architecture advisor | architecture-review |
| architecture-review | Architecture asks questions or blocks | Runner asks one grouped question | needs-person |
| architecture-review | Architecture approves or has non-blocking notes | Person approves plan/brief | brief-approved |
| brief-approved | Build starts | Builder records tests and red run, then implements | build |
| build | Green run exists | Runner writes verifier task | verify |
| verify | Verifier passes | Runner marks one terminal state | done |
| verify | Verifier misses or blocks | Runner records classification request | classify |
| classify | Real new information confirmed by person | Runner drafts proposal if needed, allows one more build | brief-approved |
| classify | Same class repeats within this task | Runner asks one question | blocked |
| classify | Second miss after rework | Runner asks one question | blocked |
| blocked | Person answers the one blocking question | Runner updates state | advise or brief-approved, depending on answer |

The lead writes the plan. The runner writes state and helper tasks.

## Build and verify

The red run belongs in `build`, not in the frozen brief. The frozen brief says what tests must exist; the builder
materializes those tests and records:

- `testFiles`;
- `testHashes` after materializing tests;
- `redRunLog`;
- `greenRunLog`.

A missing red run blocks `verify` only. It does not reopen the brief.

The verifier is independent:

- The runner writes the verifier task from the frozen brief, diff, test hashes, and `run_in_pane` log paths.
- The verifier starts in a fresh context with no builder transcript.
- Because `sharpen-pi.ts` currently appends lead context to every subagent task, the verifier path must avoid that
  helper-brief injection.
- Use a fixed verifier profile: reuse `reviewer.md` only after adding explicit `tools:` and `skills:`, or add
  `verifier.md`.
- Prefer a verifier model different from the builder's model.
- The verifier reruns the agreed checks itself when they are targeted and available. It also inspects the runner's
  provided red/green logs and test hashes. If it cannot rerun or inspect enough evidence, it reports `blocked`.

## Stop conditions

| Stop | Who decides | Next stage |
|---|---|---|
| Open questions remain | Runner from advisor reports | `needs-person` |
| Grimoire missing or unreadable | Open question for the person: should missing and unreadable both block? | `blocked` until answered |
| State is stale | Runner | `blocked` |
| Red run missing | Runner before verifier starts | `build` to record red run, or `blocked` if impossible |
| Verifier cannot inspect enough evidence | Verifier | `blocked` |
| Same class repeats within one task | Runner, using `rework[].class` | `blocked` with one question |
| Real new information claimed | Person decides through a question | `brief-approved` if confirmed, otherwise `blocked` |
| Second post-check miss after one rework | Runner | `blocked` with one question |

"Same class repeats" means the latest rework class matches an earlier rework class in the same state file for the same
task. "Stale" means the state no longer matches the current worktree: branch/base head changed, frozen brief hash is
not current, test hashes do not match test files, or the diff no longer matches what the verifier was asked to inspect.
Leaving `blocked` always requires one answer from the person; the runner never retries on its own.

## Metrics and cost

All four advisors run in slice one. Advisors must still earn their tokens, so the runner records token counts per
advisor and per graph. The initial metric can be a CLI/status line backed by state files, not radar:

```
loops: first-pass 6/8 · avoidable rework context 1 intent 1 check 0 · tokens 42k
```

For "accepted without rework", use two data sources:

- `learn.ts` correction moments on the branch after the graph finishes;
- follow-up commits on the branch after verifier pass or review.

These are imperfect but measurable. The metric should track both "agreed checks passed first time" and "no correction or
follow-up commit after review."

## Out of scope for the first piece

- A LangGraph-style DSL or runtime.
- A tower that dispatches work or starts rework by itself.
- Heuristic auto-start from normal lead requests.
- Parallel builders, voting reviewers, or graph optimization.
- A new memory ranker or embeddings service.
- PR creation guardrails beyond existing lead rules.
- Automatic merge, auto-merge, or non-draft PR creation.
- Codex and Claude Code loop runners. They still get Grimoire and triggers, but the first runner is Pi-only.
- Radar tree or radar proof work.

## How to prove it

Use red-then-green tests with a new scripted model fixture, `test/fixtures/loop-model.ts`.

1. Pure state tests for TypeBox validation, stale detection, stage transitions, stop conditions, and one terminal
   `done`.
2. Helper report tests for base `helper_report` validation and each role's detail schema.
3. Advisor-order tests: intent/codebase in parallel, test-design after those reports, architecture after lead plan, and
   rerun only affected advisors after answers.
4. Build tests: builder records test files, test hashes, red run log, and green run log; missing red run blocks verify.
5. Verifier independence tests: verifier task contains frozen brief, diff, test hashes, and logs; it does not contain
   builder transcript or sharpen helper brief.
6. Classification tests: each miss class writes the right proposal shape, except genuine new information until the
   person confirms it.
7. E2E test: real `pi --mode rpc --no-extensions` with the loop extension and fake model, driven through explicit
   graph start, advisor reports, approval, build, verify, classify, and done/blocked.

`check.yml` exists, but CI has not been observed running for this work. Verification for the slice assumes local
`pnpm check` run through `run_in_pane` under Node >= 24.12, matching `package.json`.

## Open questions for the person

1. Should missing Grimoire and unreadable Grimoire both block the runner, or should a missing empty Grimoire be allowed
   for a new profile?
2. Which transport should carry validated helper reports to the runner: tool result details, custom messages, or private
   report files?
3. Should the verifier always rerun agreed checks, or may it accept existing logs for checks that are expensive but
   already captured by `run_in_pane`?
