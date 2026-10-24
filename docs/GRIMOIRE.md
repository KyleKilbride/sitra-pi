# Grimoire: one approved store for every agent

Grimoire replaces the per-repo knowledge base (`/kb`, `.pi/knowledge`). It is one store of plain markdown per person,
shared by every agent they run (Pi, Claude Code, Codex). Entries are global by default; an entry or root file can be
scoped to one or more projects, and a session sees global entries plus its own project's. Agents propose; only the
person approves. sitra ships the machinery and an empty starter; what goes in it is the person's own and stays in their
private folder (agents and the background learner read it through the person's own model provider).

## Why it replaced `/kb`

- **One store, global by default.** How someone works, their review rules and their hard-won lessons apply in every
  repo. Per-repo knowledge bases split that up, and every new repo started empty. So an entry is global unless it is
  scoped to a project, and facts that only hold in one repo stay out of the others.
- **Every tool, not only Pi.** People switch between Pi, Claude Code and Codex. The same entries reach all three.
- **A size limit on everything that's always loaded.** `/kb` put every title into every prompt with no limit. Grimoire
  caps the root and the one-line catalogue; past the cap, agents search.

## Layout

```
<profile>/grimoire/            (default ~/.sitra/profile/grimoire, or $SITRA_GRIMOIRE)
  root/          always loaded: a short, high-level picture (who, what, the big decisions, how the person works);
                 files without `scope` are the global root, files with `scope: ["app"]` are app's root
  kinds/         approved entries: decisions/ facts/ lessons/ setups/ warnings/
  proposals/     waiting for the person; agents only ever write here
  rejected/      turned down, kept so nobody proposes them again (in any project)
  projects.json  the projects: { "projects": [{ "id": "app", "label": "App", "remotes": ["github.com/example/app"], "paths": [] }] }
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
scope: ["app"]                                                # optional: project ids; no scope means global
---

Body: what to know and why, in a few sentences.
```

Values are one line each, JSON style. Old `/kb` entries parse unchanged; the new fields are optional. `scope` must be a
non-empty JSON list of project ids. There is no magic value: `scope: []` and `scope: ["global"]` are refused, and the
file is reported as unreadable (in the status line and in `/grimoire`), never loaded as global. Leave `scope` out to make
an entry global. Keys sitra doesn't know are kept as they are when an entry is rewritten.

## Which project a session is in

1. sitra finds the main checkout of the session's folder (so every worktree and subfolder of a repo counts as the same
   checkout), then every git remote of it, normalized: `https://github.com/Example/App.git`,
   `git@github.com:example/app.git` and `ssh://git@github.com:22/example/app` are all `github.com/example/app`.
2. The project whose `remotes` lists one of them is the session's project. If `origin` matches a project, that project
   wins, and the status line warns which other remote matched which other project. If `origin` matches none (or there
   is no `origin`) and two other remotes match different projects, it's ambiguous: global only, and the status line
   names them. One other remote matching one project is a plain match.
3. Otherwise, a project whose `paths` explicitly lists the checkout. Folders are never matched by name.
4. Otherwise there is no project and the session loads global entries only. The status line says why: not in a git
   repository, no remote, or a remote not attached to any project. A `projects.json` or remote that can't be read is
   shown the same way, and as a warning, never skipped quietly.

**The project is fixed when the session starts.** A `cd` into another repo partway through (`cd ../tools && …`), or a
tool call on files there, doesn't switch it. Rules for the other repo need a session started there. With no
`projects.json` (or no projects in it), nothing is scoped and everything works as it did before projects.

