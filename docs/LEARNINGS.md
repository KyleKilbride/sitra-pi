# Learnings: mistakes not to repeat

Each of these was found the hard way while building sitra and using it on real work. Check here before changing
how agents run, hand back, or wait.

## Agents and teammates
- **Typing into a teammate's pane permanently turns off its auto-exit** (pi-subagents). The teammate then never hands
  back. One hand-off took 52 minutes because of it. Steer teammates only through the subagent tools.
- **Interactive teammates need `auto-exit: true`**, or they finish and never return their report.
- **Never give teammates the lead's rules.** `lead.ts` checks `PI_SUBAGENT_NAME`.
- **Limits must travel with the work.** A builder told to "run the relevant checks" ran a 30-minute full unit suite,
  because a context file listed that command. The lead puts "no full suites unless asked" into every task.

## Prompt size
- A workspace-level `CLAUDE.md` above the repo added 11k characters to every agent and told them to run full suites.
  `lead.ts` drops context files from outside the repo and the profile.
- About 70 skills put roughly 45k tokens into the prompt before any work. Use the `skills` allowlist in
  `~/.sitra/config.json`.

## Waiting and long runs
- **Agents that sleep or poll waste hours.** A broken helper extension (pi-herdr 0.4.0 against herdr 0.9.1) made
  agents fall back to `sleep 60` loops. `run_in_pane` returns at once, and the extension, not the model, watches the run.
- **`PIPESTATUS` is bash-only.** herdr panes run the person's shell (often zsh), so the exit code came back blank.
  `paneCommand` always wraps the run in `bash -c` (a zsh test covers it).
- **Pi opens a new agent run before delivering a `triggerTurn` message.** The order is `agent_start`, then the custom
  message, then the reply. Test for an assistant reply after the message, not for `agent_start` after it.

## Questions
- The question tool's built-in guidance allows up to 4 questions and "(Recommended)" labels. sitra's guidance file
  asks one question at a time, with the context inside the question.

## Knowledge
- An empty knowledge base helps no one. If proposals are never reviewed, agents relearn the same things. Review with
  `/grimoire` early; "Accept this and all the rest" exists for a backlog.
- **You can't predict from a task which rule an agent will break.** On 38 real corrections, picking entries from the
  opening message (by keyword search, or by a model reading the catalogue) found the rule that was later broken only
  1 time in 3, and 9 of 10 picks were wrong. The always-loaded root covered most cases. Put rules that apply to all
  work in the root; don't auto-inject entries per message.
- **Background checks should pick accuracy over speed.** To spot when the person corrects an agent, a mid-size model
  (4.7 s) caught 54 of 59 real corrections with 1 false alarm, where fast decision models (0.1-0.2 s) caught about 40.
  The check runs after the message, in the background, so its speed costs nothing.
