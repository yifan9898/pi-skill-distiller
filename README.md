# pi-skill-distiller

`pi-skill-distiller` turns completed Pi coding conversations into reusable, human-reviewed `SKILL.md` files.

The extension watches for substantial problem-solving sessions, extracts reusable procedures into a staging area, and lets the user review, edit, approve, or discard each candidate before it becomes an active Pi skill.

## Why this exists

Pi skills are most useful when they capture hard-won workflow knowledge:

- how a project should be tested or released;
- how a recurring failure was debugged;
- what commands, constraints, or review steps matter;
- which team or user preferences should be followed next time.

Raw chat history contains that knowledge, but it is noisy and not directly reusable. This extension provides a safe distillation loop:

```text
completed conversation
  -> gated extraction
  -> .pi/distill-staging/<skill>/SKILL.md
  -> human review/edit
  -> project or global skill directory
  -> git-backed approved change
```

## Core guarantees

- Automatic extraction only writes to `.pi/distill-staging/`; it never activates a skill directly.
- `/distill-review` is the only path that promotes candidates into `.pi/skills/` or `~/.pi/agent/skills/`.
- The reviewer runs in an isolated in-memory session and does not pollute `/resume` history.
- The reviewer only has restricted `read` and `write` tools.
- `write` can only write staged `SKILL.md` files.
- Watermarks are stored as session custom entries, so branch-local conversation history is respected.
- Approved skill roots use an independent git repository to track accepted skill changes.

## Install

This plugin requires Pi `0.84.3` and Node.js `22.19` or newer.

Local trial from a checkout:

```bash
pi -e ./pi-skill-distiller
```

Local install:

```bash
pi install ./pi-skill-distiller
```

Install from GitHub:

```bash
pi install git:github.com:yifan9898/pi-skill-distiller
```

## Commands

| Command | Purpose |
|---|---|
| `/distill [focus]` | Force distillation of the current conversation slice and open review when UI is available. |
| `/distill-review` | Review, edit, approve, discard, or keep staged candidates. |
| `/distill-feedback [reason]` | Generate correction candidates for skills that were actually read in the current round. |

### `/distill`

Use this after a useful debugging or implementation session.

Examples:

```text
/distill capture the release checklist we just used
/distill save the debugging path for flaky node:test failures
```

Manual distillation skips the automatic gate. If automatic distillation already processed the latest round, `/distill` can reuse the last processed slice so a focused instruction still works.

### `/distill-feedback`

Use this when an existing skill was loaded but turned out to be wrong, incomplete, or outdated.

Examples:

```text
/distill-feedback The test command in the loaded skill missed the package-local cwd requirement.
/distill-feedback The release procedure should mention the changelog audit before running the release script.
```

The command includes the names of skills read in the current round, then creates a staged correction candidate instead of modifying the active skill directly.

### `/distill-review`

Reviews candidates from:

```text
.pi/distill-staging/<name>/SKILL.md
```

For each candidate, the UI can:

- approve to project `.pi/skills/`;
- approve to global `~/.pi/agent/skills/`;
- discard;
- keep for later.

The review title flags similar existing skills by edit distance or description keyword overlap. This is advisory; it does not silently block or merge.

## Automatic distillation

Automatic extraction runs after `agent_settled` when the main session is idle and the gate passes.

Default gate:

- at least 8 `toolResult` entries;
- serialized transcript is at least 30 KiB;
- at least one user message and one assistant message;
- no pending messages;
- session is idle.

Before compaction, the extension also attempts gated extraction so useful context is not lost before the transcript is summarized.

## Settings

Project config file:

```text
.pi/pi-skill-distiller-settings.json
```

Default shape:

```json
{
  "enabled": true,
  "autoDistill": true,
  "minToolResults": 8,
  "minTranscriptBytes": 30720,
  "reviewerProvider": "anthropic",
  "reviewerModel": "claude-sonnet-4-5",
  "thinkingLevel": "medium",
  "injectMaintenancePrompt": true,
  "feedbackMinSkills": 15,
  "staleAfterDays": 90
}
```

Notes:

- If no reviewer model is configured, the current session model is used.
- Setting only `reviewerProvider` is rejected because the model would be ambiguous.
- Setting a model without a provider is allowed only when that model can be resolved uniquely.
- `/distill` and `/distill-feedback` skip size/tool-count thresholds, but still respect `enabled`.

## Feedback and usage signals

Feedback signals become active when the loaded skill count reaches `feedbackMinSkills`.

The extension then:

- records actual `SKILL.md` reads in `.pi/distill-usage.json`;
- injects a maintenance reminder telling the agent to repair bad loaded skills or run `/distill-feedback`;
- warns during review about stale skills that have not been read for `staleAfterDays`.

These signals never delete, overwrite, or auto-promote skills.

## Security model

Conversation transcripts are untrusted data. The reviewer prompt explicitly treats transcript content as completed historical evidence, not live instructions.

Mechanical restrictions reinforce that boundary:

- `read` may only access listed loaded skills and staging files;
- `write` may only access `.pi/distill-staging/<name>/SKILL.md`;
- the reviewer has no shell tool;
- the reviewer has no delete tool;
- the reviewer has no write access to formal skill roots;
- promotion to active skills always requires the human review UI.

## Repository layout

```text
extensions/distiller/
  index.ts            extension entrypoint and event wiring
  reviewer.ts         isolated reviewer session and restricted tools
  review-ui.ts        candidate review and promotion flow
  transcript.ts       branch-local transcript slicing and gate checks
  storage.ts          staging, metadata, usage, and atomic file writes
  skill-document.ts   skill parsing and similarity helpers
  settings.ts         project settings loader
  lock.ts             per-worktree distillation lock
  prompt.ts           reviewer and maintenance prompts
  types.ts            shared types

tests/
  *.test.ts           node:test coverage for transcript, storage, and parsing
```

## Development

```bash
npm install --ignore-scripts
npm run check
npm test
npm pack --dry-run
```

The package is designed to be installed as a Pi extension package. Source TypeScript is loaded by Pi through its extension loader.

## Example workflow

1. Complete a complex debugging or implementation session.
2. Run:

   ```text
   /distill save the reusable debugging steps
   ```

3. Inspect the staged candidate in the review UI.
4. Edit the `SKILL.md` content if needed.
5. Approve to project or global skills.
6. Future Pi sessions can discover and use the approved skill.

## Project status

Initial version with:

- gated automatic extraction;
- manual distillation;
- feedback-based skill repair candidates;
- branch-local watermarks;
- restricted reviewer tools;
- human review before activation;
- git-backed approved skill history.
