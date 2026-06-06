# Changelog

All notable changes to PR Reply Assistant are documented here.

## [1.2.0] — 2026-06-06

### Added

- **Fix Grammar & Rephrase Comments** — Highlight any text/comment in the active editor, right-click, and select the option to fix grammar or rephrase it.
- **Side-by-Side Diff View** — Side-by-side comparison editor comparing original text selection with corrected suggestions, retaining language syntax highlighting.
- **Interactive Review UI** — Overlay Quick Pick menu remains active on top of the diff view to easily Replace Selection, Copy to Clipboard, or Cancel.
- **Auto Small Model Resolution** — Dynamically queries and filters available Copilot/VS Code language models to select small/fast models (like `gpt-4o-mini`, `gemini-flash`, or `haiku`) for rapid execution.

## [1.1.0] — 2026-05-16

### Added

- **Quiet output mode** — Drafts now copy/stream only the reply by default, with optional compact/full metadata via `prReplyAssistant.outputDetail`.
- **Duplicate-click protection** — Re-clicking the same PR comment while a draft is running no longer launches stacked generation dialogs.
- **Effort routing** — Drafting now uses deterministic fast / standard / deep routing based on anchor quality, strategy, and prompt breadth.
- **Personal tone examples** — Optional `prReplyAssistant.personalToneExamples` setting lets drafts mirror prior PR reply style without copying exact private details.
- **Pull request description context** — Best-effort GitHub PR title/body retrieval adds current-branch intent and scope context.

### Changed

- First use now works immediately with defaults; setup remains available as an optional command.
- Local git evidence is labeled as available change context instead of overstating it as a verified PR diff.
- Anchor fallback replies are neutral and avoid claiming code is correct when the host did not provide a verified comment range.
- Safety-gate overrides now keep the final reply text aligned with the selected strategy.

## [1.0.0] — 2026-05-06

### Added

- **PR comment button** — Draft PR Reply icon appears on every comment's title toolbar; copies draft + metadata to clipboard.
- **`@prreply` chat participant** — Sticky Copilot Chat participant for drafting replies directly in the chat panel.
- **Multi-agent quality pipeline** — Planner (iterative evidence gathering with tool calls) → Decider → Critic → Arbiter → Writer.
- **Anchor gate** — Falls back to a conservative best-effort reply when the host does not supply an exact comment line range.
- **Safety gate** — Overrides premature "agree" decisions when imperative mutation evidence is present in symbols touched by the diff.
- **Deep context mode** — Pre-seeds PR-wide diagnostics and detailed diffs into the evidence pack before the pipeline starts.
- **Context tools for the Planner**: `code_context_around_comment`, `read_file_range`, `read_full_file`, `git_diff_file`, `git_diff_pr`, `git_log`, `symbol_evidence`, `comprehensive_context`, `web_search`.
- **Structured symbol evidence** — Write / read / mutation-signal analysis for symbols in scope.
- **3-step onboarding wizard** — Language, model, and context-depth selection on first activation.
- **Tone presets** — Balanced, Concise, Supportive, Firm but respectful.
- **Strategy presets** — Auto (agent-decided), Force agree, Force push-back, Force clarify.
- **Language setting** — Draft replies in any language.
- **Token usage reporting** — Prompt / completion / total token counts in output panel and clipboard metadata.
- **Model persistence** — Saves preferred model id / family / vendor; falls back gracefully when a model is renamed or removed.
