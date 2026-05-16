import * as vscode from 'vscode';
import { EvidenceItem, runQualityDraftPipeline } from '../agents';
import { collectResponseWithUsage } from '../llmClient';
import { DraftMode, TonePreset } from '../presets';
import { getActiveEditorRangeForUri } from '../context/comment';
import { buildAnchorEvidence } from '../context/anchor';
import { applyAnchorGate, applySafetyGate } from './gates';
import { buildContextToolRegistry } from './tools';
import { AutoDecisionResult, PipelineDetailSummary } from './types';

export type AutoDraftParams = {
	model: vscode.LanguageModelChat;
	commentText: string;
	additionalInstructions: string;
	selectedTonePreset: TonePreset;
	strategyInstruction: string;
	codeContext?: string;
	threadContext?: string;
	fullDiffContext?: string;
	symbolEvidenceContext?: string;
	deepContext?: string;
	comprehensiveContext?: string;
	commentThread?: vscode.CommentThread;
	commentUri?: vscode.Uri;
	commentRange?: vscode.Range;
	logger?: (line: string) => void;
	commentAuthor?: string;
	language?: string;
	personalToneExamples?: string;
};

export type ForcedDraftParams = {
	model: vscode.LanguageModelChat;
	mode: DraftMode;
	commentText: string;
	additionalInstructions: string;
	selectedTonePreset: TonePreset;
	strategyInstruction: string;
	codeContext?: string;
	threadContext?: string;
	fullDiffContext?: string;
	symbolEvidenceContext?: string;
	deepContext?: string;
	comprehensiveContext?: string;
	commentAuthor?: string;
	language?: string;
	personalToneExamples?: string;
};

export async function runAutoDraftPipeline(params: AutoDraftParams): Promise<AutoDecisionResult> {
	const effectiveUri = params.commentUri ?? params.commentThread?.uri;
	const providedRange = params.commentRange ?? params.commentThread?.range;
	const fallbackRange = providedRange ?? getActiveEditorRangeForUri(effectiveUri);
	const effectiveRange = fallbackRange;
	const anchorVerified = Boolean(providedRange);

	const tools = buildContextToolRegistry({
		commentText: params.commentText,
		commentUri: effectiveUri,
		commentRange: effectiveRange,
	});

	const { locationHint, seedEvidence, seedGaps } = await buildAnchorEvidence({
		commentText: params.commentText,
		commentUri: effectiveUri,
		commentRange: effectiveRange,
	});

	if (!anchorVerified && fallbackRange && params.logger) {
		params.logger('Anchor: host did not provide a comment range; using active editor selection/cursor as anchor (unverified).');
	} else if (!anchorVerified && !fallbackRange && params.logger) {
		params.logger('Anchor: comment range not provided by host and no editor fallback available — pipeline will default to clarify.');
	}

	let mergedSeedEvidence: EvidenceItem[] = seedEvidence ?? [];
	if (params.deepContext?.trim()) {
		mergedSeedEvidence = [
			...mergedSeedEvidence,
			{
				id: `E${mergedSeedEvidence.length + 1}`,
				kind: 'note',
				source: 'deep_context (pre-seeded by Deep depth setting)',
				summary: 'Available-change diagnostics + detailed diffs gathered upfront because the user opted into Deep depth.',
				content: params.deepContext,
			},
		];
		params.logger?.('Depth: pre-seeded deep_context as additional evidence.');
	}

	const pipeline = await runQualityDraftPipeline({
		model: params.model,
		commentText: params.commentText,
		commentAuthor: params.commentAuthor,
		additionalInstructions: params.additionalInstructions,
		threadContext: params.threadContext,
		tonePreset: {
			id: params.selectedTonePreset.id,
			label: params.selectedTonePreset.label,
			detail: params.selectedTonePreset.detail,
			styleGuidance: params.selectedTonePreset.styleGuidance,
		},
		strategyInstruction: params.strategyInstruction,
		tools,
		logger: params.logger,
		commentLocationHint: locationHint,
		seedEvidence: mergedSeedEvidence.length ? mergedSeedEvidence : undefined,
		seedGaps,
		language: params.language,
		personalToneExamples: params.personalToneExamples,
	});

	const arbiter = pipeline.decision;
	const relativeFilePath = effectiveUri
		? vscode.workspace.asRelativePath(effectiveUri, false).replace(/\\/g, '/')
		: undefined;

	const anchorGated = applyAnchorGate({
		anchorVerified,
		strategy: arbiter.selectedStrategy,
		confidence: arbiter.confidence,
		rationale: arbiter.rationale,
		reply: arbiter.reply.trim(),
		relativeFilePath,
	});

	const safetyGated = applySafetyGate({
		commentText: params.commentText,
		additionalInstructions: params.additionalInstructions,
		symbolEvidenceContext: params.symbolEvidenceContext,
		strategy: anchorGated.strategy,
		confidence: anchorGated.confidence,
		rationale: anchorGated.rationale,
		reply: anchorGated.reply,
	});

	const details: PipelineDetailSummary = {
		deciderStrategy: pipeline.deciderDecision.selectedStrategy,
		deciderConfidence: pipeline.deciderDecision.confidence,
		criticStrategy: pipeline.criticDecision.selectedStrategy,
		criticConfidence: pipeline.criticDecision.confidence,
		criticAgreement: arbiter.criticAgreement,
		criticDissent: pipeline.criticDecision.dissent,
		citations: arbiter.citations,
		evidenceCount: pipeline.evidencePack.items.length,
		plannerIterations: pipeline.plannerIterations,
		gaps: pipeline.evidencePack.gaps,
		anchorVerified,
		anchorOverrideApplied: !anchorVerified,
	};

	return {
		selectedStrategy: safetyGated.strategy,
		confidence: safetyGated.confidence,
		rationale: safetyGated.rationale,
		reply: safetyGated.reply || anchorGated.reply || '[No draft generated]',
		tokenUsage: pipeline.tokenUsage,
		pipelineDetails: details,
	};
}

