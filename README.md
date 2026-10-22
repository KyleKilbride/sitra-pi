# sitra

A visible, collaborative agent setup on [Pi](https://pi.dev) (the coding agent) and [herdr](https://herdr.dev)
(a terminal multiplexer for agents). You talk to one **lead**; it hands work to **teammates** that open in panes you
can watch. Long runs never block, and every agent (Pi, Claude Code and Codex) starts with **Grimoire**, one
knowledge base of yours that grows only with your approval.

## Why

Most agent setups either hide the work (headless workers) or flood you with questions. sitra aims for:
- everything visible, in herdr panes;
- one question at a time, short answers, every claim labelled verified, observed or guess;
- nothing "learned" without your approval.

## Get started

You need macOS or Linux, Node 24.12+, and pnpm or npm.

    git clone https://github.com/KyleKilbride/sitra-pi.git
    cd sitra-pi
    ./bin/sitra.ts init

`sitra init` walks you through setup and is safe to run again:
1. Checks Node, **Pi** (1.0.0 or newer) and **herdr** (0.9.1 or newer). It offers to install Pi for you; for herdr it
   tells you where to get it.
2. Asks what your agents should call you.
3. Creates the sitra profile in `~/.sitra/profile` (or `$SITRA_HOME/profile`): your working rules and the teammates.
   It never overwrites files you've edited.
4. Offers to reuse the sign-ins from your normal Pi setup, so you don't log in twice.
5. Installs the Pi packages sitra uses (pinned versions) and herdr's Pi hook, which shows agents' status in herdr.
6. Sets the question tool to ask one question at a time (`~/.config/rpiv-ask-user-question/config.json`, only if
   you don't have one).
7. Links the `sitra` command into `~/.local/bin`, unless something called `sitra` is already there.

Then, inside herdr, in any repo:

    sitra            # start the lead here
    sitra tower      # start your tower (your number 2) watching all sitra sessions
    sitra radar      # open the live keyboard-driven dashboard on its own
    sitra -c         # continue the last conversation in this folder
    sitra -r         # pick a conversation to resume

Any other options pass straight through to Pi. sitra uses its own Pi profile, so your normal `pi` setup is untouched.
On first start, pick your model with `/model` (Pi otherwise picks the first provider you're signed in to).

## What's in it

**The lead** is the agent you talk to in a project folder. It plans, waits for your go, then carries the plan out
without asking per step. It tells you what's starting and what finished.

**The tower** (`sitra tower`) is your number 2: a separate session that watches every running sitra session across all
your projects and worktrees (`list_sessions`, `read_session`), flags when someone is waiting on you or looks off
track, and keeps outside communication from muddying the workers. On its very first launch it asks you to give it a
personal name, and after that both `sitra tower` and `sitra <its-name>` start it. It reads the same Grimoire as the
workers, so it can tell whether a worker is following what you've approved. Inside herdr, starting
the tower (or running `/radar`) opens **sitra radar** in a right-hand pane: a local live dashboard with simple state
icons, scrollable workspaces, a read-only mailbox, and test/build logs. The tower's **Done / Being done / Next** summary
and keyboard controls stay pinned below every view. You can also ask the tower to spin up a new worker (`spawn_session`) in its own herdr workspace and
git worktree (branched from the base branch you choose, with `.env` files copied over, `pnpm i && pnpm run build`, and
an initial grounding prompt so it reads the repo's docs and rules and waits for you to drive it). When the tower adds a
spawn brief to that prompt, it is labelled as the tower's brief and the person's own messages and commands override it.

### Radar controls and data

Focus the radar pane before typing. **↑/↓** or **j/k** select; **Enter** opens the selected worker, message or run.
**1–9** jump to the matching workspace number (not the row number); use arrows and Enter for larger numbers.
Worker jumps focus the lead's tab, not its helper's tab. **m** opens mail, **b** opens runs, **s** opens full status,
and **r** refreshes. **Esc** or **q** goes back one level; **q** at the workspaces view quits radar. **Ctrl-C** quits
from any view. **PgUp/PgDn**, **Home/End** scroll details. The keyboard decoder accepts legacy, application-cursor
and Kitty/CSI-u terminal input. A terminal of at least 20 columns by 12 rows is required for the complete view.

- **Workspaces** use live local session records; icons describe session state, not task completion.
- **Runs** are the latest 30 local logs created by `run_in_pane`, running ones first. Each row names the project and
  branch, agent and session that started it. A run records its shell's process id and, on Linux, the process start
  token from `/proc`, so a reused pid does not keep a dead run looking alive. Older logs without that record are
  stopped after 15 minutes of silence. Enter opens the last 80 output lines, updating while they run. This is not a
  list of every shell process.
- **Status** is derived live: the tower's own `update_radar_status` notes come first, then workers needing you or
  working (with their current task), running runs, open pull requests and open Grimoire proposals. Exact duplicate
  tower notes and live items are shown once. Finished test/build runs do not count as finished work; put verified
  work in the tower notes. Notes older than 30 minutes are tagged with their age, so a stale note can never pass as
  current. Radar never infers that idle means done. **s** reads every entry when the pinned summary is truncated.
- **Mail** rows are one line: incoming first, then sender, subject and a one-line preview. Sent items and items flagged
  `dateApproximate` say "date unknown". Mail is read-only: opening it does not send, acknowledge, consume or mark remote messages read. It refreshes
  a local source about every five seconds. No source is shown honestly as disconnected; errors retain last good
  messages with a visible warning. There is no built-in messaging provider or authentication in this repository.

A private integration can write `sitra-mail.json` in the Pi profile as `{ "items": [...] }`, or configure
`radar-mail-source.json` as `{ "command": "node", "args": ["/path/to/local-mail-reader.mjs"] }`. The latter is an
explicitly trusted local executable, invoked **without a shell**, with a three-second timeout. It must only project
already-local data, never become a second network inbox consumer. It returns `{ "items": [...], "notice": "...",
"updatedAt": "ISO timestamp" }`.

Each mail item must use this documented shape:

```json
{
  "id": "stable adapter id",
  "peer": "sender or recipient label",
  "direction": "in",
  "state": "adapter display state",
  "subject": "message subject",
  "preview": "one-line body preview",
  "updatedAt": "2026-10-21T15:59:00.000Z",
  "dateApproximate": false,
  "delivery": { "confirmed": true, "status": "delivered" },
  "body": "optional full message body"
}
```

`direction` is `in` or `out`. `dateApproximate` is `true` when `updatedAt` is only when the dashboard first saw the
item, not the real sent or received time. `delivery.confirmed` is the structured delivery truth for outgoing mail;
`delivery.status` is the short tag radar shows when delivery is not confirmed or is unknown. `summary` is still
accepted as a backward-compatible subject for old private snapshots, but new adapters should send `subject` and
`preview`. Radar never decides delivery by matching words in `state`. Terminal controls in display text are stripped.
Keep adapters, their caches and all personal mailbox data in the private profile, never in the public repository.
Old bare-array mail snapshots are not treated as a live inbox.

**Teammates** (via [pi-subagents](https://github.com/edxeth/pi-subagents)):

| Teammate | Does | Where |
|---|---|---|
| scout | Read-only digging: files, git history, owners | Background; the lead gets its summary |
| intent-advisor | Read-only intake: decision tree, ready questions and recommended yes-answers | Background; reports through `helper_report` |
| codebase-advisor | Read-only landing map: files, tests, history, owners and boundaries | Background; reports through `helper_report` |
| test-design-advisor | Read-only acceptance-test definitions from the intent and codebase reports | Background; reports through `helper_report` |
| architecture-advisor | Read-only fit and boundary review using a private checklist when present | Background; reports through `helper_report` |
| builder | Small, fully specified edits handed off by the lead, which does most building itself; never pushes or merges | Its own pane |
| app-tester | Uses the real app in your Chrome (chrome-devtools MCP), reads the app's real state, and reports what it saw | Its own pane |
| reviewer | Checks the diff, tests and evals; can't edit | Its own pane |
| verifier | Independent read-only verification of the frozen brief, diff, test hashes and logs | Its own pane |

When a teammate finishes, its pane closes and its report goes back to the lead. You can ask for one directly ("send
the app-tester to check X"). Watch their panes, but don't type into them: that stops the hand-back. Tell the lead
instead.

**Long runs never block.** `run_in_pane` runs tests, builds and installs in a pane you can watch, with the output
logged. Each agent gets one run pane that it reuses (a new run queues behind one still going), closed when the agent
exits. When the run ends, the lead gets the result as a message and picks up from there. No sleep or poll loops.

## Using /loop

`/loop` runs an explicit advisor-first graph for work that needs intake, a frozen brief and independent verification.
Start from a feature branch with `/loop start [--base <ref>] <goal>`. The runner dispatches advisors, groups their
questions into one `/loop answer <answer>` round, and shows pending advisor roles plus the exact task text in
`/loop status` and `loop_status`.

When advisors are done, the lead submits its plan with `loop_submit_plan`. Approval stays human-only: type
`/loop approve <summary>` yourself when the plan and architecture review are acceptable. Then use `/loop build`, run
red and green checks with `run_in_pane`, and have the lead record them with `loop_record_build`.

**Grimoire** (`/grimoire`): see below.

**Long conversations stay sharp** ([docs/SHARPEN.md](docs/SHARPEN.md)): old tool output is stubbed before each model
call (the saved session keeps it), helpers get the person's latest request, and a long session hands over to a fresh
context with a structured summary (`/handover` on demand).

**A lean prompt.** Context files from folders above the repo are dropped. To load only some skills, list them in
`~/.sitra/config.json`:

    { "name": "Sam", "skills": ["/path/to/skills", "/path/to/one-skill"], "handoverTokens": 400000 }

An empty `skills` list means Pi's normal skill discovery. `handoverTokens` is optional; when set, it must be a
positive integer no larger than the active model's context window.

## Grimoire: one approved brain for every agent

Agents forget between sessions, and agents that write their own memory confidently record wrong things. sitra
splits it: agents **propose**, you **approve**. Grimoire is one folder of plain markdown, yours across every repo and
every tool.

    ~/.sitra/profile/grimoire/
      root/        always loaded: who you are, what you build, the decisions that shape it, how you work
      kinds/       approved entries: warnings/ decisions/ lessons/ facts/ setups/
      proposals/   waiting for your review
      rejected/    kept, so you can see what was turned down

- Every agent, teammates included, starts with the root and a one-line catalogue of approved entries (kind, title,
  summary, path), and opens the entries that apply.
- Agents propose with `grimoire_propose` (only ever into `proposals/`) and look things up with `grimoire_search`.
- You review with `/grimoire`, one at a time: Accept, Reject, Skip, "Accept this and all the rest", or Stop.
- `/grimoire-ui` opens Grimoire in your default browser (on a local `127.0.0.1` server with a random token) so you can
  see the exact prompt text agents get, check which hooks and extensions are active, edit the root or any rule by hand,
  add/move/delete/restore entries, and inspect the day's log of pauses, corrections and repeats.
- `/grimoire-reflect` asks the agent what the session taught that future agents need.
- **Learns from corrections:** when you correct an agent, a background model drafts the missing rule (with a trigger
  when one fits) into `proposals/`, quoting you. You just review `/grimoire`. Turn it off with `"learn": false`.
- **Rules tied to actions:** an entry with `when: ["command:gh pr create"]` pauses the first matching action in a
  session and shows the agent that rule first, in Pi, Claude Code and Codex alike. `sitra grimoire eval` measures them.
- **Claude Code and Codex too:** `sitra grimoire install` (also offered by `sitra init`) loads the same Grimoire there.
  `sitra grimoire uninstall` takes it out again.
- **Coming from `/kb`:** `sitra grimoire import` copies a repo's old `.pi/knowledge` into `proposals/`, skipping what
  Grimoire already has. `/kb` still works and opens `/grimoire`.
- The status line shows `grimoire 34 · 3 to review (/grimoire)`. `sitra grimoire status` shows the sizes.

Details, sizes and the reasons behind them: [docs/GRIMOIRE.md](docs/GRIMOIRE.md).

## Built on

- [Pi](https://pi.dev) 1.0 and [herdr](https://herdr.dev) 0.9.1
- [`edxeth/pi-subagents`](https://github.com/edxeth/pi-subagents): teammates as herdr panes
- [`@juicesharp/rpiv-ask-user-question`](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question): structured questions
- [`@juicesharp/rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo): task list
- [`pi-powerline-footer`](https://www.npmjs.com/package/pi-powerline-footer): status line
- [`pi-web-access`](https://www.npmjs.com/package/pi-web-access): web search and reading pages, PDFs and videos
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp): the app-tester's browser, attached to your running Chrome

The homebrew parts are small: Grimoire, `run_in_pane`, the lead's rules and `sitra init`.

## Good to know

- Teammate models: scout and builder run on `google/gemini-4-argon`, the reviewer on `openai/gpt-6.1-sol` (high
  thinking), the verifier on `openai/gpt-6.1-sol` (xhigh thinking), the app-tester on `anthropic/claude-sonnet-5-5`, and the advisor profiles pin
  their own models with `allow-model-override: false`. If you use other providers, change `model:` in
  `~/.sitra/profile/agents/<name>.md`.
- The app-tester needs Chrome 144 or later, running, with remote debugging turned on at
  `chrome://inspect/#remote-debugging`.
- Your profile is yours to edit: `~/.sitra/profile/AGENTS.md` (how agents work with you) and `agents/*.md` (the
  teammates). `sitra init` won't overwrite them.
- Installs respect a 7-day release cooldown (`.npmrc`, `pnpm-workspace.yaml`) as a supply-chain guard.

## Developing sitra

    pnpm install
    pnpm check       # type-check, lint, tests (the end-to-end tests run a real `pi` with a scripted model, no API key)

See [AGENTS.md](AGENTS.md) for how the code fits together and [docs/LEARNINGS.md](docs/LEARNINGS.md) for the
mistakes not to repeat.
