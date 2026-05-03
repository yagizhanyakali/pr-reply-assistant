import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const EXTENSION_NAME = 'PR Reply Assistant';
const PARTICIPANT_ID = 'pr-reply-assistant.participant';
const DRAFT_REPLY_COMMAND = 'pr-reply-assistant.draftReply';
const CONTEXT_LINES = 20;
const RELATED_SNIPPET_LINES = 8;
const MAX_RELATED_SNIPPETS = 4;
const MAX_SYMBOL_QUERIES = 5;
const MAX_CONTEXT_CHARS = 10_000;
const MAX_DIFF_CONTEXT_CHARS = 3_500;
const DIFF_UNIFIED_LINES = 8;
const MAX_WEB_QUERY_COUNT = 2;
const MAX_WEB_SUMMARY_CHARS = 2_000;
const MAX_PR_STAT_CHARS = 1_500;
type DraftMode = 'agree' | 'pushback' | 'clarify';
type TonePreset = {
	id: string;
	label: string;
	detail: string;
	styleGuidance: string;
};
type StrategyPreset = {
	id: 'auto' | DraftMode;
	label: string;
	detail: string;
	instruction: string;
};
type AutoDecisionResult = {
	selectedStrategy: DraftMode | 'unknown';
	confidence?: number;
	rationale: string[];
	reply: string;
	tokenUsage: TokenUsageSummary;
};
type DecisionPayload = {
	selectedStrategy: DraftMode | 'unknown';
	confidence?: number;
	rationale: string[];
	webQueries: string[];
};
type TokenUsageSummary = {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
};
const TONE_PRESETS: TonePreset[] = [
	{
		id: 'balanced',
		label: 'Balanced',
		detail: 'Neutral and collaborative',
		styleGuidance:
			'Use a neutral, collaborative tone. Keep wording concise and practical while remaining polite.',
	},
	{
		id: 'concise',
		label: 'Concise',
		detail: 'Short and direct',
		styleGuidance:
			'Keep the reply very short (2-4 sentences), direct, and easy to scan. Avoid unnecessary context.',
	},
	{
		id: 'supportive',
		label: 'Supportive',
		detail: 'Warm and appreciative',
		styleGuidance:
			'Sound appreciative and cooperative. Acknowledge the reviewer input clearly while staying technical.',
	},
	{
		id: 'firm',
		label: 'Firm but respectful',
		detail: 'Clear boundary with rationale',
		styleGuidance:
			'Be confident and firm, but respectful. Explain constraints and trade-offs without sounding defensive.',
	},
];
const STRATEGY_PRESETS: StrategyPreset[] = [
	{
		id: 'auto',
		label: 'Auto (recommended)',
		detail: 'Model decides agree / push-back / clarify based on evidence',
		instruction:
			'Decide the best strategy to reduce review loops and speed merge. Choose agree, pushback, or clarify based on code evidence.',
	},
	{
		id: 'agree',
		label: 'Force agree',
		detail: 'Acknowledge and accept reviewer direction',
		instruction:
			'Generate a reply that agrees with the reviewer and confirms concrete action.',
	},
	{
		id: 'pushback',
		label: 'Force push-back',
		detail: 'Respectfully disagree with technical rationale',
		instruction:
			'Generate a respectful push-back reply with clear technical rationale, constraints, or trade-offs.',
	},
	{
		id: 'clarify',
		label: 'Force clarify',
		detail: 'Ask focused question and propose path forward',
		instruction:
			'Generate a clarifying reply when requirements are ambiguous, with one focused question and a proposed next step.',
	},
];
const SKIPPED_IDENTIFIER_WORDS = new Set([
	'const',
	'let',
	'var',
	'function',
	'return',
	'if',
	'else',
	'for',
	'while',
	'switch',
	'case',
	'new',
	'class',
	'async',
	'await',
	'this',
	'true',
	'false',
	'null',
	'undefined',
	'import',
	'from',
	'export',
	'default',
]);
const execFileAsync = promisify(execFile);

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel(EXTENSION_NAME);
	context.subscriptions.push(output);
	output.appendLine('Activating extension.');
	let preferredModelId: string | undefined;

	const draftReplyCommand = vscode.commands.registerCommand(
		DRAFT_REPLY_COMMAND,
		async (commentContext?: unknown) => {
			try {
				const { commentText, commentThread, commentAuthor } = extractCommentData(commentContext);
				if (!commentText) {
					await vscode.window.showErrorMessage(
						'No comment text was found. Run this action directly from a pull request comment.',
					);
					return;
				}

				const additionalInstructions = await vscode.window.showInputBox({
					prompt: 'Optional: add extra guidance for this reply draft.',
					placeHolder:
						`Example: "I do not want to do that; provide a respectful technical reason."`,
					ignoreFocusOut: true,
				});
				if (additionalInstructions === undefined) {
					return;
				}

				const selectedTonePreset = await selectTonePreset();
				if (!selectedTonePreset) {
					return;
				}

				const selectedStrategyPreset = await selectStrategyPreset();
				if (!selectedStrategyPreset) {
					return;
				}

				const [codeContext, fullDiffContext] = await Promise.all([
					getCodeContext(commentThread),
					getFullPrDiffContext(commentThread),
				]);
				const threadContext = commentThread
					? getThreadConversationContext(commentThread)
					: undefined;
				const model = await getCopilotModel(preferredModelId);
				output.appendLine(`Draft command model: ${model.name} (${model.id})`);
				const result = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'Generating PR reply draft...',
						cancellable: false,
					},
					async (): Promise<AutoDecisionResult> => {
						if (selectedStrategyPreset.id === 'auto') {
							const pipeline = await runAutoDraftPipeline({
								model,
								commentText,
								additionalInstructions,
								selectedTonePreset,
								codeContext,
								threadContext,
								fullDiffContext,
								commentAuthor,
								strategyInstruction: selectedStrategyPreset.instruction,
							});
							return pipeline;
						}

						const forcedPrompt = buildForcedStrategyPrompt({
							mode: selectedStrategyPreset.id,
							commentText,
							additionalInstructions,
							selectedTonePreset,
							codeContext,
							threadContext,
							fullDiffContext,
							commentAuthor,
							strategyInstruction: selectedStrategyPreset.instruction,
						});
						const forcedMessages = [
							vscode.LanguageModelChatMessage.User(forcedPrompt),
						];
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
				});
				await vscode.env.clipboard.writeText(reply);
				output.appendLine(
					`Draft token usage - prompt: ${result.tokenUsage.promptTokens}, completion: ${result.tokenUsage.completionTokens}, total: ${result.tokenUsage.totalTokens}`,
				);
				await vscode.window.showInformationMessage(
					'Draft copied to clipboard with selected strategy metadata.',
				);
			} catch (error) {
				await vscode.window.showErrorMessage(getUserFacingErrorMessage(error));
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

	const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, async (
		request: vscode.ChatRequest,
		chatContext: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
	): Promise<void> => {
		void chatContext;
		try {
			if (!request.prompt.trim()) {
				stream.markdown('Please provide instructions so I can draft a PR reply.');
				return;
			}

			const model = request.model;
			preferredModelId = model.id;
			output.appendLine(`Chat participant model: ${model.name} (${model.id})`);
			const messages = [
				vscode.LanguageModelChatMessage.User(
					[
						'You are a senior software engineer helping draft GitHub pull request comment replies.',
						'Respond with concise, polite, constructive Markdown.',
						'If asked to rewrite, preserve technical intent and improve tone/clarity.',
						'',
						`User instructions:\n${request.prompt}`,
					].join('\n'),
				),
			];
			const response = await model.sendRequest(messages, {}, token);

			for await (const chunk of response.text) {
				if (token.isCancellationRequested) {
					return;
				}
				stream.markdown(toText(chunk));
			}
		} catch (error) {
			stream.markdown(getUserFacingErrorMessage(error));
		}
	});

	context.subscriptions.push(participant);
	output.appendLine(`Registered chat participant: ${PARTICIPANT_ID}`);
}

