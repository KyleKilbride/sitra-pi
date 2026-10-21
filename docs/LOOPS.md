# First agent loop

Kyle's goal is agent loops and graphs he can trust. For the first piece, that means a lead agent can run a bounded
build -> review -> fix loop with scout, builder, reviewer and app-tester teammates, while the important context survives
compaction and every hand-off.

This is not a new graph framework. It is one thin Pi extension in the lead session, using the pieces sitra already has:
teammates, Grimoire, helper briefs, handovers, `run_in_pane`, radar and the tower. The tower still watches and carries
mail; it never assigns work on its own.

## What success looks like

The first useful slice should handle a coding task that already has a clear goal and "done" condition:

1. The lead writes a short plan and gets Kyle's go, as it does today.
2. The loop runner creates one state file for the current worktree and records the goal, done condition, Kyle's limits,
   approved plan and current stage.
3. Each step starts a fresh teammate with a short brief built from that state file. The teammate gets Kyle's limits, the
   relevant Grimoire context and the current hand-off.
4. The builder may build, but never approves its own work.
5. A fresh reviewer must read the original brief, diff and test output, then return a verdict.
6. A clean reviewer pass is required before the lead opens a pull request.
7. If review fails, the loop allows at most two fix rounds. After that it stops, explains the blocker and asks Kyle for
   direction. It never removes a check, weakens a test or hides a failed verification to get a pass.
8. Radar shows the lead and its live helper steps as a small tree, so Kyle can see what is running and what is waiting.

The loop is opt-in. It should help when the task has a clear verification surface; it should not force every prompt into
a scout -> build -> review -> test chain.

## What exists today

The design builds on these current pieces:

- **Lead rules and teammates.** `extensions/lead.ts` gives only the lead its rules. Those rules already say to plan
  first, avoid blocking, pass Kyle's limits to teammates and steer teammates only through subagent tools. The teammate
  profiles live in `templates/profile/agents/`: scout and reviewer are read-only, builder makes narrow edits, and
  app-tester uses Chrome like a real user.
- **Visible long runs.** `extensions/lead.ts` registers `run_in_pane` and `check_run`; `extensions/runs.ts` records the
  command, owner metadata, full log and exit marker. The model does not sleep or poll.
- **Grimoire everywhere.** `extensions/knowledge.ts` injects the Grimoire root and catalogue in every Pi session,
  including helpers, and wires action triggers through `extensions/triggers.ts`. Correction learning is lead-only.
- **Sharpen and handover.** `extensions/sharpen-pi.ts` stubs old tool output, appends the helper brief to subagent
  tasks and writes structured handovers at the run boundary and mid-run. `docs/SHARPEN.md` describes the current
  behavior.
- **Reviewer shape.** `templates/profile/agents/reviewer.md` already tells the reviewer to judge the diff, tests and
  evals, to check that tests really prove the behavior, and to report blockers, majors and minors.
- **Reply check.** `extensions/replycheck-pi.ts` uses `agent_before_settle` to correct stale GitHub PR claims before a
  final reply.
- **Tower and radar.** `extensions/tower.ts` records sessions, delivers inbox messages only between steps and alerts on
  waiting, stopped, repeated tool errors and stalls. `extensions/radar.ts` and `extensions/radar-view.ts` show workspaces
  and active helper counts today; they do not yet show the lead -> helper tree.
- **Scripted fake-model tests.** The `test/*.e2e.test.ts` files start a real `pi` in RPC mode with fixtures such as
  `test/fixtures/midrun-model.ts`, so the loop can be proven without a real provider or API key.

What is missing is the runner itself: no state file, no required fresh reviewer, no round counter, no PR gate and no
owner that continues after a helper step or a handover.

## Design

### Components

**Lead loop extension.** Add a Pi extension that is active only in the lead, not in teammates or the tower. It exposes a
small command or tool, for example `start_loop`, that the lead calls after Kyle approves the plan. The extension owns the
loop state and step transitions; the lead remains the user-facing agent.

**Loop state file.** Each worktree gets one JSON state file. JSON is deliberate: the runner can parse it, validate it and
reject partial writes instead of treating prose as meaning. The first location should be under the sitra profile, keyed by
the worktree path or branch, so application repos do not get private process files unless Kyle approves that later.

Example shape:

