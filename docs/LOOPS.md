# Advisor-first agent graph

Kyle's goal is not a builder that fails, loops, and tries again. The goal is a team that gets the important
understanding in front of the builder before the first change, measures what happened, and learns when it missed.

The first piece should therefore be an **advisor-first graph**:

```
Kyle's goal -> read-only advisors -> one shared brief -> Kyle approves questions + plan
             -> one builder -> one independent check -> pass, or classify the rework event
             -> Grimoire proposal for Kyle -> next brief is better
```

The independent check stays, but its job changes. It is not a critic that drives an automatic fix loop. It is the
measurement signal every self-improving system in the research still needed: tests, an environment, or another outside
evaluator. The check tells sitra what to learn.

## What success looks like

- The graph is opt-in. The lead chooses it only when a task has enough shape for a brief and acceptance evidence.
- Advisors run before implementation. They are read-only, role-specific, and useful only when they bring different
  information.
- Kyle sees the advisors' questions and the high-level plan before the build starts. He should not have to approve a
  low-level implementation script while the task is still taking shape.
- One builder, normally the lead, works from the approved brief.
- One independent verifier checks the result against acceptance tests agreed before the build. It also checks the
  original goal and catches weakened tests.
- A miss becomes a classified **rework event**, not a blind retry. A second round is allowed only for real new
  information or a specific learning, never because the builder lacked context it could have had.
- The metric is first-pass rate and avoidable rework trending down over time, plus per-task tokens. It is not 100%.

## What exists today

Verified against `main` at `997e0e5`:

- **Lead and teammates.** `extensions/lead.ts` gives only the lead the lead rules. It says to plan first, pass Kyle's
  limits to teammates, and steer teammates only through subagent tools. The profiles in `templates/profile/agents/`
  already include scout, builder, reviewer and app-tester. Scout and reviewer are read-only.
- **The lead is the normal builder.** `leadRules` says "You do the building"; the builder teammate is for narrow,
  fully specified pieces.
- **Grimoire reaches helpers.** `extensions/knowledge.ts` injects the Grimoire root and catalogue on every
  `before_agent_start`, with no helper guard. Action triggers use `extensions/triggers.ts`.
- **Learning already drafts proposals.** `extensions/learn.ts` records correction moments, classifies correction versus
  other, drafts proposals into `proposals/`, records repeats, and reports `caught / learned / repeats`.
- **Kyle approves knowledge.** `grimoire_propose` writes proposals only; `/grimoire` moves accepted entries into
  `kinds/`. Agents are told never to edit `root/` or `kinds/`.
- **Helper briefs and handovers exist.** `extensions/sharpen-pi.ts` appends the helper brief to subagent tasks and
  writes structured handovers at run end and mid-run.
- **Radar has the data, not the tree.** `extensions/sessions.ts` groups leads and teammates; `extensions/radar.ts` and
  `radar-view.ts` show helper counts today, not a lead-to-helper tree.
- **Action triggers can pause shell PR creation, but not yet hard-gate it.** Current triggers block once with "run it
  again unchanged if it follows them." A loop PR gate must be stricter than today's trigger behavior.
- **Grimoire currently fails open when unreadable.** The loop must not. If Grimoire cannot be read, the loop is
  `blocked` because the brief cannot be trusted.

Observed in the current PR: `docs/LOOPS.md` had a build -> review -> fix framing. Kyle rejected that framing; this
document replaces it.

## Design

### The runner

Add a thin Pi extension in the lead session. It owns state and step transitions, but the lead remains the user-facing
agent. The tower still watches, carries mail and reports status; it never assigns work or starts fixes.

The runner stores one JSON state file per worktree under the sitra profile, keyed by worktree path and branch. JSON is
for validation: product code must not infer state from prose or regex.

```json
{
  "version": 1,
  "worktree": "/path/to/worktree",
  "branch": "cursor/example",
  "goal": "Kyle's words, quoted where they matter",
  "stage": "advise",
  "done": ["What acceptance evidence proves the goal"],
  "limits": ["No full suites unless Kyle asks", "Do not weaken checks"],
  "brief": {
    "intent": { "questions": [], "done": [] },
    "codebase": { "files": [], "facts": [], "risks": [] },
    "testDesign": { "acceptanceTests": [], "redRunLog": null },
    "optional": {}
  },
  "plan": ["High-level plan Kyle approved"],
  "verification": { "status": "pending", "log": null },
  "rework": []
}
```