async function selectTonePreset(): Promise<TonePreset | undefined> {
	const quickPickItems = TONE_PRESETS.map((preset) => ({
		label: preset.label,
		description: preset.detail,
		preset,
	}));

	const selected = await vscode.window.showQuickPick(quickPickItems, {
		placeHolder: 'Select tone/strategy preset for reply drafts',
		ignoreFocusOut: true,
	});

	return selected?.preset;
}

async function selectStrategyPreset(): Promise<StrategyPreset | undefined> {
	const quickPickItems = STRATEGY_PRESETS.map((preset) => ({
		label: preset.label,
		description: preset.detail,
		preset,
	}));

	const selected = await vscode.window.showQuickPick(quickPickItems, {
		placeHolder: 'Select reply strategy',
		ignoreFocusOut: true,
	});

	return selected?.preset;
}

function formatSingleDraftOutput(params: {
	result: AutoDecisionResult;
	selectedTonePreset: TonePreset;
	selectedStrategyPreset: StrategyPreset;
}): string {
	const strategyLabel =
		params.selectedStrategyPreset.id === 'auto'
			? `Auto -> ${humanizeStrategy(params.result.selectedStrategy)}`
			: humanizeStrategy(params.selectedStrategyPreset.id);
	const confidenceText =
		typeof params.result.confidence === 'number'
			? `${Math.round(Math.max(0, Math.min(1, params.result.confidence)) * 100)}%`
			: 'n/a';
	return [
		`Tone preset: ${params.selectedTonePreset.label} (${params.selectedTonePreset.detail})`,
		`Strategy: ${strategyLabel}`,
		`Confidence: ${confidenceText}`,
		`Token usage: prompt ${params.result.tokenUsage.promptTokens}, completion ${params.result.tokenUsage.completionTokens}, total ${params.result.tokenUsage.totalTokens}`,
		...formatRationaleLines(params.result.rationale),
		'',
		'Draft reply:',
		params.result.reply.trim(),
	].join('\n');
}

