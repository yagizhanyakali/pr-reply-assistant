# PR Reply Assistant

Draft context-aware, well-reasoned replies to GitHub pull request comments directly in VS Code/Cursor using the native Language Model API (`vscode.lm`) and your existing GitHub Copilot access.

## Features

### 1) PR Comment Button

- Adds a **Draft PR Reply** icon button (`$(comment-discussion)`) to every PR comment's title toolbar.
- Reads the `vscode.Comment` text plus the parent `CommentThread` file and line range.
- Optionally prompts for extra one-off guidance before drafting.
- Runs the full multi-agent quality pipeline for `Auto` strategy (see [Pipeline](#pipeline)).
- Copies the final draft to clipboard. Metadata is hidden by default and remains available in the Output panel.
- Reuses the active draft run if you click the same comment again while generation is in progress.

### 2) Chat Participant (`@prreply`)

- Registers a sticky Copilot Chat participant named `@prreply`.
- Uses the model you select in the Chat UI (`request.model`).
- Accepts `#` file/location references for stronger code grounding.
- Infers tone and strategy intent from your prompt text (e.g. "push back firmly").
- Streams the draft back into the chat response, using the same metadata visibility setting as clipboard output.

### 3) Multi-agent quality pipeline

The `Auto` strategy runs a structured, evidence-based pipeline:

| Stage | Agent | Purpose |
|---|---|---|
| 1 | **Planner** | Iteratively calls context tools to fill evidence gaps |
| 2 | **Decider** | Chooses a strategy (agree / push-back / clarify) with confidence + rationale |
| 3 | **Critic** | Challenges the Decider's choice from an adversarial perspective |
| 4 | **Arbiter** | Reconciles Decider vs Critic and finalises the strategy |
| 5 | **Writer** | Drafts the actual reply grounded in collected evidence |

Safety gates run after the pipeline:
- **Anchor gate** — if the host did not supply an exact comment line range, falls back to a conservative best-effort reply.
- **Safety gate** — overrides a naive "agree" when imperative mutation evidence is present in symbols touched by the diff.
- **Effort router** — chooses fast, standard, or deep context collection based on anchor quality, strategy, and prompt breadth.

### 4) Deep context retrieval

The Planner has access to a suite of context tools it calls on demand:

- `code_context_around_comment` — code lines + diff hunks + related symbol snippets around the comment anchor
- `read_file_range` / `read_full_file` — arbitrary workspace file reads
- `git_diff_file` / `git_diff_pr` / `git_log` — file-level available-change diffs and commit history
- `symbol_evidence` — structured write/read/mutation analysis for symbols in scope
- `comprehensive_context` — full-file content, page diff, reference-impact analysis, and available-change summary combined
- `web_search` — lightweight DuckDuckGo summary for external documentation when needed

**Context depth** setting controls pre-seeding:
- **Standard** — Planner gathers context on demand. Fast.
- **Deep** — available-change diagnostics and detailed diffs are pre-seeded into the evidence pack before the pipeline starts. Slower but broader.

### 5) Tone and strategy presets

**Tone presets** (set in Settings or optional setup):

| Preset | Style |
|---|---|
| Balanced | Neutral and collaborative |
| Concise | Short and direct (2–4 sentences) |
| Supportive | Warm and appreciative |
| Firm but respectful | Confident with clear constraints |

**Strategy presets:**

| Preset | Behaviour |
|---|---|
| Auto _(recommended)_ | Agents decide based on evidence |
| Force agree | Acknowledge and confirm action |
| Force push-back | Respectful disagreement with rationale |
| Force clarify | Focused question + proposed next step |

### 6) Token usage reporting

- Prompt / completion / total token counts are always written to the extension Output panel.
- Set `prReplyAssistant.outputDetail` to `compact` or `full` if you want metadata included in clipboard/chat output.

## Requirements

- VS Code or Cursor with `engines.vscode: ^1.102.0`.
- GitHub Copilot with Chat access enabled.
- Signed in to GitHub/Copilot inside VS Code.

## Optional Setup

First use works immediately with defaults. Re-run setup at any time with **PR Reply Assistant: Run Setup** if you want to customize:

1. **Language** — choose or type the language for draft replies (e.g. English, Türkçe, Español).
2. **Model** — pick the Copilot language model to use (persisted to Settings).
3. **Context depth** — Standard or Deep.
4. **Personal tone examples** — optionally paste a few previous PR replies so drafts better match your style.

## Usage

### Draft from a PR comment

1. Open a pull request in a VS Code UI that surfaces comment threads (e.g. the GitHub Pull Requests extension).
2. Click the **Draft PR Reply** icon in the comment header.
3. If `askForExtraInstructions` is enabled, add optional guidance (or leave blank).
4. The pipeline runs, then the draft reply is copied to clipboard.
5. Paste into the PR response box.

### Use `@prreply` in Copilot Chat

Open Copilot Chat and start your message with `@prreply`:

```text
@prreply Draft a reply to this comment:
"This function should be split — it does too many things at once."
```

Attach a file or range with `#` for stronger grounding:

```text
@prreply #src/utils.ts Push back firmly — the complexity is necessary here.
```

## Extension Settings

| Setting | Default | Description |
|---|---|---|
| `prReplyAssistant.tone` | `balanced` | Default tone preset (`balanced`, `concise`, `supportive`, `firm`) |
| `prReplyAssistant.strategy` | `auto` | Default strategy (`auto`, `agree`, `pushback`, `clarify`) |
| `prReplyAssistant.contextDepth` | `standard` | Pre-seeding depth (`standard`, `deep`) |
| `prReplyAssistant.language` | `English` | Language for draft replies |
| `prReplyAssistant.askForExtraInstructions` | `false` | Show an input box for optional guidance on each draft |
| `prReplyAssistant.outputDetail` | `replyOnly` | Visible output detail (`replyOnly`, `compact`, `full`) |
| `prReplyAssistant.personalToneExamples` | _(empty)_ | Optional previous PR replies used as style guidance |
| `prReplyAssistant.modelId` | _(empty)_ | Preferred model id — set during optional setup |
| `prReplyAssistant.modelFamily` | _(empty)_ | Fallback model family if the saved id is stale |
| `prReplyAssistant.modelVendor` | _(empty)_ | Fallback model vendor (e.g. `copilot`) |
| `prReplyAssistant.promptForModelSelection` | `false` | Show a model picker on every draft |
| `prReplyAssistant.persistSelectedModel` | `true` | Save the selected model when the picker is used |

## Architecture

```
src/
├── extension.ts          # activate / deactivate — wires commands and chat participant
├── agents.ts             # multi-agent quality draft pipeline (Planner, Decider, Critic, Arbiter, Writer)
├── constants.ts          # shared string/numeric constants
├── draftRegistry.ts      # in-flight draft de-duplication helpers
├── presets.ts            # tone, strategy, and context-mode preset data and helpers
├── settings.ts           # readUserSettings()
├── errors.ts             # user-facing error message formatting
├── llmClient.ts          # collectResponseWithUsage, token counting
├── modelResolver.ts      # model selection and fallback logic
├── onboarding.ts         # optional setup wizard
├── utils.ts              # escapeRegExp, truncateText, execFileAsync
├── context/
│   ├── anchor.ts         # buildAnchorEvidence — seed evidence from comment location
│   ├── chatRequest.ts    # resolveChatRequestContext, prompt inference helpers
│   ├── code.ts           # getCodeContext, buildCodeContextFromDocumentRange
│   ├── comment.ts        # extractCommentData, getThreadConversationContext
│   ├── comprehensive.ts  # getComprehensiveContext — full-page, ref-impact, PR changes
│   ├── evidence.ts       # getSymbolEvidenceContext — symbol write/read/mutation analysis
│   ├── git.ts            # git diff and deep context helpers
│   └── web.ts            # fetchDuckDuckGoSummary
└── pipeline/
    ├── draft.ts          # runAutoDraftPipeline, runForcedDraftPipeline, buildForcedStrategyPrompt
    ├── effort.ts         # deterministic fast / standard / deep effort router
    ├── format.ts         # formatSingleDraftOutput, humanizeStrategy
    ├── gates.ts          # applyAnchorGate, applySafetyGate
    ├── progress.ts       # humanizeProgressMessage
    ├── tools.ts          # buildContextToolRegistry — tool specs for the Planner
    └── types.ts          # AutoDecisionResult, PipelineDetailSummary
```

## Release Notes

### 0.0.1

- Initial extension scaffolding.

### 0.1.0

- Added PR comment action + `@prreply` chat participant.
- Added diff-aware and workspace-aware code context retrieval.
- Added tone and strategy presets with `Auto` decision mode.
- Added agentic decision flow (judge / critic / writer).
- Added optional web enrichment for uncertain decisions.
- Added token usage reporting in output channel and optional clipboard metadata.

### 0.2.0

- Replaced single-pass judge/critic/writer flow with a full multi-agent quality pipeline: Planner (iterative evidence gathering with tool calls), Decider, Critic, Arbiter, and Writer stages.
- Added anchor gate and safety gate post-processing.
- Added `Deep` context depth mode — pre-seeds available-change diagnostics and detailed diffs before the pipeline starts.
- Added optional setup wizard (language, model, context depth, personal tone examples).
- Added comprehensive context tool: full-file content, page diff, reference impact, and PR change summary.
- Added structured symbol evidence: write/read/mutation-signal analysis for symbols in scope.
- Added `askForExtraInstructions` setting — optional per-draft guidance input.
- Added `language` setting — replies can be drafted in any language.
- Added model persistence and fallback by family/vendor.
- Refactored codebase into focused modules under `src/context/` and `src/pipeline/`.

### Unreleased

- Default visible output is now reply-only; compact/full metadata can be enabled in settings.
- Duplicate clicks on the same comment reuse the active draft run instead of launching stacked progress notifications.
- Added deterministic effort routing and personal tone examples.
- Reworded available-change context labels so local git evidence is not overstated as a verified GitHub PR diff.