Valid stages are explicit: `advise`, `needs-kyle`, `brief-approved`, `build`, `verify`, `passed`, `rework`,
`blocked`. Every helper returns through a structured report tool with fields. If a report is missing or invalid, the
state becomes `blocked` and the raw report is shown.

### Advisors before the build

Start with three advisors:

| Advisor | Role | Built from |
|---|---|---|
| Intent | Finds ambiguity, writes sharp questions for Kyle, captures "done" in Kyle's words | New read-only profile |
| Codebase | Finds relevant files, history, existing tests and local patterns | Existing scout role |
| Test-design | Writes acceptance-test definitions into the brief before the builder starts | New read-only profile |

Risk and ops/observability advisors are optional. They run only when the task touches safety, runtime behavior, rollout,
logs, rate limits or production operations.

External evidence from the research supports this direction, with caveats:

- Verified in the research: underspecified coding tasks are common, and asking clarifying questions can improve results
  (OpenAI SWE-bench Verified, Ambig-SWE, ClarifyGPT).
- Verified in the research: test design as a separate role and test-first generation improve pass rates (AgentCoder,
  TDD for code generation).
- Verified in the research: multi-agent discussion is fragile and costly unless agents bring different information
  (Anthropic multi-agent research system, Cognition, MAST, "Should we be going MAD?").

So advisors must earn their tokens. The runner skips optional advisors when Grimoire, the existing scout, and the lead's
own plan already cover the task. It records which advisors ran and how many tokens the graph spent.

### Approval and build

The lead shows Kyle the advisors' open questions and a short high-level plan. The full brief is available, but Kyle
should not have to edit it line by line unless he asks. After Kyle answers and approves the plan, the runner freezes the
brief for the build.

The builder is one agent, normally the lead. A builder teammate can still be used for a narrow, fully specified piece,
but there are no parallel builders and no voting builders. The first build step is to materialize the agreed acceptance
tests and record the failing red run, then implement the product change. The builder may not rewrite the agreed
acceptance tests without the state recording it as a rework risk.

### One check, then classify

The verifier is independent and read-only. It checks:

- the implementation against the agreed acceptance tests and "done" condition;
- that the red run was recorded before implementation;
- that tests were not skipped, weakened or moved after agreement;
- the high-level goal, not just the test output.

Pass opens the PR gate. A miss creates a rework event with one of these classes:

| Class | Meaning | Drafted Grimoire proposal |
|---|---|---|
| Context existed but did not reach builder | The fact was in Grimoire or the repo but absent from the brief | Trigger, sharper wording, or root move |
| Context was missing | The fact was not recorded anywhere | New fact, warning or lesson |
| Wrong intent | The team should have asked Kyle a better question | Intent-advisor question pattern |
| Genuine new information | Kyle changed the goal or a new fact appeared | No avoidable-rework count; maybe record the decision |
| Execution slip | The brief was good but the work slipped | Warning or setup, if reusable |
| Gap in the check | Tests passed but did not prove the goal | Test-design checklist addition |

Kyle approves every proposal. Nothing is auto-written to `root/` or `kinds/`. Lessons evolve in small ACE-style steps:
add a narrow proposal with evidence, do not rewrite the playbook wholesale.

A second build round is allowed only when the rework event identifies real new information or a specific learning to
apply. If the same class repeats, the runner stops and asks Kyle one question.

### PR gate and radar

The PR gate is part of the first slice. The lead may open a draft PR only from `passed`. The design should use the
existing action-matching machinery for `gh pr create`, but today's pause-once trigger is not enough; the loop needs a
persistent hard block until the state file says `passed`.

Radar stays view-only. Add:

- a live lead -> helper tree;
- stage and advisors run for the current graph;
- a line like `first-pass 6/8 · avoidable rework: context 1, intent 1 · tokens 42k`.

The metric should track both "agreed tests passed first time" and "Kyle accepted or merged without asking for rework."
Those are different signals.

## Anti-gaming

The research makes the metric risky if it becomes a target:

- Verified in the research: DGM faked a log and METR saw reward hacking. Therefore the runner records raw run logs from
  `run_in_pane`, stores the red-run log before implementation, and treats missing or edited logs as blocked.