function formatRationaleLines(rationale: string[]): string[] {
	if (!rationale.length) {
		return ['Rationale: n/a'];
	}

	return ['Rationale:', ...rationale.slice(0, 2).map((item) => `- ${item}`)];
}

function humanizeStrategy(strategy: DraftMode | 'unknown'): string {
	switch (strategy) {
		case 'agree':
			return 'Agree';
		case 'pushback':
			return 'Push-back with rationale';
		case 'clarify':
			return 'Clarify';
		default:
			return 'Unknown';
	}
}

function buildForcedStrategyPrompt(params: {
	mode: DraftMode;
	commentText: string;
	additionalInstructions: string;
	selectedTonePreset: TonePreset;
	strategyInstruction: string;
	codeContext?: string;
	threadContext?: string;
	fullDiffContext?: string;
	commentAuthor?: string;
}): string {
	const modeInstruction =
		params.mode === 'agree'
			? 'Generate a reply that agrees with the reviewer and confirms the intended action.'
			: params.mode === 'pushback'
				? 'Generate a reply that respectfully pushes back with a clear technical rationale, constraints, or trade-off explanation.'
				: 'Generate a reply that asks one focused clarifying question and proposes a next step.';
	const sections = [
		'You draft pull request comment replies.',
		'Write one concise, polite, constructive reply.',
		params.selectedTonePreset.styleGuidance,
		params.strategyInstruction,
		modeInstruction,
		'Do not use greetings or signatures.',
		'Return only the reply text in Markdown.',
		'',
		`PR comment:\n${params.commentText}`,
	];

	if (params.commentAuthor) {
		sections.push('', `Comment author: ${params.commentAuthor}`);
	}

	if (params.additionalInstructions.trim()) {
		sections.push('', `Extra user guidance:\n${params.additionalInstructions.trim()}`);
	}

	if (params.threadContext) {
		sections.push('', `Thread conversation:\n${params.threadContext}`);
	}

	if (params.codeContext) {
		sections.push('', `Code context:\n${params.codeContext}`);
	}

	if (params.fullDiffContext) {
		sections.push('', `PR scope (changed files):\n${params.fullDiffContext}`);
	}

	return sections.join('\n');
}

async function runAutoDraftPipeline(params: {
	model: vscode.LanguageModelChat;
	commentText: string;
	additionalInstructions: string;
	selectedTonePreset: TonePreset;
	strategyInstruction: string;
	codeContext?: string;
	threadContext?: string;
	fullDiffContext?: string;
	commentAuthor?: string;
}): Promise<AutoDecisionResult> {
	const judgeMessages = [vscode.LanguageModelChatMessage.User(buildJudgePrompt(params))];
	const judgeResult = await collectResponseWithUsage(params.model, judgeMessages);
	const judgeRaw = judgeResult.text;
	let judgeDecision = parseDecisionResponse(judgeRaw);
	let webContext: string | undefined;
	if ((judgeDecision.confidence ?? 0) < 0.7 || judgeDecision.webQueries.length > 0) {
		webContext = await fetchWebContextForDecision({
			commentText: params.commentText,
			webQueries: judgeDecision.webQueries,
		});
	}

	const criticMessages = [
		vscode.LanguageModelChatMessage.User(buildCriticPrompt(params, judgeDecision, webContext)),
	];
	const criticResult = await collectResponseWithUsage(params.model, criticMessages);
	const criticRaw = criticResult.text;
	const criticDecision = parseDecisionResponse(criticRaw);
	const chosenDecision = chooseStrongerDecision(judgeDecision, criticDecision);

	const writerPrompt = buildWriterPrompt({
		...params,
		decision: chosenDecision,
		webContext,
	});
	const writerMessages = [vscode.LanguageModelChatMessage.User(writerPrompt)];
	const writerResult = await collectResponseWithUsage(params.model, writerMessages);
	const reply = writerResult.text.trim();
	const tokenUsage = mergeTokenUsage([
		judgeResult.tokenUsage,
		criticResult.tokenUsage,
		writerResult.tokenUsage,
	]);
	if (!reply) {
		judgeDecision = chosenDecision;
		return {
			selectedStrategy: judgeDecision.selectedStrategy,
			confidence: judgeDecision.confidence,
			rationale: judgeDecision.rationale,
			reply: '[No draft generated]',
			tokenUsage,
		};
	}

	return {
		selectedStrategy: chosenDecision.selectedStrategy,
		confidence: chosenDecision.confidence,
		rationale: chosenDecision.rationale,
		reply,
		tokenUsage,
	};
}

