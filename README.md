# PR Reply Assistant

Draft better GitHub pull request comment replies directly in VS Code using the native Language Model API (`vscode.lm`) and your existing GitHub Copilot access.

## Features

### 1) PR Comment Button

- Adds a `Draft PR Reply` action to the comment title toolbar (`comments/comment/title`).
- Reads the selected `vscode.Comment` text plus optional `CommentThread` file/range context.
- Prompts for optional user guidance (for example: "I do not want to do that; provide a respectful technical reason.").
- Runs an agentic draft pipeline for `Auto` strategy:
  - DecisionAgent (strategy selection)
  - CriticAgent (strategy challenge)
  - WriterAgent (final reply)
- Copies the final draft with metadata to clipboard.

### 2) Chat Participant (`@prreply`)

- Registers a Copilot Chat participant named `@prreply`.
- Uses the currently selected chat model from Copilot Chat (`request.model`).
- Forwards your instruction prompt through `vscode.lm`.
- Streams markdown output back into the chat response in real time.

### 3) Diff-aware + workspace-aware retrieval

- Pulls nearby lines from the commented file/range.
- Adds relevant git diff hunks for that file (working tree, staged, or last commit fallback).
- Adds small related snippets from other workspace files via symbol lookup.
- Optionally enriches context with lightweight web documentation snippets when confidence is low.

### 4) Tone + strategy controls

- Tone Quick Pick:
  - Balanced
  - Concise
  - Supportive
  - Firm but respectful
- Strategy Quick Pick:
  - Auto (recommended)
  - Force agree
  - Force push-back
  - Force clarify

### 5) Token usage reporting

- Reports prompt/completion/total token counts.
- Includes token usage in clipboard output metadata and extension output logs.

## Requirements

- VS Code/Cursor compatible with `engines.vscode: ^1.102.0`.
- GitHub Copilot with chat access enabled.
- Signed in to GitHub/Copilot in VS Code.

## Usage

### Draft from a PR comment

1. Open a pull request comment thread in a VS Code UI that supports comment title actions.
2. Click the `Draft PR Reply` icon button in the comment header.
3. Optionally add custom instructions.
4. Select tone preset and strategy.
5. Paste the generated reply from clipboard into the PR response box.

### Use `@prreply` in Copilot Chat

1. Open Copilot Chat.
2. Start your request with `@prreply`.
3. Add instructions, for example:

```text
@prreply Rewrite this response to be more concise and collaborative:
"I disagree. This implementation is wrong."
```

## Model behavior

- Chat participant uses the model selected by user in the chat UI.
- Comment-button command prefers the last model seen in chat participant requests (falls back to available Copilot models).

## Error handling

- Handles Copilot model availability/auth issues with actionable messages.
- Gracefully degrades when optional web retrieval fails.
- Handles editor builds that do not expose required chat APIs.

## Extension Settings

No custom settings are contributed yet.

## Release Notes

### 0.0.1

- Initial extension scaffolding.

### 0.1.0

- Added PR comment action + `@prreply` participant.
- Added diff-aware/workspace-aware context retrieval.
- Added tone and strategy presets with `Auto` decision mode.
- Added agentic decision flow (judge/critic/writer).
- Added optional web enrichment for uncertain decisions.
- Added token usage reporting in output and clipboard metadata.
