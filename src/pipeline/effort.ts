import { ContextModePreset, StrategyPreset } from '../presets';

export type DraftEffort = 'fast' | 'standard' | 'deep';

export function routeDraftEffort(params: {
	commentText: string;
	additionalInstructions?: string;
	strategy: StrategyPreset['id'];
	contextDepth: ContextModePreset['id'];
	anchorVerified: boolean;
}): DraftEffort {
	const text = `${params.commentText}\n${params.additionalInstructions ?? ''}`.toLowerCase();
	if (params.contextDepth === 'deep' || asksForDeepContext(text) || looksBroad(text)) {
		return 'deep';
	}
	if (params.anchorVerified && params.strategy !== 'auto') {
		return 'fast';
	}
	if (params.anchorVerified && looksSimpleAcknowledge(text)) {
		return 'fast';
	}
	return 'standard';
}

function asksForDeepContext(text: string): boolean {
	return /\b(deep|full|all|whole|entire)\s+(context|diff|pr|change|codebase)\b/.test(text);
}

function looksBroad(text: string): boolean {
	return /\b(architecture|architectural|cross-file|system-wide|flow|call chain|regression|side effect|invariant|refactor|migration)\b/.test(text);
}

function looksSimpleAcknowledge(text: string): boolean {
	if (text.length > 220) {
		return false;
	}
	return /\b(nit|typo|format|formatting|rename|wording|copy|comment|docs?|thanks|looks good|lgtm)\b/.test(text);
}
