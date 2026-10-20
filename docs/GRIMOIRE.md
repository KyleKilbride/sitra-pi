# Grimoire: one approved brain for every agent

Grimoire replaces the per-repo knowledge base (`/kb`, `.pi/knowledge`). It is one folder of plain markdown per person,
shared by every agent they run (Pi, Claude Code, Codex), across every project. Agents propose; only the person
approves. sitra ships the machinery and an empty starter; what goes in it is the person's own and never leaves their
machine.

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

## Entry format (sitra-kb-v1 plus three fields)

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
---

Body: what to know and why, in a few sentences.
```

Values are one line each, JSON style. Old `/kb` entries parse unchanged; the new fields are optional.

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
4. Agents never write to `root/` or `kinds/`.

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
- **Rules at the moment of action.** Most corrections are about what an agent did partway through: opening a pull
  request, running a whole test suite, editing shared code. A rule tied to that action (a tool-call hook in Pi, Claude
  Code or Codex) could land exactly when it matters. That's the most promising next step.
- **Embeddings or a search service.** Search is BM25 for now; a different ranker can sit behind the same function
  without changing the files.