```json
{
  "version": 1,
  "worktree": "/path/to/worktree",
  "branch": "cursor/example",
  "goal": "Kyle's words, quoted where they matter",
  "done": ["Observable behavior or test evidence required"],
  "limits": ["No full unit-test or eval suites unless Kyle asks", "Never remove a check to get a pass"],
  "decisions": [{ "at": "2026-10-21T19:00:00Z", "decision": "Use a reviewer gate", "reason": "Builder cannot judge itself" }],
  "plan": ["Small approved steps"],
  "stage": "build",
  "round": 0,
  "maxFixRounds": 2,
  "lastStep": {
    "agent": "builder",
    "status": "passed",
    "summary": "What changed",
    "evidence": ["test command and exit code", "run log path"]
  },
  "review": {
    "status": "failed",
    "verdict": "blocker",
    "findings": ["Specific issue to fix"],
    "requiredEvidence": ["What must be rerun"]
  }
}
```

Valid stages are small and explicit: `planned`, `build`, `review`, `fix`, `app-test`, `passed`, `blocked`. Stage changes
come from structured step results, not regex over assistant prose. If a result cannot be parsed, the runner marks the
state `blocked` and shows the raw report to the lead.

**Step runner.** A step is one fresh teammate call. Before starting it, the runner reads the state file, builds a brief
and writes the step id into the state. When the teammate returns, the runner records the report and decides the next
stage. If the session hands over or compacts, the next lead turn reads the same file before doing anything else.

**Radar tree.** The session registry already knows leads, teammates and runs. The first radar change should expose a
simple tree: lead -> current loop -> builder/reviewer/app-tester step, plus the run log if a step started one. This is
inspection only; radar does not control the loop.

### Step lifecycle

1. **Plan and start.** The lead gets Kyle's approval, then starts the loop with the goal, done condition, limits and
   plan. The runner writes state before any helper starts.
2. **Brief.** The runner builds a short helper brief from:
   - the state file;
   - Kyle's latest request and standing limits;
   - the Grimoire root and catalogue already in the helper prompt;
   - any Grimoire entries the lead explicitly opened or that triggers surfaced;
   - the previous reviewer verdict when this is a fix round.
3. **Build or fix.** Builder receives a narrow task and the evidence it must leave behind. If it needs a design
   decision, it stops and reports instead of guessing.
4. **Verify.** The lead or builder runs only targeted checks through `run_in_pane`. The state records command, log path
   and exit code. A failed check is evidence, not something to route around.
5. **Review.** Reviewer starts in a fresh context with the original goal, done condition, approved plan, diff summary,
   test output and all current limits. It returns a structured verdict.
6. **Pass or fix.** A clean pass moves the state to `passed`. A failed review moves to `fix` if the cap allows it, or
   `blocked` if the cap is spent.
7. **PR gate.** The lead may open a draft PR only from `passed`. If the state is missing, stale or blocked, the runner
   refuses the gate and explains why.

### Reviewer contract

The reviewer is the critic, not a second builder. Its brief should say:

- judge the actual diff and test evidence against the original goal and done condition;
- confirm each new or changed test would fail without the fix and passes with it;
- call out skipped, weakened or removed checks;
- classify findings as blocker, major or minor with file and line references when possible;
- return one of `pass`, `fail` or `blocked`, with required follow-up evidence.

Only `pass` clears the PR gate. `blocked` means the reviewer could not inspect enough evidence; it should surface as a
human-visible block, not as approval.

### Cap and escalation

The default cap is two fix rounds after the first review. Two is small enough to prevent wandering and large enough to
catch the common "fix the finding, review again" path. On the cap:

- write the final reviewer finding and failed evidence into the state;
- stop starting new helpers;
- tell Kyle what is blocking the loop and what options exist;
- ask one clear question.

The runner must treat "remove the failing test", "skip the check", "lower the assertion" and similar moves as blockers
unless Kyle explicitly changes the task. This should be enforced through the reviewer contract and through tests that
prove a weakened check does not pass the gate.

### Grimoire and helper brief

The first loop should not add a new automatic memory picker. That was measured and rejected in `docs/GRIMOIRE.md`:
opening-message relevance was weak, while root, catalogue and action triggers carried the useful rules. The loop should
instead make existing context harder to lose:

- put Kyle's goal, done condition and limits in the state file;
- include those fields in every helper brief;
- include the latest reviewer verdict on fix rounds;
- let existing Grimoire root, catalogue and triggers keep working in every helper;
- record any explicit Kyle decision into the state before the next step starts.

