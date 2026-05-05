# Changelog

All notable changes to PR Reply Assistant are documented here.

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