- Verified in the research: AgentPoison and MINJA show memory can be poisoned. Therefore every proposal needs evidence,
  Kyle approval, and small changes. Proposals never go straight to root.
- Guess from the research: agents may call a miss "new info" to protect the first-pass metric. Therefore classification
  uses a separate model and the verifier's evidence, and repeated "new info" calls are surfaced in radar for Kyle.
- Verified in current code: triggers can catch `gh pr create` commands. The loop gate must extend that path so shell PRs
  cannot bypass state.
- Verified in current code: tests and checks can run through `run_in_pane`; the verifier should cite those log paths,
  not screenshots or prose summaries alone.

## Cost

Advisors are not free. The research cites Anthropic's multi-agent system using about 15x more tokens than chat, and also
says coding tasks are less parallel than research tasks. The first slice should therefore:

- run only intent, codebase and test-design by default;
- skip optional advisors unless the task asks for their information;
- record token cost per advisor and per task;
- compare first-pass and avoidable rework against token cost;
- drop or narrow an advisor whose output rarely changes the brief.

## Out of scope for the first piece

- A LangGraph-style DSL or runtime.
- A tower that dispatches work or starts rework by itself.
- Mandatory advisor -> build -> verify routing for every user request.
- Parallel builders, voting reviewers or graph optimization.
- A new memory ranker or embeddings service.
- Automatic merge, auto-merge or non-draft PR creation.
- Codex and Claude Code loop runners. They still get Grimoire and triggers, but the first runner is Pi-only.
- A full radar redesign. The first radar work is only the live lead -> helper tree and metric line.

## Failure modes and how they surface

| Failure | Surface it this way |
|---|---|
| State file missing, invalid or stale | Block the graph and show the validation error. |
| Grimoire unreadable | Block before advisors run; no fail-open loop. |
| Advisor returns prose instead of fields | Block the advisor result and show the raw output. |
| Kyle has unanswered questions | Stage is `needs-kyle`; no build starts. |
| Red run was not recorded | Block verification; tests were not proven first. |
| Tests changed after approval | Rework event: likely execution slip or anti-gaming, PR gate closed. |
| Verifier misses the goal but tests pass | Rework event: gap in the check. |
| Same rework class repeats | Stop and ask Kyle one question. |
| Radar cannot see a helper | Show unknown helper state; do not pretend the tree is complete. |

## How to prove it

Use red-then-green tests with a new scripted model fixture, `test/fixtures/loop-model.ts`.

1. Pure state tests: state creation, advisor sections, stage transitions, invalid report blocking, and Grimoire-unreadable
   blocking.
2. Brief tests: intent, codebase and test-design reports merge into one brief; Kyle's answers and limits travel into
   the build brief.
3. Red-run test: test-design records the failing acceptance run before build; missing red evidence blocks build or
   verify.
4. PR gate test: `gh pr create` is blocked until state is `passed`, including a repeat call that today's trigger would
   otherwise allow.
5. Rework classification tests: each class writes the right proposal shape into `proposals/`, except genuine new
   information, which is not counted as avoidable rework.
6. Anti-gaming tests: weakened tests, faked or missing logs, and repeated "new info" classifications stay blocked or
   visible.
7. Real Pi e2e: run `pi --mode rpc --no-extensions` with the loop extension and fake model; verify advisor reports,
   Kyle approval, build, check, classification, handover/continue, and final reply.
8. Radar test: snapshot shows the lead -> helper tree plus first-pass, rework mix and token line, with no mutation power.

Stub the module first so these tests run and fail on assertions, then implement only enough behavior to make them pass.

## Open questions for Kyle

1. **Which advisors ship first?** Recommendation: intent, codebase and test-design.
2. **Does Kyle see only the questions or the whole brief?** Recommendation: show questions and the high-level plan by
   default, with the full brief one command away.
3. **What does "first-pass accepted" mean?** Recommendation: track both agreed tests passed first time and Kyle accepted
   or merged without rework.
4. **Who can classify a rework event?** Recommendation: model drafts the class, verifier evidence is attached, Kyle can
   override it during proposal review.
5. **When should optional risk or ops advisors run?** Recommendation: only when paths, Grimoire entries or Kyle's ask
   mention runtime, rollout, safety, data loss, rate limits, logs or production operations.
6. **Should state ever live in the application repo?** Recommendation: not first. Keep it in the sitra profile so public
   repos do not get private process files.