## Out of scope for the first piece

- A LangGraph-style DSL or runtime.
- A tower that dispatches work or starts fix rounds by itself.
- Mandatory scout -> build -> review -> test routing for every user request.
- Parallel builders, voting reviewers or graph optimization.
- A new memory ranker or embeddings service.
- Automatic merge, auto-merge or non-draft PR creation.
- Codex and Claude Code loop runners. They still get Grimoire and triggers, but the first runner is Pi-only.
- A full radar redesign. The first radar work is only the live lead -> helper tree.

## Failure modes and how they surface

| Failure | Surface it this way |
|---|---|
| State file missing, invalid or stale | Refuse to continue the loop, mark it blocked and show the parse or freshness error. |
| Helper exits without a structured result | Keep the raw report, mark the step blocked and ask the lead to classify it. |
| Builder changes scope or needs a decision | Stop the step and ask Kyle one question; do not let the loop invent the decision. |
| Tests fail | Record command, exit code and log path; review cannot pass until the agreed evidence is clean or Kyle changes the goal. |
| Reviewer cannot inspect the diff or evidence | Verdict is `blocked`, not `pass`. |
| Reviewer finds a blocker after the cap | Stop and ask Kyle; no further fix helper starts. |
| A check is skipped, weakened or removed | Reviewer reports a blocker; PR gate stays closed. |
| Handover or compaction happens mid-loop | The next turn reads the state file first and continues from the recorded stage. |
| Grimoire is unreadable | Existing behavior fails open for the prompt, but the loop state should record that context was missing and block reviewer pass if the brief required an entry. |
| Radar misses a helper | The loop still runs from the state file; radar shows an "unknown helper state" note instead of pretending the tree is complete. |

## How to prove it

Use red-then-green tests with the existing scripted fake model pattern.

1. **Pure state tests.** Start with failing tests for state creation, stage transitions, cap behavior and parse failures.
   These should live beside the pure loop module and should not start Pi.
2. **Brief tests.** Assert that every builder, reviewer and app-tester brief contains the goal, done condition, Kyle's
   limits, current stage and previous reviewer verdict. Assert that missing required fields block the step.
3. **Reviewer gate tests.** Script a reviewer `fail`, then `pass`; prove the PR gate is closed before pass and open
   after pass. Script a weakened-check report and prove it stays closed.
4. **Cap test.** Script builder -> reviewer fail -> fix -> reviewer fail -> fix -> reviewer fail. The expected green
   behavior is `blocked` with one clear Kyle question and no third fix helper.
5. **Compaction/continue e2e.** Add a `test/fixtures/loop-model.ts` like `midrun-model.ts`: force a handover, have the
   next turn read the state and continue from the saved stage.
6. **Real Pi e2e.** Start `pi --mode rpc --no-extensions` with the loop extension plus the fake model, as existing
   e2e tests do. Verify the event order: state write, helper step, review, blocked/pass, and final lead reply.
7. **Radar test.** Extend the radar snapshot test to show a lead with current loop children, without giving radar any
   ability to mutate the loop.

The red phase should stub the module enough that tests run and fail on assertions, not on imports. The green phase then
implements only enough runner behavior to pass those tests.

## Open questions for Kyle

1. **Where should the state file live?** Recommendation: store it in the sitra profile, keyed by worktree path and
   branch. That keeps private process state out of public repos while still surviving compaction and helper hand-offs.
2. **Is two fix rounds the right cap?** Recommendation: use two by default, with a per-loop override only when Kyle says
   so before the loop starts.
3. **Should app-tester be required before every PR?** Recommendation: no. Require it only when the done condition is
   user-visible behavior or the lead marks browser evidence as required. Pure CLI or library changes can pass with
   targeted tests plus reviewer approval.
4. **What should happen when the reviewer returns minor issues only?** Recommendation: let the lead decide whether they
   are PR-blocking, but record that decision in the state before opening the PR.
5. **Should the runner write into the application repo later?** Recommendation: not for the first slice. If Kyle later
   wants portable loop state per branch, add an explicit repo-local option after the profile-backed version works.
6. **Which model should reviewer use?** Recommendation: keep the current reviewer profile default for the first slice.
   The trust boundary is the fresh context and contract, not a new model choice.
7. **Should the loop start itself when it sees a coding task?** Recommendation: no. The lead should choose it after the
   plan is approved, because the loop is useful only when the task has a clear done condition and evidence.
