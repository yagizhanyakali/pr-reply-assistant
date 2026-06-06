import * as vscode from 'vscode';
import { resolveSmallModel } from './modelResolver';
import { collectResponseText } from './llmClient';
import { getUserFacingErrorMessage } from './errors';

interface FixActionQuickPickItem extends vscode.QuickPickItem {
	id: string;
	instruction: string;
}

interface PreviewQuickPickItem extends vscode.QuickPickItem {
	action: 'replace' | 'diff' | 'copy' | 'cancel';
}

export class DiffContentProvider implements vscode.TextDocumentContentProvider {
	private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this._onDidChange.event;

	private originalText = '';
	private correctedText = '';

	update(original: string, corrected: string): void {
		this.originalText = original;
		this.correctedText = corrected;
		this._onDidChange.fire(vscode.Uri.parse('pr-reply-diff://authority/original'));
		this._onDidChange.fire(vscode.Uri.parse('pr-reply-diff://authority/corrected'));
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		if (uri.path.startsWith('/original')) {
			return this.originalText;
		}
		if (uri.path.startsWith('/corrected')) {
			return this.correctedText;
		}
		return '';
	}
}

export function registerFixCommentCommand(
	context: vscode.ExtensionContext,
	output: vscode.OutputChannel,
	diffProvider: DiffContentProvider,
): vscode.Disposable {
	return vscode.commands.registerCommand(
		'pr-reply-assistant.fixComment',
		async () => {
			try {
				const editor = vscode.window.activeTextEditor;
				if (!editor) {
					await vscode.window.showErrorMessage('No active text editor found.');
					return;
				}

				const selection = editor.selection;
				const selectedText = editor.document.getText(selection).trim();
				if (!selectedText) {
					await vscode.window.showErrorMessage(
						'Please select the comment or text you want to fix or rephrase first.',
					);
					return;
				}

				output.appendLine(`[fix-comment] Selection: "${selectedText.slice(0, 60)}${selectedText.length > 60 ? '...' : ''}"`);

				const actionItems: FixActionQuickPickItem[] = [
					{
						label: '$(checklist) Fix Grammar & Spelling',
						description: 'Fix spelling, typos, and grammar while keeping original tone',
						id: 'grammar',
						instruction: 'Correct the grammar, spelling, typos, and syntax errors in the text below. Keep the original style, tone, and phrasing as much as possible.',
					},
					{
						label: '$(briefcase) Rephrase: Professional',
						description: 'Make the comment sound professional, polite, and clear',
						id: 'professional',
						instruction: 'Rephrase the text below to be professional, polite, clear, and constructive, suitable for a pull request or code review.',
					},
					{
						label: '$(zap) Rephrase: Concise',
						description: 'Make the comment concise, short, and to the point',
						id: 'concise',
						instruction: 'Rephrase the text below to be highly concise, direct, and short (1-2 sentences) while keeping the core meaning.',
					},
					{
						label: '$(heart) Rephrase: Friendly',
						description: 'Make the comment sound friendly, warm, and constructive',
						id: 'friendly',
						instruction: 'Rephrase the text below to be friendly, supportive, warm, and encouraging.',
					},
				];

				const selectedAction = await vscode.window.showQuickPick(actionItems, {
					placeHolder: 'Choose how to improve the selected text',
					title: 'Fix Grammar or Rephrase Comment',
					ignoreFocusOut: true,
				});

				if (!selectedAction) {
					output.appendLine('[fix-comment] Action selection cancelled.');
					return;
				}

				let correctedText = '';
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'PR Reply Assistant',
						cancellable: false,
					},
					async (progress) => {
						progress.report({ message: 'Resolving fast language model...' });
						const model = await resolveSmallModel((line) => output.appendLine(`[model] ${line}`));
						
						progress.report({ message: `Applying correction: ${selectedAction.id}...` });
						
						const systemInstruction = 
							`${selectedAction.instruction}\n\n` +
							`If the input text starts with or contains comment character prefixes (such as '//', '/*', '*', '#', or triple quotes), preserve them at the start of the corrected lines in the output. ` +
							`Do NOT add any explanatory text, markdown formatting code blocks (like \`\`\`), or introductory/concluding remarks. ` +
							`Return ONLY the improved text itself.`;
						
						const prompt = `${systemInstruction}\n\nText:\n${selectedText}`;
						const messages = [vscode.LanguageModelChatMessage.User(prompt)];
						
						correctedText = (await collectResponseText(model, messages)).trim();
					},
				);

				if (!correctedText) {
					await vscode.window.showWarningMessage('The language model returned an empty correction.');
					return;
				}

				output.appendLine(`[fix-comment] Corrected text: "${correctedText.slice(0, 60)}${correctedText.length > 60 ? '...' : ''}"`);

				let actionApplied = false;
				while (!actionApplied) {
					const previewItems: PreviewQuickPickItem[] = [
						{
							label: '$(check) Replace Selection',
							description: 'Overwrite the selected text with the corrected version',
							detail: correctedText,
							action: 'replace',
						},
						{
							label: '$(git-compare) Compare Changes (Show Diff)',
							description: 'Open a side-by-side diff comparison in the editor',
							action: 'diff',
						},
						{
							label: '$(clippy) Copy to Clipboard',
							description: 'Copy the corrected text to the clipboard',
							action: 'copy',
						},
						{
							label: '$(close) Cancel',
							description: 'Keep the original text unchanged',
							action: 'cancel',
						},
					];

					const previewPick = await vscode.window.showQuickPick(previewItems, {
						placeHolder: 'Select an action to apply the corrected text',
						title: `Preview: "${correctedText.length > 50 ? correctedText.slice(0, 47) + '...' : correctedText}"`,
						ignoreFocusOut: true,
					});

					if (!previewPick || previewPick.action === 'cancel') {
						output.appendLine('[fix-comment] User cancelled preview pick.');
						actionApplied = true;
					} else if (previewPick.action === 'replace') {
						await editor.edit((editBuilder) => {
							editBuilder.replace(selection, correctedText);
						});
						vscode.window.setStatusBarMessage('Text corrected successfully!', 3000);
						output.appendLine('[fix-comment] Replaced selected text.');
						actionApplied = true;
					} else if (previewPick.action === 'copy') {
						await vscode.env.clipboard.writeText(correctedText);
						await vscode.window.showInformationMessage('Corrected text copied to clipboard.');
						output.appendLine('[fix-comment] Copied corrected text to clipboard.');
						actionApplied = true;
					} else if (previewPick.action === 'diff') {
						output.appendLine('[fix-comment] Opening side-by-side diff view...');
						const fileName = editor.document.fileName;
						const lastDotIndex = fileName.lastIndexOf('.');
						const ext = lastDotIndex !== -1 ? fileName.slice(lastDotIndex) : '';
						
						const originalUri = vscode.Uri.parse(`pr-reply-diff://authority/original${ext}`);
						const correctedUri = vscode.Uri.parse(`pr-reply-diff://authority/corrected${ext}`);
						
						diffProvider.update(selectedText, correctedText);
						
						const diffTitle = `Original ↔ Corrected (${selectedAction.label.replace(/^\$\([a-z-]+\)\s*/, '')})`;
						await vscode.commands.executeCommand('vscode.diff', originalUri, correctedUri, diffTitle);
					}
				}
			} catch (error) {
				output.appendLine(`[fix-comment] Error: ${error}`);
				await vscode.window.showErrorMessage(getUserFacingErrorMessage(error));
			}
		},
	);
}