function buildJudgePrompt(params: {
	commentText: string;
	additionalInstructions: string;
	selectedTonePreset: TonePreset;
	strategyInstruction: string;
	codeContext?: string;
	threadContext?: string;
	fullDiffContext?: string;
	commentAuthor?: string;
}): string {
	const sections = [
		'You are DecisionAgent for pull request replies.',
		params.strategyInstruction,
		params.selectedTonePreset.styleGuidance,
		'Decide best strategy to minimize review loops and speed merge: agree, pushback, or clarify.',
		'Rules: agree when reviewer is likely correct, pushback only with strong code evidence, otherwise clarify.',
		'Output strict JSON keys: selectedStrategy, confidence, rationale, webQueries.',
		'selectedStrategy one of: agree, pushback, clarify.',
		'confidence number between 0 and 1.',
		'rationale array with 1-2 concrete evidence bullets tied to code/diff context.',
		'webQueries array with up to 2 short search queries only if external docs are needed.',
		'Do not include markdown fences.',
		'',
		`PR comment:\n${params.commentText}`,
	];

	if (params.commentAuthor) {
		sections.push('', `Comment author: ${params.commentAuthor}`);
	}

	if (params.additionalInstructions.trim()) {
		sections.push('', `Extra user guidance:\n${params.additionalInstructions.trim()}`);
	}

	if (params.threadContext) {
		sections.push('', `Thread conversation:\n${params.threadContext}`);
	}

	if (params.codeContext) {
		sections.push('', `Code context:\n${params.codeContext}`);
	}

	if (params.fullDiffContext) {
		sections.push('', `PR scope (changed files):\n${params.fullDiffContext}`);
	}

	return sections.join('\n');
}

function buildCriticPrompt(
	params: {
		commentText: string;
		additionalInstructions: string;
		selectedTonePreset: TonePreset;
		strategyInstruction: string;
		codeContext?: string;
		threadContext?: string;
		fullDiffContext?: string;
		commentAuthor?: string;
	},
	judgeDecision: DecisionPayload,
	webContext?: string,
): string {
	const sections = [
		'You are CriticAgent for pull request reply strategy.',
		'Evaluate the DecisionAgent result and challenge weak assumptions.',
		'Prefer correctness over politeness bias.',
		'Return strict JSON keys: selectedStrategy, confidence, rationale, webQueries.',
		'Do not output markdown fences.',
		`DecisionAgent selected: ${judgeDecision.selectedStrategy} with confidence ${judgeDecision.confidence ?? 'n/a'}.`,
		`DecisionAgent rationale:\n${judgeDecision.rationale.map((line) => `- ${line}`).join('\n') || '- n/a'}`,
		'',
		`PR comment:\n${params.commentText}`,
	];
	if (params.commentAuthor) {
		sections.push('', `Comment author: ${params.commentAuthor}`);
	}
	if (params.additionalInstructions.trim()) {
		sections.push('', `Extra user guidance:\n${params.additionalInstructions.trim()}`);
	}
	if (params.threadContext) {
		sections.push('', `Thread conversation:\n${params.threadContext}`);
	}
	if (params.codeContext) {
		sections.push('', `Code context:\n${params.codeContext}`);
	}
	if (params.fullDiffContext) {
		sections.push('', `PR scope (changed files):\n${params.fullDiffContext}`);
	}
	if (webContext) {
		sections.push('', `Web documentation notes:\n${webContext}`);
	}
	return sections.join('\n');
}

function buildWriterPrompt(params: {
	commentText: string;
	additionalInstructions: string;
	selectedTonePreset: TonePreset;
	decision: DecisionPayload;
	webContext?: string;
	codeContext?: string;
	threadContext?: string;
	fullDiffContext?: string;
	commentAuthor?: string;
}): string {
	const strategyInstruction =
		params.decision.selectedStrategy === 'agree'
			? 'Write an agree-and-commit response with specific action.'
			: params.decision.selectedStrategy === 'pushback'
				? 'Write a respectful push-back response with technical rationale and an alternative.'
				: 'Write a clarifying response with one focused question and proposed next step.';
	const sections = [
		'You are WriterAgent for pull request comment replies.',
		params.selectedTonePreset.styleGuidance,
		strategyInstruction,
		'Keep response concise, constructive, and practical.',
		'No greetings or signatures. Return only reply Markdown.',
		`Chosen strategy: ${params.decision.selectedStrategy}`,
		`Evidence bullets:\n${params.decision.rationale.map((line) => `- ${line}`).join('\n') || '- n/a'}`,
		'',
		`PR comment:\n${params.commentText}`,
	];
	if (params.commentAuthor) {
		sections.push('', `Comment author: ${params.commentAuthor}`);
	}
	if (params.additionalInstructions.trim()) {
		sections.push('', `Extra user guidance:\n${params.additionalInstructions.trim()}`);
	}
	if (params.threadContext) {
		sections.push('', `Thread conversation:\n${params.threadContext}`);
	}
	if (params.codeContext) {
		sections.push('', `Code context:\n${params.codeContext}`);
	}
	if (params.fullDiffContext) {
		sections.push('', `PR scope (changed files):\n${params.fullDiffContext}`);
	}
	if (params.webContext) {
		sections.push('', `Web documentation notes:\n${params.webContext}`);
	}
	return sections.join('\n');
}

