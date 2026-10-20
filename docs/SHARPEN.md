# Keeping long conversations sharp

Long agent sessions are said to get worse as they grow: old tool output crowds the context, the person's requests
sink into the middle, and conversations never get a clean start. sitra treats what the evidence supports, inside Pi,
quietly, with nothing sent anywhere. `SITRA_SHARPEN=0` turns off the stubs, helper briefs and handovers;
`SITRA_GRIMOIRE_LOOK=0` turns off the look before the first change.

| What | How |
|---|---|
| **Old tool output becomes a stub** | Before each model call, tool results older than the last 20 and over 2,000 characters (never the latest batch, which the model hasn't seen yet) are replaced by one line naming the call (`read(src/x.ts) returned 240 lines, 9,812 characters. Run it again if you need it.`). The saved session keeps everything. The boundary moves 10 results at a time so the earlier context, and the provider's prompt cache, stay stable. |
| **Helpers get the person's latest request** | When the lead starts a helper, the person's latest request to the lead and the Grimoire rules that came up are appended to the helper's task. |
| **Handover instead of a runaway context** | When a run has settled (after Pi's own retries and recovery) with the context past 40% of the window (at most 160k tokens; for small windows, half the window up to 32k, then at least 16k) and at least two of the person's turns, Pi compacts it into a structured handover: goal in the person's words, standing instructions verbatim, decisions and reasons, state, next steps. `/handover` does it on demand. Each one is saved under `<profile>/handovers/`. |
| **Look before the first change** | The first edit, write or helper in a session waits once until the agent has opened a Grimoire entry or searched it. Grimoire's always-loaded text says "don't guess: look it up or ask". |

## What we measured, on real sessions (2026-10-20)

- **Size and cache.** 17 long real sessions, 5,045 model calls: stubbing made the final context 56% smaller (62% with
  more aggressive settings). The cached prefix changed on 7.6% of calls (45% if the boundary moved every call).
- **Behaviour.** 18 real moments where the person corrected an agent, replayed with Claude Sonnet 5.5 deciding the
  next step from the conversation as it stood, judged by GPT-6.1 against the correction. Raw context, stubbed, stubbed
  plus a rolling brief, and a handover all repeated the mistake at about the same rate, and a second run flipped the
  order (raw 6 then 10 of 16-18; brief 10 then 8). The judge agreed with itself on 34 of 35, so the spread is the
  agent's own variation: these mistakes don't depend on context clutter.
- **Recall.** Questions about something the person said early in sessions of 300k-1.4M characters, asked at the end:
  Sonnet answered 12-13 of 14 with raw or stubbed context. Gemini 4 Argon answered 13 of 14 raw, 10 of 13 with
  aggressive stubbing (last 12 results, over 800 characters) and 14 of 17 with the shipped setting (last 20, over 2,000).
  Current models recalled the person's words well at these sizes; stubbing didn't help recall, and the gentler setting
  keeps any cost within noise on this sample.

**So:** stubbing ships for size, speed and cost (and Anthropic's published +29% on long agentic tasks), with no
measured loss. The handover ships because the alternative is letting the context grow to the model's limit, and a
fresh context with a structured handover behaved the same as the full history.

## Left out, and why

- **A rolling brief at the end of every call** (the person's requests, open todos, rules that came up). Published
  work found restating at the end recovered 15-43% of multi-turn loss on older models; on these sessions it made no
  measurable difference, and restating earlier requests risks pulling the agent back to finished work.
- **Picking memories per step** with a model. See docs/GRIMOIRE.md: the opening message rarely predicts the mistake,
  and the measured gain didn't justify the latency and cost.
