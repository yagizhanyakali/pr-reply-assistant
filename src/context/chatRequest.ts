import * as vscode from 'vscode';
import {
	CONTEXT_MODE_PRESETS,
	ContextModePreset,
	StrategyPreset,
	TONE_PRESETS,
	TonePreset,
	getStrategyPresetById,
	getTonePresetById,
} from '../presets';
import { getCodeContextFromReference } from './code';
import { getSymbolEvidenceContextFromReference } from './evidence';
import { getComprehensiveContextForReference } from './comprehensive';
import { getFullPrDiffContextForUri } from './git';

export type ResolvedChatContext = {
	commentText?: string;
	commentAuthor?: string;
	threadContext?: string;
	codeContext?: string;
	fullDiffContext?: string;
	symbolEvidenceContext?: string;
	targetUri?: vscode.Uri;
	targetRange?: vscode.Range;
	comprehensiveContext?: string;
};

export async function resolveChatRequestContext(
	request: vscode.ChatRequest,
): Promise<ResolvedChatContext> {
	const commentFromReference = pickCommentReference(request.references);
	const locationReference = pickLocationReference(request.references);
	const uriReference = pickUriReference(request.references);
	const commentTextFromPrompt = extractCommentFromPrompt(request.prompt);
	const targetUri = locationReference?.uri ?? uriReference;
	const targetRange = locationReference?.range;
	const codeContext = await getCodeContextFromReference(locationReference, uriReference);
	const fullDiffContext = await getFullPrDiffContextForUri(targetUri);
	const commentText = commentFromReference?.text ?? commentTextFromPrompt;
	const commentAuthor = commentFromReference?.author;
	const symbolEvidenceContext = await getSymbolEvidenceContextFromReference(
		commentText,
		locationReference,
		uriReference,
	);
	const comprehensiveContext = await getComprehensiveContextForReference(
		commentText,
		locationReference,
		uriReference,
	);

	return {
		commentText,
		commentAuthor,
		threadContext: commentFromReference?.threadContext,
		codeContext,
		fullDiffContext,
		symbolEvidenceContext,
		targetUri,
		targetRange,
		comprehensiveContext,
	};
}

export function inferTonePresetFromPrompt(prompt: string): TonePreset {
	const lower = prompt.toLowerCase();
	if (/\bconcise\b|\bshort\b|\bbrief\b/.test(lower)) {
		return getTonePresetById('concise');
	}
	if (/\bsupportive\b|\bwarm\b|\bappreciative\b/.test(lower)) {
		return getTonePresetById('supportive');
	}
	if (/\bfirm\b|\bstrict\b|\bstrong\b/.test(lower)) {
		return getTonePresetById('firm');
	}
	return getTonePresetById('balanced');
}

export function inferStrategyPresetFromPrompt(prompt: string): StrategyPreset {
	const lower = prompt.toLowerCase();
	if (/\bpush[- ]?back\b|\bdisagree\b|\breject\b|\bnot do that\b/.test(lower)) {
		return getStrategyPresetById('pushback');
	}
	if (/\bagree\b|\baccept\b|\bwill do\b|\bi'll do\b/.test(lower)) {
		return getStrategyPresetById('agree');
	}
	if (/\bclarify\b|\bquestion\b|\bask\b/.test(lower)) {
		return getStrategyPresetById('clarify');
	}
	return getStrategyPresetById('auto');
}

export function inferContextModeFromPrompt(prompt: string): ContextModePreset {
	const lower = prompt.toLowerCase();
	if (
		lower.includes('deep context') ||
		lower.includes('full context') ||
		lower.includes('all context') ||
		lower.includes('tum context')
	) {
		return CONTEXT_MODE_PRESETS.find((preset) => preset.id === 'deep') ?? CONTEXT_MODE_PRESETS[0];
	}
	return CONTEXT_MODE_PRESETS.find((preset) => preset.id === 'standard') ?? CONTEXT_MODE_PRESETS[0];
}

function pickCommentReference(
	references: readonly vscode.ChatPromptReference[],
): { text: string; author?: string; threadContext?: string } | undefined {
	const candidates: Array<{
		score: number;
		text: string;
		author?: string;
		threadContext?: string;
	}> = [];
	for (const reference of references) {
		if (typeof reference.value !== 'string') {
			continue;
		}
		const text = reference.value.trim();
		if (!text) {
			continue;
		}
		const marker = `${reference.id} ${reference.modelDescription ?? ''}`.toLowerCase();
		let score = Math.min(2, Math.floor(text.length / 80));
		if (marker.includes('comment') || marker.includes('review')) {
			score += 3;
		}
		if (marker.includes('thread') || marker.includes('conversation')) {
			score += 2;
		}
		const parsed = parseCommentStringReference(text);
		if (parsed.commentAuthor) {
			score += 1;
		}
		candidates.push({
			score,
			text: parsed.commentText,
			author: parsed.commentAuthor,
			threadContext: parsed.threadContext,
		});
	}

	candidates.sort((a, b) => b.score - a.score);
	const winner = candidates[0];
	if (!winner?.text) {
		return undefined;
	}
	return {
		text: winner.text,
		author: winner.author,
		threadContext: winner.threadContext,
	};
}

function parseCommentStringReference(value: string): {
	commentText: string;
	commentAuthor?: string;
	threadContext?: string;
} {
	const lines = value.split('\n').map((line) => line.trim()).filter((line) => Boolean(line));
	if (!lines.length) {
		return { commentText: value.trim() };
	}
	const authorLine = lines.find((line) => /^author:\s*/i.test(line));
	const commentLine = lines.find((line) => /^comment:\s*/i.test(line));
	const threadIndex = lines.findIndex((line) => /^thread:\s*/i.test(line));

	const commentAuthor = authorLine?.replace(/^author:\s*/i, '').trim() || undefined;
	let commentText = commentLine?.replace(/^comment:\s*/i, '').trim();
	if (!commentText) {
		commentText = lines[0];
	}
	const threadContext =
		threadIndex >= 0 ? lines.slice(threadIndex).join('\n').replace(/^thread:\s*/i, '') : undefined;

	return { commentText, commentAuthor, threadContext };
}

function pickLocationReference(
	references: readonly vscode.ChatPromptReference[],
): vscode.Location | undefined {
	for (const reference of references) {
		const value = reference.value;
		if (value instanceof vscode.Location) {
			return value;
		}
	}
	return undefined;
}

function pickUriReference(
	references: readonly vscode.ChatPromptReference[],
): vscode.Uri | undefined {
	for (const reference of references) {
		const value = reference.value;
		if (value instanceof vscode.Uri) {
			return value;
		}
	}
	return undefined;
}

function extractCommentFromPrompt(prompt: string): string | undefined {
	const quotedBlock = prompt.match(/"([^"]{20,})"/s);
	if (quotedBlock?.[1]) {
		return quotedBlock[1].trim();
	}
	const commentMatch = prompt.match(/comment\s*:\s*([\s\S]+)/i);
	if (commentMatch?.[1]) {
		return commentMatch[1].trim();
	}
	return undefined;
}

// Re-exports so the chat handler doesn't need to know which module owns these.
export { TONE_PRESETS };