function parseDecisionResponse(raw: string): DecisionPayload {
	const normalized = stripMarkdownCodeFence(raw.trim());
	try {
		const parsed = JSON.parse(normalized) as {
			selectedStrategy?: unknown;
			confidence?: unknown;
			rationale?: unknown;
			webQueries?: unknown;
		};
		return {
			selectedStrategy: normalizeStrategy(parsed.selectedStrategy),
			confidence: normalizeConfidence(parsed.confidence),
			rationale: normalizeRationale(parsed.rationale),
			webQueries: normalizeWebQueries(parsed.webQueries),
		};
	} catch {
		return {
			selectedStrategy: 'unknown',
			confidence: undefined,
			rationale: [],
			webQueries: [],
		};
	}
}

function chooseStrongerDecision(primary: DecisionPayload, challenger: DecisionPayload): DecisionPayload {
	const p = primary.confidence ?? 0;
	const c = challenger.confidence ?? 0;
	if (challenger.selectedStrategy === 'unknown' && c <= p) {
		return primary;
	}
	if (c > p + 0.1) {
		return challenger;
	}
	return primary;
}

function stripMarkdownCodeFence(text: string): string {
	if (!text.startsWith('```')) {
		return text;
	}

	return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function normalizeStrategy(value: unknown): DraftMode | 'unknown' {
	if (typeof value !== 'string') {
		return 'unknown';
	}
	const lower = value.toLowerCase().trim();
	if (lower === 'agree' || lower.startsWith('agree')) {
		return 'agree';
	}
	if (lower === 'pushback' || lower.startsWith('push')) {
		return 'pushback';
	}
	if (lower === 'clarify' || lower.startsWith('clarif')) {
		return 'clarify';
	}
	return 'unknown';
}

function normalizeConfidence(value: unknown): number | undefined {
	if (typeof value !== 'number' || Number.isNaN(value)) {
		return undefined;
	}

	return Math.max(0, Math.min(1, value));
}

function normalizeRationale(value: unknown): string[] {
	if (typeof value === 'string' && value.trim()) {
		return [value.trim()];
	}
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.filter((item): item is string => typeof item === 'string')
		.map((item) => item.trim())
		.filter((item) => Boolean(item))
		.slice(0, 2);
}

function normalizeWebQueries(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.filter((item): item is string => typeof item === 'string')
		.map((item) => item.trim())
		.filter((item) => Boolean(item))
		.slice(0, MAX_WEB_QUERY_COUNT);
}

async function fetchWebContextForDecision(params: {
	commentText: string;
	webQueries: string[];
}): Promise<string | undefined> {
	const fallbackQuery = params.commentText.split('\n')[0]?.trim().slice(0, 100);
	const queries = (params.webQueries.length ? params.webQueries : [fallbackQuery])
		.filter((query): query is string => Boolean(query))
		.slice(0, MAX_WEB_QUERY_COUNT);
	if (!queries.length) {
		return undefined;
	}

	const summaries: string[] = [];
	for (const query of queries) {
		const summary = await fetchDuckDuckGoSummary(query);
		if (summary) {
			summaries.push(`Query: ${query}\n${summary}`);
		}
	}

	if (!summaries.length) {
		return undefined;
	}

	return truncateText(
		summaries.join('\n\n'),
		MAX_WEB_SUMMARY_CHARS,
		'[Web context truncated due to length.]',
	);
}

async function fetchDuckDuckGoSummary(query: string): Promise<string | undefined> {
	try {
		const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`;
		const response = await fetch(url);
		if (!response.ok) {
			return undefined;
		}
		const payload = (await response.json()) as {
			AbstractText?: string;
			AbstractURL?: string;
			Heading?: string;
			RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
		};

		if (payload.AbstractText) {
			const heading = payload.Heading ? `${payload.Heading}: ` : '';
			const source = payload.AbstractURL ? `\nSource: ${payload.AbstractURL}` : '';
			return `${heading}${payload.AbstractText}${source}`;
		}

		const related = payload.RelatedTopics?.find((item) => item.Text);
		if (related?.Text) {
			const source = related.FirstURL ? `\nSource: ${related.FirstURL}` : '';
			return `${related.Text}${source}`;
		}

		return undefined;
	} catch {
		return undefined;
	}
}

function extractCommentData(commentContext?: unknown): {
	commentText?: string;
	commentThread?: vscode.CommentThread;
	commentAuthor?: string;
} {
	if (!commentContext || typeof commentContext !== 'object') {
		return {};
	}

	const directComment = commentContext as Partial<vscode.Comment>;
	if (directComment.body !== undefined) {
		return {
			commentText: normalizeCommentBody(directComment.body),
			commentThread: extractCommentThread(commentContext),
			commentAuthor: directComment.author?.name,
		};
	}

	const nestedComment = (commentContext as { comment?: vscode.Comment }).comment;
	if (nestedComment?.body !== undefined) {
		return {
			commentText: normalizeCommentBody(nestedComment.body),
			commentThread: extractCommentThread(commentContext),
			commentAuthor: nestedComment.author?.name,
		};
	}

	return {
		commentThread: extractCommentThread(commentContext),
	};
}

function normalizeCommentBody(body: string | vscode.MarkdownString): string {
	return typeof body === 'string' ? body : body.value;
}

function extractCommentThread(commentContext: unknown): vscode.CommentThread | undefined {
	if (!commentContext || typeof commentContext !== 'object') {
		return undefined;
	}

	const threadContext = commentContext as {
		commentThread?: vscode.CommentThread;
		thread?: vscode.CommentThread;
	};

	return threadContext.commentThread ?? threadContext.thread;
}

function getThreadConversationContext(commentThread: vscode.CommentThread): string | undefined {
	const { comments, label } = commentThread;
	if (!comments.length) {
		return undefined;
	}

	const lines: string[] = [];

	if (label) {
		lines.push(`Thread label: ${label}`);
	}

	const stateText =
		commentThread.state === vscode.CommentThreadState.Resolved ? 'Resolved' : 'Unresolved';
	lines.push(`Thread state: ${stateText}`);
	lines.push(`Thread history (${comments.length} comment${comments.length !== 1 ? 's' : ''}):`);

	for (const comment of comments) {
		const author = comment.author?.name ?? 'Unknown';
		const body = normalizeCommentBody(comment.body).trim();
		lines.push(`[${author}]: ${body}`);
	}

	return lines.join('\n');
}

async function getFullPrDiffContext(
	commentThread?: vscode.CommentThread,
): Promise<string | undefined> {
	const uri = commentThread?.uri;
	const folder = uri
		? vscode.workspace.getWorkspaceFolder(uri)
		: vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return undefined;
	}

	const cwd = folder.uri.fsPath;

	const workingTreeStat = await runGitDiff(['diff', '--stat'], cwd);
	if (workingTreeStat) {
		return truncateText(
			`Changed files (working tree):\n${workingTreeStat}`,
			MAX_PR_STAT_CHARS,
			'[PR stat truncated due to length.]',
		);
	}

	const stagedStat = await runGitDiff(['diff', '--cached', '--stat'], cwd);
	if (stagedStat) {
		return truncateText(
			`Changed files (staged):\n${stagedStat}`,
			MAX_PR_STAT_CHARS,
			'[PR stat truncated due to length.]',
		);
	}

	const lastCommitStat = await runGitDiff(['diff', '--stat', 'HEAD~1', 'HEAD'], cwd);
	if (lastCommitStat) {
		return truncateText(
			`Changed files (last commit):\n${lastCommitStat}`,
			MAX_PR_STAT_CHARS,
			'[PR stat truncated due to length.]',
		);
	}

	return undefined;
}

async function getCodeContext(commentThread?: vscode.CommentThread): Promise<string | undefined> {
	if (!commentThread?.uri || !commentThread.range) {
		return undefined;
	}

	try {
		const document = await vscode.workspace.openTextDocument(commentThread.uri);
		const startLine = Math.max(0, commentThread.range.start.line - CONTEXT_LINES);
		const endLine = Math.min(document.lineCount - 1, commentThread.range.end.line + CONTEXT_LINES);
		const code = [];
		for (let i = startLine; i <= endLine; i += 1) {
			code.push(`${i + 1}: ${document.lineAt(i).text}`);
		}

		const relativePath = vscode.workspace.asRelativePath(commentThread.uri, false);
		const baseContext = [
			`File: ${relativePath}`,
			`Commented range: lines ${commentThread.range.start.line + 1}-${commentThread.range.end.line + 1}`,
			'Nearby lines:',
			code.join('\n'),
		].join('\n');
		const [relatedContext, diffContext] = await Promise.all([
			getRelatedWorkspaceContext(document, commentThread.range),
			getFileDiffContext(document, commentThread.range),
		]);
		const sections: string[] = [baseContext];

		if (diffContext) {
			sections.push('', 'Diff context (changes related to this file):', diffContext);
		}

		if (relatedContext.length) {
			sections.push(
				'',
				'Related workspace context (potentially relevant references):',
				relatedContext.join('\n\n'),
			);
		}

		return truncateContext(sections.join('\n'));
	} catch {
		return undefined;
	}
}

async function getFileDiffContext(
	document: vscode.TextDocument,
	commentRange: vscode.Range,
): Promise<string | undefined> {
	const folder = vscode.workspace.getWorkspaceFolder(document.uri);
	if (!folder) {
		return undefined;
	}

	const relativePath = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, '/');
	const cwd = folder.uri.fsPath;
	const diffSections: string[] = [];

	const workingTreeDiff = await runGitDiff([
		'diff',
		`--unified=${DIFF_UNIFIED_LINES}`,
		'--',
		relativePath,
	], cwd);
	if (workingTreeDiff) {
		diffSections.push(`Working tree diff:\n${workingTreeDiff}`);
	}

	const stagedDiff = await runGitDiff([
		'diff',
		'--cached',
		`--unified=${DIFF_UNIFIED_LINES}`,
		'--',
		relativePath,
	], cwd);
	if (stagedDiff) {
		diffSections.push(`Staged diff:\n${stagedDiff}`);
	}

	if (!diffSections.length) {
		const lastCommitDiff = await runGitDiff([
			'diff',
			`--unified=${DIFF_UNIFIED_LINES}`,
			'HEAD~1',
			'HEAD',
			'--',
			relativePath,
		], cwd);
		if (lastCommitDiff) {
			diffSections.push(`Last commit diff:\n${lastCommitDiff}`);
		}
	}

	if (!diffSections.length) {
		return undefined;
	}

	const startLine = commentRange.start.line + 1;
	const endLine = commentRange.end.line + 1;
	const focusedSections = diffSections
		.map((section) => {
			const lines = section.split('\n');
			const title = lines[0];
			const diffBody = lines.slice(1).join('\n');
			const focused = extractRelevantDiffHunks(diffBody, startLine, endLine);
			if (!focused) {
				return undefined;
			}

			return `${title}\n${focused}`;
		})
		.filter((value): value is string => Boolean(value));

	const combined = (focusedSections.length ? focusedSections : diffSections).join('\n\n');
	return truncateText(combined, MAX_DIFF_CONTEXT_CHARS, '[Diff context truncated due to length.]');
}

async function runGitDiff(args: string[], cwd: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync('git', args, {
			cwd,
			timeout: 3000,
			maxBuffer: 1024 * 1024,
		});
		const trimmed = stdout.trim();
		return trimmed ? trimmed : undefined;
	} catch {
		return undefined;
	}
}

function extractRelevantDiffHunks(
	diffText: string,
	commentStartLine: number,
	commentEndLine: number,
): string | undefined {
	if (!diffText.trim()) {
		return undefined;
	}

	type Hunk = { header: string; lines: string[]; start: number; end: number };
	const hunks: Hunk[] = [];
	const lines = diffText.split('\n');
	let current: Hunk | undefined;
	for (const line of lines) {
		const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
		if (match) {
			if (current) {
				hunks.push(current);
			}
			const start = Number.parseInt(match[1], 10);
			const count = match[2] ? Number.parseInt(match[2], 10) : 1;
			current = {
				header: line,
				lines: [],
				start,
				end: Math.max(start, start + count - 1),
			};
			continue;
		}

		if (current) {
			current.lines.push(line);
		}
	}
	if (current) {
		hunks.push(current);
	}

	if (!hunks.length) {
		return truncateText(diffText, MAX_DIFF_CONTEXT_CHARS, '[Diff context truncated due to length.]');
	}

	const overlapping = hunks.filter((hunk) => {
		return hunk.start <= commentEndLine && hunk.end >= commentStartLine;
	});
	const selected = (overlapping.length ? overlapping : hunks).slice(0, 2);
	return selected.map((hunk) => `${hunk.header}\n${hunk.lines.join('\n')}`.trimEnd()).join('\n\n');
}

async function getRelatedWorkspaceContext(
	document: vscode.TextDocument,
	range: vscode.Range,
): Promise<string[]> {
	const queries = extractIdentifierQueries(document, range);
	if (!queries.length) {
		return [];
	}

	const snippets: string[] = [];
	const seenLocations = new Set<string>();

	for (const query of queries) {
		if (snippets.length >= MAX_RELATED_SNIPPETS) {
			break;
		}

		const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
			'vscode.executeWorkspaceSymbolProvider',
			query,
		);
		if (!symbols?.length) {
			continue;
		}

		for (const symbol of symbols) {
			if (snippets.length >= MAX_RELATED_SNIPPETS) {
				break;
			}

			const location = symbol.location;
			if (
				location.uri.toString() === document.uri.toString() &&
				range.intersection(location.range)
			) {
				continue;
			}

			const key = `${location.uri.toString()}:${location.range.start.line}`;
			if (seenLocations.has(key)) {
				continue;
			}
			seenLocations.add(key);

			const snippet = await buildLocationSnippet(symbol.name, location);
			if (snippet) {
				snippets.push(snippet);
			}
		}
	}

	return snippets;
}

function extractIdentifierQueries(document: vscode.TextDocument, range: vscode.Range): string[] {
	const queries: string[] = [];
	const seen = new Set<string>();
	for (let line = range.start.line; line <= range.end.line; line += 1) {
		const lineText = document.lineAt(line).text;
		const matches = lineText.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? [];
		for (const match of matches) {
			if (seen.has(match) || SKIPPED_IDENTIFIER_WORDS.has(match)) {
				continue;
			}
			seen.add(match);
			queries.push(match);
			if (queries.length >= MAX_SYMBOL_QUERIES) {
				return queries;
			}
		}
	}

	return queries;
}

async function buildLocationSnippet(
	symbolName: string,
	location: vscode.Location,
): Promise<string | undefined> {
	try {
		const doc = await vscode.workspace.openTextDocument(location.uri);
		const start = Math.max(0, location.range.start.line - RELATED_SNIPPET_LINES);
		const end = Math.min(doc.lineCount - 1, location.range.end.line + RELATED_SNIPPET_LINES);
		const lines: string[] = [];
		for (let line = start; line <= end; line += 1) {
			lines.push(`${line + 1}: ${doc.lineAt(line).text}`);
		}

		return [
			`Symbol: ${symbolName}`,
			`File: ${vscode.workspace.asRelativePath(location.uri, false)}`,
			`Lines: ${location.range.start.line + 1}-${location.range.end.line + 1}`,
			lines.join('\n'),
		].join('\n');
	} catch {
		return undefined;
	}
}

function truncateContext(text: string): string {
	return truncateText(text, MAX_CONTEXT_CHARS, '[Context truncated due to length.]');
}

function truncateText(text: string, maxChars: number, suffix: string): string {
	if (text.length <= maxChars) {
		return text;
	}

	return `${text.slice(0, maxChars)}\n\n${suffix}`;
}

async function getCopilotModel(preferredModelId?: string): Promise<vscode.LanguageModelChat> {
	if (!hasLmApi()) {
		throw new Error(
			'The Language Model API is unavailable in this editor build. Update VS Code/Cursor and ensure Copilot Chat is enabled.',
		);
	}

	if (preferredModelId) {
		const preferred = await vscode.lm.selectChatModels({ id: preferredModelId });
		if (preferred.length) {
			return preferred[0];
		}
	}

	const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
	if (!models.length) {
		throw new Error(
			'No Copilot language model is available. Sign in to GitHub Copilot and ensure chat access is enabled.',
		);
	}

	return models[0];
}

function hasLmApi(): boolean {
	const api = (vscode as unknown as { lm?: { selectChatModels?: unknown } }).lm;
	return typeof api?.selectChatModels === 'function';
}

function hasChatParticipantApi(): boolean {
	const api = (vscode as unknown as { chat?: { createChatParticipant?: unknown } }).chat;
	return typeof api?.createChatParticipant === 'function';
}

async function collectResponseText(
	model: vscode.LanguageModelChat,
	messages: vscode.LanguageModelChatMessage[],
): Promise<string> {
	const response = await model.sendRequest(messages, {});
	let output = '';

	for await (const chunk of response.text) {
		output += toText(chunk);
	}

	return output;
}

async function collectResponseWithUsage(
	model: vscode.LanguageModelChat,
	messages: vscode.LanguageModelChatMessage[],
): Promise<{ text: string; tokenUsage: TokenUsageSummary }> {
	const text = await collectResponseText(model, messages);
	const tokenUsage = await estimateTokenUsage(model, messages, text);
	return { text, tokenUsage };
}

async function estimateTokenUsage(
	model: vscode.LanguageModelChat,
	messages: vscode.LanguageModelChatMessage[],
	completionText: string,
): Promise<TokenUsageSummary> {
	const promptCounts = await Promise.all(messages.map((message) => countTokensBestEffort(model, message)));
	const promptTokens = promptCounts.reduce((sum, count) => sum + count, 0);
	const completionTokens = await countTokensBestEffort(model, completionText);
	return {
		promptTokens,
		completionTokens,
		totalTokens: promptTokens + completionTokens,
	};
}

async function countTokensBestEffort(
	model: vscode.LanguageModelChat,
	input: string | vscode.LanguageModelChatMessage,
): Promise<number> {
	try {
		const exact = await model.countTokens(input);
		if (Number.isFinite(exact) && exact > 0) {
			return exact;
		}
	} catch {
		// Fall through to approximation.
	}

	const text = typeof input === 'string' ? input : '';
	return approximateTokenCount(text);
}

function approximateTokenCount(text: string): number {
	if (!text.trim()) {
		return 0;
	}

	return Math.max(1, Math.ceil(text.length / 4));
}

function mergeTokenUsage(usages: TokenUsageSummary[]): TokenUsageSummary {
	return usages.reduce(
		(acc, usage) => ({
			promptTokens: acc.promptTokens + usage.promptTokens,
			completionTokens: acc.completionTokens + usage.completionTokens,
			totalTokens: acc.totalTokens + usage.totalTokens,
		}),
		{ promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	);
}

function toText(chunk: unknown): string {
	if (typeof chunk === 'string') {
		return chunk;
	}

	if (chunk && typeof chunk === 'object' && 'value' in chunk) {
		const value = (chunk as { value?: unknown }).value;
		return typeof value === 'string' ? value : '';
	}

	return '';
}

function getUserFacingErrorMessage(error: unknown): string {
	const details = error instanceof Error ? error.message : String(error);
	const lower = details.toLowerCase();

	if (
		lower.includes('not found') ||
		lower.includes('no copilot language model') ||
		lower.includes('unavailable')
	) {
		return 'Copilot model unavailable. Sign in to GitHub Copilot and make sure chat models are enabled.';
	}

	if (
		lower.includes('auth') ||
		lower.includes('sign in') ||
		lower.includes('unauthorized') ||
		lower.includes('forbidden')
	) {
		return 'Copilot authentication is required. Sign in to GitHub and verify your Copilot subscription.';
	}

	return `${EXTENSION_NAME} failed: ${details}`;
}

export function deactivate(): void {}
