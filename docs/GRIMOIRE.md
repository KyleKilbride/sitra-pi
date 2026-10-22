# Grimoire: one approved brain for every agent

Grimoire replaces the per-repo knowledge base (`/kb`, `.pi/knowledge`). It is one folder of plain markdown per person,
shared by every agent they run (Pi, Claude Code, Codex), across every project. Agents propose; only the person
approves. sitra ships the machinery and an empty starter; what goes in it is the person's own and stays in their
private folder (agents and the background learner read it through the person's own model provider).

## Why it replaced `/kb`

- **One brain, not one per repo.** How someone works, their review rules and their hard-won lessons apply in every repo.
  Per-repo knowledge bases split that up, and every new repo started empty.
- **Every tool, not only Pi.** People switch between Pi, Claude Code and Codex. The same entries reach all three.
- **A size limit on everything that's always loaded.** `/kb` put every title into every prompt with no limit. Grimoire
  caps the root and the one-line catalogue; past the cap, agents search.

## Layout

```
<profile>/grimoire/            (default ~/.sitra/profile/grimoire, or $SITRA_GRIMOIRE)
  root/        always loaded: a short, high-level picture (who, what, the big decisions, how the person works)
  kinds/       approved entries: decisions/ facts/ lessons/ setups/ warnings/
  proposals/   waiting for the person; agents only ever write here
  rejected/    turned down, kept so nobody proposes them again
```

Anything else in the folder (research notes, evals, tools) is ignored by sitra.

## Entry format (sitra-kb-v1 plus four fields)

```yaml
---
kind: "lesson"                      # decision | fact | lesson | setup | warning
title: "Read the eval failures before claiming anything"
date: "2026-10-19"
proposedBy: "agent"
evidence: "link, file:line or command output"
summary: "One plain sentence: what to do and when."         # new: shown in search results
tags: ["evals", "debugging"]                                   # new: what it's about
links: ["kinds/decisions/2026-10-19-some-rule.md"]             # new: related entries, paths from the Grimoire folder
when: ["command:gh pr create", "tool:bash + command:pnpm test"] # new: actions that bring this entry up (below)
---

Body: what to know and why, in a few sentences.
```

Values are one line each, JSON style. Old `/kb` entries parse unchanged; the new fields are optional.

## Rules tied to actions (`when`)

Most mistakes happen partway through the work, at a concrete action: opening a pull request, running a test suite,
editing an eval, starting a helper. An entry with `when` triggers reaches the agent at exactly that moment.

- A trigger is one or more conditions joined by ` + `, all of which must hold:
  - `command:<words>`: a shell command in the call starts with these words. Every command of a chain (`&&`, `;`, `|`)
    counts; leading `VAR=value`, `env`, `time`, `timeout N` and the like are skipped, and so are flags the trigger
    doesn't name (`pnpm -s exec vitest` matches `command:pnpm exec vitest`).
  - `path:<glob>`: a file the call reads or writes matches, relative to the working folder or absolute; a pattern with
    no `/` matches the file name. Files written from the shell (`> f`, `>> f`, `tee f`, `sed -i`) count.
  - `tool:<name>`: the tool, with names shared across tools (`bash`, `read`, `edit`, `write`, `subagent`).
- **Pause once.** The first matching action in a session is paused, and the agent gets the rules word for word with
  "run it again unchanged if it follows them". The repeat goes through, and those rules don't pause that session again.
  A pause costs one model step; on 142 real sessions a well-trimmed set paused a median of once per session.
- **Every tool, one matcher.** `extensions/triggers.ts` is shared by Pi's `tool_call` handler (helpers included) and
  the Claude Code and Codex `PreToolUse` hooks that `sitra grimoire install` adds. Hooks remember what a session has
  seen in `<grimoire>/.sitra/shown/`. About 2 ms per call in Pi and 60 ms per hook process.
- **Keep triggers narrow.** A rule that would pause nearly every session belongs in the root instead.
- **Measure it.** `sitra grimoire eval <cases.jsonl>` replays real tool calls (`id`, `harness`, `cwd`, `calls`,
  `expect` per line) and reports which corrections a trigger would have caught and how many pauses it costs.

## What an agent gets

| | What | How big |
|---|---|---|
| Always | Every file in `root/`, frontmatter removed, README first | Capped at 32,000 characters, including the "cut off here" note; the status line warns when the root is over |
| Always | The catalogue: one line per approved entry (kind, title, summary, path), warnings first, newest first | Capped at 12,000 characters; past that, a count of the rest and how to search for them |
| Always | How to search and how to propose | A few lines |
| On demand | Search (`grimoire_search` in Pi, `sitra grimoire search` in the shell) | One line per match |

The agent reads an entry in full when the work touches it. Nothing is added per message.

**Why no automatic per-message picks.** We replayed 38 real moments where the person had to correct an agent. For each,
we checked whether picking entries from the task as first asked would have delivered the rule the agent later broke.
Keyword search (BM25 over title, tags, summary and body) found it 9 times out of 27; a model choosing from the
catalogue also found it 9 times out of 27. Both added about three entries per message, and roughly 9 in 10 were not
the one that mattered. Mistakes happen partway through the work, so the opening message rarely predicts them. The
always-loaded root already held the broken rule in 26 of the 30 cases that had one. So: rules that apply to all work
belong in the root, and the catalogue lets the agent open the rest when the work gets there.

**Cache-friendly.** The root and catalogue live in the system prompt and only change when Grimoire changes, so the
cached prompt prefix survives from turn to turn.

## How each tool loads it

| Tool | Root | Catalogue |
|---|---|---|
| Pi (sitra) | system prompt section, every run | same section |
| Claude Code | `@` import of `<grimoire>/.sitra/root.md` in a sitra-managed block of `~/.claude/CLAUDE.md` (hook text is capped at 10,000 characters; imports are not) | `SessionStart` hook (startup, resume, clear, compact), kept under 9,500 characters |
| Codex | `SessionStart` hook | same hook; at most 46,000 characters, with `additionalContextLimit` set at 2 characters per token so it always fits |

- `<grimoire>/.sitra/root.md` is the capped root as one file. Claude Code's session-start hook and every sitra session
  start rewrite it when the root changes, so root files approved later reach Claude Code too.
- The hook command carries the Grimoire folder it was installed with (`--dir`), because Claude Code and Codex don't
  have sitra's environment. The person's name comes from `~/.sitra/config.json`.
- `sitra grimoire install` adds all of this; `sitra grimoire uninstall` removes it. They change only sitra's own hook
  (recognised by its exact command: the quoted `bin/sitra.ts`, then `grimoire hook`) and the marked CLAUDE.md block,
  which is replaced where it sits. A hooks file that isn't a settings object is refused, never rewritten.
- Codex asks the person to trust new hooks once, in `/hooks`.

## The approval loop

1. An agent learns something future agents need and calls `grimoire_propose` (kind, title, summary, tags, links, body,
   evidence). It lands in `proposals/`.
2. The person reviews with `/grimoire`: Accept, Reject, Skip, "Accept this and all the rest", Stop.
   Accepted entries move to `kinds/<kind>s/`; rejected ones to `rejected/`.
3. `/grimoire-reflect` asks the agent to look back over the session and propose at most three entries. Lessons follow
   the shape: what failed, the verified cause, the fix, whether it held, what would catch it next time.
4. `/grimoire-ui` opens a local browser page (`127.0.0.1` on a random port, with a one-time URL token and a `Host`
   header check) for viewing and editing Grimoire by hand: the exact prompt text agents get, root and catalogue sizes
   against their limits, Claude Code and Codex hook status, editable root files, approved entries (add, edit, move
   between kinds, delete to `rejected/` with broken-link repointing or removal), proposals waiting, rejected entries
   (with restore), and the day's log of pauses, corrections and repeats.
5. Agents never write to `root/` or `kinds/`.

## Learning from corrections

Nobody has to remember to reflect. Every message the person types into Pi's interactive input is recorded as a moment,
including text typed while the agent is busy; extension and RPC input is ignored. Claude Code and Codex use the
`UserPromptSubmit` hook that `sitra grimoire install` adds. Each moment keeps the person's words, the agent's last
reply and its last 12 tool calls. Recording takes a few milliseconds (2.5 ms median, 11 ms worst, on a 97 MB
transcript). A detached `sitra grimoire learn` then does the rest in the background:

1. asks a model whether the message corrects the agent (only a bare YES counts);
2. if it does, drafts the missing rule from the person's own words, with a `when` trigger when the mistake happened at
   a recognisable action, and writes it to `proposals/` as `proposedBy: "sitra-learn"`, quoting the person as
   evidence. If Grimoire already covers it, it records that instead of proposing a duplicate.

The person only reviews `/grimoire`; the status line counts what's waiting. Agents can also put `when` triggers in
their own `grimoire_propose` calls.

- **Model:** `google/gemini-4-argon` by default (`learnModel` in `~/.sitra/config.json`, or `SITRA_LEARN_MODEL`).
  On 183 labelled real messages (59 corrections) it caught 54 corrections with 1 false alarm; Claude Haiku 52 with 7;
  fast decision models (OpenAI Decisions, TypeSafe Jev) about 40-43 with 4. It runs in the background, so accuracy
  matters more than speed.
- **Tally:** the status line shows `today: N caught · N learned · N repeats`. Caught: a rule paused an agent and its
  next turn changed course. Learned: a correction became a new proposal. Repeats: a correction Grimoire already had a
  rule for, which means the rule didn't reach the agent in time. `/grimoire` walks through repeats after proposals:
  dismiss one, or ask the agent how to make that rule land (a trigger, sharper wording, or the root).
- **Off switch:** `"learn": false` in `~/.sitra/config.json` (or `SITRA_GRIMOIRE_LEARN=0`).
- **Known gap:** the tower's first message to a spawned worker is still delivered to that worker as interactive input,
  so it can still be recorded as if the person typed it.
- **Privacy:** moments stay in `<grimoire>/.sitra/moments/`. A message judged not to be a correction keeps only its
  verdict. To decide and draft, the learner sends the message, the agent's last reply and (for corrections) its recent
  tool calls to the configured model, the same provider the person's agents already use.
- **It measures itself.** Each recorded correction is a replay case: `sitra grimoire eval` (no file) replays them
  through the triggers, and a case's expected entry is its proposal once accepted. After every trigger pause, the
  agent's next call is recorded: a different call means the rule changed its course, the same call means it already
  complied or ignored it. `sitra grimoire status` shows both per rule, so noisy triggers are visible.

## Moving off `/kb`

- `sitra grimoire import [repo]` copies a repo's `.pi/knowledge` entries (approved and proposed) into
  `proposals/`, skipping any whose title already exists anywhere in Grimoire. It never deletes the old folder.
- When a session starts in a repo that still has a `.pi/knowledge` folder that hasn't been imported, the status line
  says so.
- `/kb` and `/kb-reflect` still work for now and point to `/grimoire`.

## How we know it works

Replay real corrections: for each moment the person had to correct an agent, record the task as first asked and the
entries that would have prevented the mistake. A case is covered when the rule is in the root, or when the agent
opened the entry from the catalogue. Cases with no matching entry are gaps: they're what to propose next. Rerun it
when the root or the loading changes.

## Not now

- **Per-message injection.** Measured above: mostly the wrong entries. Revisit with a better signal than the opening
  message.
- **A per-step picker** (a fast decision model such as TypeSafe's Jev, used as their docs advise: one Choice over the
  rules, then a check of the shortlist) for judgment mistakes no trigger can see. On 34 labelled corrections it found
  the right rule in its top 3 about 10 times, against 15 for the best general model, in a quarter of a second. Optional,
  behind one interface, off by default.
- **Embeddings or a search service.** Search is BM25 for now; a different ranker can sit behind the same function
  without changing the files.
