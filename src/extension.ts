import * as vscode from 'vscode';
import {
	DRAFT_REPLY_COMMAND,
	EXTENSION_NAME,
	PARTICIPANT_ID,
} from './constants';
import {
	CONTEXT_MODE_PRESETS,
	getStrategyPresetById,
	getTonePresetById,
} from './presets';
import { readUserSettings } from './settings';
import { getUserFacingErrorMessage } from './errors';
import { DraftInFlightRegistry } from './draftRegistry';
import { hasChatParticipantApi, resolveModelForDraft } from './modelResolver';
import { collectResponseWithUsage } from './llmClient';
import { runOnboardingWizard } from './onboarding';
import { humanizeProgressMessage } from './pipeline/progress';
import { runAutoDraftPipeline, runForcedDraftPipeline } from './pipeline/draft';
import { buildForcedStrategyPrompt } from './pipeline/draft';
import { routeDraftEffort } from './pipeline/effort';
import { formatSingleDraftOutput } from './pipeline/format';
import { AutoDecisionResult } from './pipeline/types';
import { extractCommentData, getThreadConversationContext } from './context/comment';
import { getCodeContext } from './context/code';
import { getSymbolEvidenceContext } from './context/evidence';
import {
	getFullPrDiffContext,
	getDeepContextForComment,
	getDeepContextForUri,
} from './context/git';
import { getComprehensiveContextForComment } from './context/comprehensive';
import { getPullRequestDescriptionContextForUri } from './context/prDescription';
import {
	resolveChatRequestContext,
	inferStrategyPresetFromPrompt,
} from './context/chatRequest';

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel(EXTENSION_NAME);
	context.subscriptions.push(output);
	output.appendLine('Activating extension.');
	let preferredModelId: string | undefined;
	const inFlightDrafts = new DraftInFlightRegistry();

	const runOnboardingCommand = vscode.commands.registerCommand(
		'pr-reply-assistant.runOnboarding',
		async () => {
			await runOnboardingWizard({ force: true });
		},
	);
	context.subscriptions.push(runOnboardingCommand);

	const openSettingsCommand = vscode.commands.registerCommand(
		'pr-reply-assistant.openSettings',
		async () => {
			await vscode.commands.executeCommand(
				'workbench.action.openSettings',
				'@ext:pr-reply-assistant',
			);
		},
	);
	context.subscriptions.push(openSettingsCommand);

	const draftReplyCommand = vscode.commands.registerCommand(
		DRAFT_REPLY_COMMAND,
		async (commentContext?: unknown) => {
			let registeredDraftKey: string | undefined;
			try {
				const { commentText, commentThread, commentAuthor } = extractCommentData(commentContext);
				if (!commentText) {
					await vscode.window.showErrorMessage(
						'No comment text was found. Run this action directly from a pull request comment.',
					);
					return;
				}

				registeredDraftKey = inFlightDrafts.tryStart({
					commentText,
					commentAuthor,
					uri: commentThread?.uri?.toString(),
					range: commentThread?.range,
				});
				if (!registeredDraftKey) {
					await vscode.window.showInformationMessage(
						'PR Reply Assistant is already drafting a reply for this comment.',
					);
					return;
				}

				const settings = readUserSettings();
				const selectedTonePreset = getTonePresetById(settings.tone);
				const selectedStrategyPreset = getStrategyPresetById(settings.strategy);

				let additionalInstructions = '';
				if (settings.askForExtraInstructions) {
					const input = await vscode.window.showInputBox({
						prompt: 'Optional: add extra guidance for this reply draft.',
						placeHolder:
							`Example: "I do not want to do that; provide a respectful technical reason."`,
						ignoreFocusOut: true,
					});
					if (input === undefined) {
						return;
					}
					additionalInstructions = input;
				}

				const effort = routeDraftEffort({
					commentText,
					additionalInstructions,
					strategy: selectedStrategyPreset.id,
					contextDepth: settings.contextDepth,
					anchorVerified: Boolean(commentThread?.range),
				});
				output.appendLine(`Effort route: ${effort}`);

				const [codeContext, fullDiffContext, prDescriptionContext, symbolEvidenceContext, deepContext, comprehensiveContext] =
					await Promise.all([
						getCodeContext(commentThread),
						effort === 'fast' ? Promise.resolve(undefined) : getFullPrDiffContext(commentThread),
						getPullRequestDescriptionContextForUri(commentThread?.uri),
						getSymbolEvidenceContext(commentText, commentThread),
						effort === 'deep'
							? getDeepContextForComment(commentThread)
							: Promise.resolve(undefined),
						effort === 'deep'
							? getComprehensiveContextForComment(commentText, commentThread)
							: Promise.resolve(undefined),
					]);

				const threadContext = commentThread
					? getThreadConversationContext(commentThread)
					: undefined;

				const model = await resolveModelForDraft(preferredModelId, (line) =>
					output.appendLine(`[model] ${line}`),
				);
				preferredModelId = model.id;
				output.appendLine(`Draft command model: ${model.name} (${model.id})`);
				output.appendLine(
					`Settings: tone=${settings.tone}, strategy=${settings.strategy}, depth=${settings.contextDepth}, language=${settings.language}`,
				);

				const result = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'PR Reply Assistant',
						cancellable: false,
					},
					async (progress): Promise<AutoDecisionResult> => {
						progress.report({ message: 'Setting up the agent pipeline…' });
						const reportProgress = (line: string) => {
							output.appendLine(`[pipeline] ${line}`);
							progress.report({ message: humanizeProgressMessage(line) });
						};

						if (selectedStrategyPreset.id === 'auto') {
							return runAutoDraftPipeline({
								model,
								commentText,
								additionalInstructions,
								selectedTonePreset,
								codeContext,
									threadContext,
									fullDiffContext,
									prDescriptionContext,
									symbolEvidenceContext,
								deepContext,
								comprehensiveContext,
								commentAuthor,
								strategyInstruction: selectedStrategyPreset.instruction,
								commentThread,
								commentUri: commentThread?.uri,
								commentRange: commentThread?.range,
								language: settings.language,
								personalToneExamples: settings.personalToneExamples,
								logger: reportProgress,
							});
						}

						progress.report({ message: 'Generating reply with forced strategy…' });
						const forcedPrompt = buildForcedStrategyPrompt({
							mode: selectedStrategyPreset.id,
							commentText,
							additionalInstructions,
							selectedTonePreset,
							codeContext,
							threadContext,
							fullDiffContext,
							prDescriptionContext,
							symbolEvidenceContext,
							deepContext,
							comprehensiveContext,
							commentAuthor,
							strategyInstruction: selectedStrategyPreset.instruction,
							language: settings.language,
							personalToneExamples: settings.personalToneExamples,
						});
						const forcedMessages = [vscode.LanguageModelChatMessage.User(forcedPrompt)];
						const { text: reply, tokenUsage } = await collectResponseWithUsage(
							model,
							forcedMessages,
						);
						return {
							selectedStrategy: selectedStrategyPreset.id,
							rationale: [],
							reply: reply.trim(),
							tokenUsage,
						};
					},
				);

				if (!result.reply.trim()) {
					throw new Error('The model returned an empty draft.');
				}

				const reply = formatSingleDraftOutput({
					result,
					selectedTonePreset,
					selectedStrategyPreset,
					modelLabel: `${model.name} (${model.id})`,
					outputDetail: settings.outputDetail,
				});
				const diagnosticOutput = formatSingleDraftOutput({
					result,
					selectedTonePreset,
					selectedStrategyPreset,
					modelLabel: `${model.name} (${model.id})`,
					outputDetail: 'full',
				});
				await vscode.env.clipboard.writeText(reply);
				output.appendLine(
					`Draft token usage - prompt: ${result.tokenUsage.promptTokens}, completion: ${result.tokenUsage.completionTokens}, total: ${result.tokenUsage.totalTokens}`,
				);
				output.appendLine(`Draft diagnostics:\n${diagnosticOutput}`);
				await vscode.window.showInformationMessage(
					settings.outputDetail === 'replyOnly'
						? 'Draft reply copied to clipboard.'
						: 'Draft copied to clipboard with selected strategy metadata.',
				);
			} catch (error) {
				await vscode.window.showErrorMessage(getUserFacingErrorMessage(error));
			} finally {
				inFlightDrafts.finish(registeredDraftKey);
			}
		},
	);

	context.subscriptions.push(draftReplyCommand);
	output.appendLine(`Registered command: ${DRAFT_REPLY_COMMAND}`);

	if (!hasChatParticipantApi()) {
		output.appendLine('Chat participant API unavailable in current editor build.');
		void vscode.window.showWarningMessage(
			`${EXTENSION_NAME}: Chat participant is unavailable in this editor build. Update VS Code/Cursor to a version that supports chat participants.`,
		);
		return;
	}

	const participant = vscode.chat.createChatParticipant(
		PARTICIPANT_ID,
		async (
			request: vscode.ChatRequest,
			chatContext: vscode.ChatContext,
			stream: vscode.ChatResponseStream,
			token: vscode.CancellationToken,
		): Promise<void> => {
			void chatContext;
			void token;
			try {
				if (!request.prompt.trim()) {
					stream.markdown('Please provide instructions so I can draft a PR reply.');
					return;
				}

				const model = request.model;
				preferredModelId = model.id;
				output.appendLine(`Chat participant model: ${model.name} (${model.id})`);
				stream.progress('Resolving referenced PR comment context...');

				const resolved = await resolveChatRequestContext(request);
				const userSettings = readUserSettings();
				const selectedTonePreset = getTonePresetById(userSettings.tone);
				const selectedStrategyPreset =
					inferStrategyPresetFromPrompt(request.prompt).id !== 'auto'
						? inferStrategyPresetFromPrompt(request.prompt)
						: getStrategyPresetById(userSettings.strategy);
				const selectedContextMode =
					CONTEXT_MODE_PRESETS.find((p) => p.id === userSettings.contextDepth) ??
					CONTEXT_MODE_PRESETS[0];

				if (!resolved.commentText && !request.references.length) {
					stream.progress(
						'No explicit comment reference found. Using your prompt as the target comment. Attach with # for stronger grounding.',
					);
				}

				const commentText = resolved.commentText ?? request.prompt;
				const additionalInstructions = resolved.commentText ? request.prompt : '';
				const effort = routeDraftEffort({
					commentText,
					additionalInstructions,
					strategy: selectedStrategyPreset.id,
					contextDepth: selectedContextMode.id,
					anchorVerified: Boolean(resolved.targetRange),
				});
				output.appendLine(`Chat effort route: ${effort}`);
				const deepContext =
					effort === 'deep'
						? await getDeepContextForUri(resolved.targetUri)
						: undefined;
				const comprehensiveContext =
					effort === 'deep' ? resolved.comprehensiveContext : undefined;

				stream.progress('Running strategy + drafting pipeline...');

				const result =
					selectedStrategyPreset.id === 'auto'
						? await runAutoDraftPipeline({
							model,
							commentText,
							additionalInstructions,
							selectedTonePreset,
							strategyInstruction: selectedStrategyPreset.instruction,
							codeContext: resolved.codeContext,
							threadContext: resolved.threadContext,
							fullDiffContext: resolved.fullDiffContext,
							prDescriptionContext: resolved.prDescriptionContext,
							symbolEvidenceContext: resolved.symbolEvidenceContext,
							deepContext,
							comprehensiveContext,
							commentAuthor: resolved.commentAuthor,
							commentUri: resolved.targetUri,
							commentRange: resolved.targetRange,
							language: userSettings.language,
							personalToneExamples: userSettings.personalToneExamples,
							logger: (line) => {
								output.appendLine(`[pipeline] ${line}`);
								stream.progress(line);
							},
						})
						: await runForcedDraftPipeline({
							model,
							mode: selectedStrategyPreset.id,
							commentText,
							additionalInstructions,
							selectedTonePreset,
							strategyInstruction: selectedStrategyPreset.instruction,
							codeContext: resolved.codeContext,
							threadContext: resolved.threadContext,
							fullDiffContext: resolved.fullDiffContext,
							prDescriptionContext: resolved.prDescriptionContext,
							symbolEvidenceContext: resolved.symbolEvidenceContext,
							deepContext,
							comprehensiveContext,
							commentAuthor: resolved.commentAuthor,
							language: userSettings.language,
							personalToneExamples: userSettings.personalToneExamples,
						});

				const formatted = formatSingleDraftOutput({
					result,
					selectedTonePreset,
					selectedStrategyPreset,
					modelLabel: `${model.name} (${model.id})`,
					outputDetail: userSettings.outputDetail,
				});
				const diagnosticOutput = formatSingleDraftOutput({
					result,
					selectedTonePreset,
					selectedStrategyPreset,
					modelLabel: `${model.name} (${model.id})`,
					outputDetail: 'full',
				});
				output.appendLine(
					`Chat token usage - prompt: ${result.tokenUsage.promptTokens}, completion: ${result.tokenUsage.completionTokens}, total: ${result.tokenUsage.totalTokens}`,
				);
				output.appendLine(`Chat diagnostics:\n${diagnosticOutput}`);
				if (userSettings.outputDetail === 'replyOnly') {
					stream.markdown(formatted);
				} else {
					stream.markdown(['## PR Reply Draft', '', '```text', formatted, '```'].join('\n'));
				}
			} catch (error) {
				stream.markdown(getUserFacingErrorMessage(error));
			}
		},
	);

	context.subscriptions.push(participant);
	output.appendLine(`Registered chat participant: ${PARTICIPANT_ID}`);
}

export function deactivate(): void {}
