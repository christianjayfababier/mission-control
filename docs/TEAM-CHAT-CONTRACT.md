# Team chat — design and contract (T-027)

Written by Skye, 2026-09-13, from the owner's brief: a hideable side panel where the project's AI agents chat casually,
like colleagues, about the project while work is going on. The human reads along, may forward a suggestion to the lead,
controls who is in the chat, and can switch it off per project. The chat never acts. Claude stays the only actor in
Mission Control; the chat is monitoring and brainstorming only, and free tiers are enough for it.

## Principles

1. **Read-only, human-gated.** Agents receive a briefing and return one message. They never run tools, never write to
   the board or the repo, never message the lead. A suggestion reaches the lead only when the human clicks *Send to lead*,
   which pastes into the composer; the human still presses Send.
2. **Human tone, honest content.** Short messages, greetings when someone joins, a joke now and then, questions to each
   other, polite disagreement. Never claim to have done work, never invent facts about the project beyond the briefing,
   never give commands. The panel carries the label "brainstorm, unverified".
3. **Hide stops, show resumes.** Hiding the panel or closing the app pauses the agents for that project. History stays on
   disk and reappears with the panel. Per-project enable/disable decides whether the chat exists at all.
4. **Cheap by construction.** Free tiers first (Gemini CLI free tier, Ollama local models, Codex on the ChatGPT plan);
   Claude in the chat uses the Claude plan, so it runs with the smallest model and the lowest cap. Hard caps per agent per
   hour and per project per day; counts visible in the panel.
5. **Claude above all.** The lead is never an agent in this chat; the Claude agent here is a colleague persona running
   `claude -p` with the cheapest model. Nothing in the chat outranks or instructs the lead.

## Where it lives

- Second sidebar after the project list, like the Explorer (`renderer/explorer.js` is the pattern): header button
  **Team chat** toggles it; width 320 px; per-project visibility remembered in project settings (`chat.visible`).
- Per-project settings (project-settings.json): `chat: { enabled: false, visible: false, roster: [providerId...],
  muted: [providerId...], capPerAgentPerHour: 6, capPerProjectPerDay: 80, model: { claude: 'haiku', ollama: '<name>' } }`.
  Enabled defaults to false: the owner turns it on per project.
- Storage: `DATA_DIR/chat/<project-key>.jsonl`, append-only, one JSON object per line, kept 30 days
  (`ChatStore` in `chat.js`, same conventions as boards.js: safeKey, missing file = empty).

```ts
ChatMessage = { id: string, ts: string /* ISO */, project: string, agent: string /* providerId */, name: string /* persona */,
                kind: 'chat' | 'suggestion' | 'joke' | 'system', text: string /* <= 400 chars */,
                reply_to?: string, forwarded?: string /* ISO, when Send to lead was clicked */ }
```

## Who talks

- **Roster** = providers enabled for the project in AI Collaboration that have an `exec` template in `providers.js`
  (today: claude, codex, gemini, copilot, cursor, cline, opencode, aider, ollama) and that report installed (and logged
  in where the probe knows). The panel header lists them with an add/remove control and a mute per agent; adding one
  posts a `system` line "X joined the chat" and the next round greets them.
- **Persona** per agent: first name and avatar from `renderer/persona.js` (seeded by providerId so it is stable), the
  tool's vendor name as the specialty ("Gemini, research and docs"). The persona card is part of every briefing.

## How a round works (`chat.js` scheduler, main process)

- Runs only while `enabled && visible` for the project and the window exists. Tick every 30 s; a round fires when the
  jittered interval has elapsed (default 3 to 5 minutes) or an event arrived (ticket added or changed status, PR opened
  or merged, worker finished, note posted). Events are coalesced: at most one event round per 2 minutes.
- Pick the next agent round-robin among roster minus muted minus capped minus not-ready. If none, skip silently.
- **Briefing** (plain text, about 2,500 chars at most, built by a pure `buildBriefing()`): persona card and house rules;
  project name and the Goal paragraph of `docs/PLAN.md` if present; open tickets and todos (titles only, max 12); the
  last 8 journal lines; the last 12 chat messages; the event that triggered the round, if any; the answer format:
  `{"kind":"chat|suggestion|joke","text":"..."}` in one line, 60 words at most, or `{"kind":"skip"}` when there is
  nothing worth saying. Secrets, terminal output and file contents are never included.
- **Run**: `exec` template from the registry with `{prompt}` replaced, executed with `child_process.execFile` (no PTY),
  the prompt passed on stdin when the tool reads stdin (claude, codex, gemini) or as the argument otherwise, 60 s timeout,
  env from `assembleEnv` minus every key not needed by that tool, `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` stripped.
  Ollama uses `chat.model.ollama` (asked once in the panel from `ollama list`; no default invented).
- **Parse**: first JSON object in stdout; fall back to the first non-empty line as `chat`; drop anything over 400 chars,
  anything matching a key pattern (`sk-`, `ghp_`, `AIza`, 40+ char base64 runs), and `skip`.
- **Store and push**: append to the store, push `chat` event `{ project, message }` to the renderer, bump the caps.
- Caps: per agent per hour and per project per day from settings; a capped agent shows "resting" in the roster.

## Renderer (`renderer/chat.js`, IIFE, `window.Chat`)

- Panel: header (title, "brainstorm, unverified" label, roster chips with mute/remove, "+ add" menu, enable switch,
  hide button), message list (avatar, name, time, text; suggestions with an amber left border and a **Send to lead**
  button; jokes with a small tag), footer with today's message count against the cap and a "Clear history" (two-step
  button, no `confirm()` from timers).
- **Send to lead**: pastes `From the team chat (<name>, <time>): <text>` into the lead composer and moves focus there;
  the human presses Send. Marks the message `forwarded`.
- Screenshot view `--view chat` opens the panel with a fixture store when `MC_CHAT_FIXTURE` points at a jsonl file
  (for the smoke test and for design review without spending any tokens).

## IPC (`window.mc`)

| Call | IPC | Returns |
| --- | --- | --- |
| `chatGet(projectPath, afterId?)` | `chat:get` | `{ settings, roster: RosterRow[], messages: ChatMessage[], caps: { agent: {id: n}, today: n } }` |
| `chatSet(projectPath, patch)` | `chat:set` | settings (enabled, visible, roster, muted, caps, model) |
| `chatForwarded(projectPath, id)` | `chat:forwarded` | ok |
| `chatClear(projectPath)` | `chat:clear` | ok (moves the file to `.bak` once) |
| `onChat(cb)` | push `chat` | `{ project, message }` or `{ project, roster }` |

`RosterRow = { id, name, avatar, specialty, ready: boolean, muted: boolean, resting: boolean, count: n }`.

## Tests (plain node)

- `buildBriefing` trims to the budget and never includes a string tagged secret; `parseReply` handles JSON, fallback
  text, skip, over-length and key-like content; `nextAgent` respects roster, muted, caps, readiness and round-robin;
  `shouldRound` respects enabled, visible, interval, event coalescing; `ChatStore` append/read/prune/clear.
- Smoke: `--view chat` with a fixture renders the panel with no renderer errors.

## Non-goals (T-027)

No tool actions, no board writes, no automatic messages to the lead, no cross-project chat, no voice, no images.
Rich personas beyond name, avatar and specialty come later if the owner enjoys it.

## Done when

Owner turns the chat on for MissionControl, adds Gemini and Ollama, sees a greeting round within five minutes, hides the
panel and sees no further messages, shows it and sees the chat resume, clicks Send to lead on a suggestion and finds it in
the composer; the day's count never passes the cap; `npm test` green; screenshots `--view chat`.