export async function runForcedDraftPipeline(params: ForcedDraftParams): Promise<AutoDecisionResult> {
	const forcedPrompt = buildForcedStrategyPrompt(params);
	const forcedMessages = [vscode.LanguageModelChatMessage.User(forcedPrompt)];
	const { text, tokenUsage } = await collectResponseWithUsage(params.model, forcedMessages);
	return {
		selectedStrategy: params.mode,
		confidence: undefined,
		rationale: [],
		reply: text.trim(),
		tokenUsage,
	};
}

export function buildForcedStrategyPrompt(params: {
	mode: DraftMode;
	commentText: string;
	additionalInstructions: string;
	selectedTonePreset: TonePreset;
	strategyInstruction: string;
	codeContext?: string;
	threadContext?: string;
	fullDiffContext?: string;
	symbolEvidenceContext?: string;
	deepContext?: string;
	comprehensiveContext?: string;
	commentAuthor?: string;
	language?: string;
	personalToneExamples?: string;
}): string {
	const modeInstruction =
		params.mode === 'agree'
			? 'Generate a reply that agrees with the reviewer and confirms the intended action.'
			: params.mode === 'pushback'
				? 'Generate a reply that respectfully pushes back with a clear technical rationale, constraints, or trade-off explanation.'
				: 'Generate a reply that asks one focused clarifying question and proposes a next step.';
	const language = params.language?.trim() || 'English';
	const sections = [
		'You draft pull request comment replies.',
		'Write one concise, polite, constructive reply.',
		params.selectedTonePreset.styleGuidance,
		params.strategyInstruction,
		modeInstruction,
		buildPersonalTonePromptSection(params.personalToneExamples),
		`Write the reply in ${language}.`,
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
		sections.push('', `Available change context (changed files):\n${params.fullDiffContext}`);
	}
	if (params.symbolEvidenceContext) {
		sections.push('', `Structured symbol evidence:\n${params.symbolEvidenceContext}`);
	}
	if (params.deepContext) {
		sections.push('', `Deep context:\n${params.deepContext}`);
	}
	if (params.comprehensiveContext) {
		sections.push('', `Comprehensive context:\n${params.comprehensiveContext}`);
	}

	return sections.join('\n');
}

function buildPersonalTonePromptSection(examples?: string): string {
	const trimmed = examples?.trim();
	if (!trimmed) {
		return 'No personal tone examples were provided.';
	}
	const clipped =
		trimmed.length > 1_800 ? `${trimmed.slice(0, 1_800)}\n[Personal tone examples truncated]` : trimmed;
	return [
		'Use the following previous PR replies only as style guidance.',
		'Match the author\'s directness, warmth, and rhythm, but do not copy private details, names, exact sentences, or distinctive phrases unnecessarily.',
		`Personal tone examples:\n${clipped}`,
	].join('\n');
}
