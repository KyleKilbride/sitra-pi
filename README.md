# sitra

A visible, collaborative agent setup on [Pi](https://pi.dev) (the coding agent) and [herdr](https://herdr.dev)
(a terminal multiplexer for agents). You talk to one **lead**; it hands work to **teammates** that open in panes you
can watch. Long runs never block, and each repo keeps a **knowledge base** that grows only with your approval.

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
personal name, and after that both `sitra tower` and `sitra <its-name>` start it.

**Teammates** (via [pi-subagents](https://github.com/edxeth/pi-subagents)):

| Teammate | Does | Where |
|---|---|---|
| scout | Read-only digging: files, git history, owners | Background; the lead gets its summary |
| builder | Small, fully specified edits handed off by the lead, which does most building itself; never pushes or merges | Its own pane |
| app-tester | Uses the real app in your Chrome (chrome-devtools MCP), reads the app's real state, and reports what it saw | Its own pane |
| reviewer | Checks the diff, tests and evals; can't edit | Its own pane |

When a teammate finishes, its pane closes and its report goes back to the lead. You can ask for one directly ("send
the app-tester to check X"). Watch their panes, but don't type into them: that stops the hand-back. Tell the lead
instead.

**Long runs never block.** `run_in_pane` runs tests, builds and installs in a pane you can watch, with the output
logged. When the run ends, the lead gets the result as a message and picks up from there. No sleep or poll loops.

**Knowledge base** (`/kb`): see below.

**A lean prompt.** Context files from folders above the repo are dropped. To load only some skills, list them in
`~/.sitra/config.json`:

    { "name": "Sam", "skills": ["/path/to/skills", "/path/to/one-skill"] }

An empty list means Pi's normal skill discovery.

## The knowledge base

Agents forget between sessions, and agents that write their own memory confidently record wrong things. sitra
splits it: agents **propose**, you **approve**. Approved knowledge is plain markdown in the repo.

    <repo>/.pi/knowledge/
      proposals/      waiting for your review
      warnings/  decisions/  lessons/  facts/  setups/    approved, by kind
      rejected/       kept, so you can see what was turned down

- One knowledge base per repo: sessions in any git worktree of the repo use the main checkout's `.pi/knowledge`.
- Agents propose with the `kb_propose` tool. It only ever writes to `proposals/`.
- You review with `/kb`, one at a time: Accept, Reject, Skip, "Accept this and all the rest", or Stop.
- Before every turn, a short index of approved entries (titles and paths, warnings first) goes into every agent's
  prompt, teammates included.
- `/kb-reflect` asks the agent to look back over the session and propose what's worth keeping.
- The status line shows `kb 12 · 3 to review (/kb)`.

## Built on

- [Pi](https://pi.dev) 1.0 and [herdr](https://herdr.dev) 0.9.1
- [`edxeth/pi-subagents`](https://github.com/edxeth/pi-subagents): teammates as herdr panes
- [`@juicesharp/rpiv-ask-user-question`](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question): structured questions
- [`@juicesharp/rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo): task list
- [`pi-powerline-footer`](https://www.npmjs.com/package/pi-powerline-footer): status line
- [`pi-memory`](https://www.npmjs.com/package/pi-memory): personal preferences only, not project facts
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp): the app-tester's browser, attached to your running Chrome

The homebrew parts are small: the knowledge base, `run_in_pane`, the lead's rules and `sitra init`.

## Good to know

- Teammate models: scout and builder run on `google/gemini-4-argon`, the reviewer on `openai/gpt-6.1-sol` (high
  thinking), the app-tester on `anthropic/claude-sonnet-5-5`. Each may only be switched to the models in its
  `allowed-models:` line. If you use other providers, change `model:` in `~/.sitra/profile/agents/<name>.md`.
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