Pi sessions, the Claude Code and Codex hooks, the learner, LOOPS rework proposals (from the loop's worktree) and
`sitra grimoire` all resolve the project the same way. A hook session resolves it at `SessionStart` from the hook's
`cwd` and keeps it in `<grimoire>/.sitra/shown/<session>/project.json`, so later hooks in that session use the same
project. A hook input with no `cwd` gets global entries only, and the hook text says why.

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
| Always | The global root: every unscoped file in `root/`, frontmatter removed, README first | Capped at 26,000 characters when the session has a project (at 32,000 without one), including the "cut off here" note |
| Always | The project's root: the files in `root/` scoped to the session's project, under a `## Root for <label>` heading | Capped at 6,000 characters; global and project root together stay within 32,000 |
| Always | The catalogue: one line per approved entry the session sees (global plus its project's), warnings first, newest first | Capped at 12,000 characters; past that, a count of the rest and how to search for them |
| Always | How to search and how to propose | A few lines |
| On demand | Search (`grimoire_search` in Pi, `sitra grimoire search` in the shell): global plus the project's entries; `allProjects: true` searches every project, each line labelled with its scope | One line per match |

A part over its cap ends with "cut off here, read the rest in `<path>`", and the status line warns per part (`global
root over its limit`, `App root over its limit`). The section heading counts both kinds (`3 global + 2 for App`), or
says "no project here, so global only" and why. Links between entries never load their target: a global entry linking
to an entry of another project shows only the path, and `linkReport` lists such links, and missing targets, without
loading anything.

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
| Claude Code | `@` import of `<grimoire>/.sitra/root.md` in a sitra-managed block of `~/.claude/CLAUDE.md` (hook text is capped at 10,000 characters; imports are not). With projects in use the import is the global root only, and the project's root comes from the hook | `SessionStart` hook (startup, resume, clear, compact), kept under 9,500 characters. With projects in use the global catalogue is in the import and the hook carries the project's |
| Codex | `SessionStart` hook (startup, resume, clear, compact, fork): global and project root | same hook; at most 46,000 characters, with `additionalContextLimit` set at 2 characters per token so it always fits |

- `<grimoire>/.sitra/root.md` is the capped root as one file. Claude Code's session-start hook and every sitra session
  start rewrite it when the root changes, so root files approved later reach Claude Code too. With no projects it is
  the whole root (32,000 characters); with projects it is the global root (26,000) plus the global catalogue.
- When a project's entries don't fit Claude Code's hook budget, the hook steps down and says so: full lines, then
  titles only, then as many titles as fit followed by "…and N more" pointing at
  `<grimoire>/.sitra/catalogues/<project>.md`, which holds every line. Nothing is cut silently.
- The hook command carries the Grimoire folder it was installed with (`--dir`), because Claude Code and Codex don't
  have sitra's environment. The person's name comes from `~/.sitra/config.json`.
- `sitra grimoire install` adds all of this; `sitra grimoire uninstall` removes it. They change only sitra's own hook
  (recognised by its exact command: the quoted `bin/sitra.ts`, then `grimoire hook`) and the marked CLAUDE.md block,
  which is replaced where it sits. A hooks file that isn't a settings object is refused, never rewritten.
- Codex asks the person to trust new hooks once, in `/hooks`.
- `sitra grimoire status` (and `/grimoire-ui`) check the installed hooks: a `SessionStart` matcher that leaves out a
  source (an older install without Codex's `fork`, say) is reported as missing it, with a reminder to rerun install.

## The `sitra grimoire` commands

- `search <words>`, `eval [cases.jsonl]` and `status` use the project of the current folder and print which one they
  used and why (or why there is none). `--project <id>` picks one, `--global-only` drops project entries, and `--all`
  covers every project, labelling each line or count with its scope. `eval` with a file and no flag replays every
  case in it.
- `scope <files…> --project <id>…` scopes entries or root files (paths relative to the Grimoire folder) to projects;
  `--global` makes them global again.
- `projects` lists the projects and which one applies here. `projects add <id> --remote <url>` or
  `projects add <id> --path <dir>` (with `--label <name>`) adds one, or adds the remote or path to an existing one.
  Remotes are stored normalized and paths as their real path.

## The approval loop

1. An agent learns something future agents need and calls `grimoire_propose` (kind, title, summary, tags, links, body,
   evidence). It lands in `proposals/`, scoped to the session's project unless the agent passes `scope: "global"`. In a
   session with no project it is global, and the tool's answer says so. When projects exist but none applies (here, or
   in a LOOPS worktree), the proposal records why in `scopeNote`, and the review shows it next to `Scope: Global`.
2. The person reviews with `/grimoire`, which shows each proposal's scope (`Scope: Global` or `Scope: App`): Accept
   (with the scope shown), "Accept as global", "Accept for <current project>", Reject, Skip, "Accept this and all the
   rest" (each keeps its own scope), Stop. Accepted entries move to `kinds/<kind>s/`; rejected ones to `rejected/`.
   A rejection counts in every project, so it isn't proposed again from another.
3. `/grimoire-reflect` asks the agent to look back over the session and propose at most three entries. Lessons follow
   the shape: what failed, the verified cause, the fix, whether it held, what would catch it next time.
4. `/grimoire-ui` opens a local browser page (`127.0.0.1` on a random port, with a one-time URL token and a `Host`
   header check) for viewing and editing Grimoire by hand: the exact prompt text agents get, root and catalogue sizes
   against their limits, Claude Code and Codex hook status, editable root files, approved entries (add, edit, move
   between kinds, delete to `rejected/` with broken-link repointing or removal), proposals waiting, rejected entries
   (with restore), and the day's log of pauses, corrections and repeats.
5. Agents never write to `root/` or `kinds/`.

## Learning from corrections

Nobody has to remember to reflect. Every message the person sends is recorded as a moment: their words, the agent's
last reply and its last 12 tool calls (Pi through the extension; Claude Code and Codex through a `UserPromptSubmit`
hook that `sitra grimoire install` adds). Recording takes a few milliseconds (2.5 ms median, 11 ms worst, on a
97 MB transcript). A detached `sitra grimoire learn` then does the rest in the background:

1. asks a model whether the message corrects the agent (only a bare YES counts);
2. if it does, drafts the missing rule from the person's own words, with a `when` trigger when the mistake happened at
   a recognisable action, and writes it to `proposals/` as `proposedBy: "sitra-learn"`, quoting the person as
   evidence. If Grimoire already covers it, it records that instead of proposing a duplicate.

The moment records the session's project, and the proposal is scoped to it (or global with a `scopeNote` saying why
there was no project). Moments recorded before projects stay global. "Already covered" checks the global entries,
that project's entries, and rejections from every project.

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
- **Privacy:** moments stay in `<grimoire>/.sitra/moments/`. A message judged not to be a correction keeps only its
  verdict. To decide and draft, the learner sends the message, the agent's last reply and (for corrections) its recent
  tool calls to the configured model, the same provider the person's agents already use.
- **It measures itself.** Each recorded correction is a replay case: `sitra grimoire eval` (no file) replays them
  through the triggers, and a case's expected entry is its proposal once accepted. After every trigger pause, the
  agent's next call is recorded: a different call means the rule changed its course, the same call means it already
  complied or ignored it. `sitra grimoire status` shows both per rule, so noisy triggers are visible.

## Moving off `/kb`

- `sitra grimoire import [repo]` copies a repo's `.pi/knowledge` entries (approved and proposed) into
  `proposals/`, skipping any whose title already exists anywhere in Grimoire, in any project. The proposals are scoped
  to that repo's project, or global with a note saying why. It never deletes the old folder.
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
