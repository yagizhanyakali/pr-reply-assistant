import { REFACTOR_INTENT_KEYWORDS } from '../constants';
import { DraftMode } from '../presets';

type EvidenceSnapshot = {
	totalSymbols: number;
	symbolsWithWrites: number;
	symbolsWithMutationSignals: number;
	symbolsChangedInDiff: number;
};

export type GateOutcome = {
	strategy: DraftMode | 'unknown';
	confidence?: number;
	rationale: string[];
	reply?: string;
};

export type AnchorGateOutcome = GateOutcome & { reply: string };

export function applyAnchorGate(params: {
	anchorVerified: boolean;
	strategy: DraftMode | 'unknown';
	confidence?: number;
	rationale: string[];
	reply: string;
	relativeFilePath?: string;
}): AnchorGateOutcome {
	const passthrough: AnchorGateOutcome = {
		strategy: params.strategy,
		confidence: params.confidence,
		rationale: params.rationale,
		reply: params.reply,
	};
	if (params.anchorVerified) {
		return passthrough;
	}
	if (params.strategy === 'agree' || params.strategy === 'pushback') {
		return passthrough;
	}
	const fileLabel = params.relativeFilePath ? ` in \`${params.relativeFilePath}\`` : '';
	return {
		strategy: 'clarify',
		confidence: 0.5,
		rationale: [
			'Anchor gate: the host did not provide an exact line range for this comment. Using a neutral acknowledgment that avoids claiming the code is correct or complete.',
		],
		reply: `Thanks, I will double-check this section${fileLabel} against the intended change before responding here.`,
	};
}

export function applySafetyGate(params: {
	commentText: string;
	additionalInstructions: string;
	symbolEvidenceContext?: string;
	strategy: DraftMode | 'unknown';
	confidence?: number;
	rationale: string[];
	reply: string;
}): GateOutcome {
	const passthrough: GateOutcome = {
		strategy: params.strategy,
		confidence: params.confidence,
		rationale: params.rationale,
		reply: params.reply,
	};
	if (params.strategy !== 'agree') {
		return passthrough;
	}
	const text = `${params.commentText}\n${params.additionalInstructions}`.toLowerCase();
	const isRefactorIntent = REFACTOR_INTENT_KEYWORDS.some((keyword) => text.includes(keyword));
	if (!isRefactorIntent) {
		return passthrough;
	}
	const snapshot = analyzeSymbolEvidenceContext(params.symbolEvidenceContext);
	if (snapshot.totalSymbols === 0) {
		return passthrough;
	}
	const hasImperativeRisk =
		snapshot.symbolsWithWrites > 0 && snapshot.symbolsWithMutationSignals > 0;
	if (!hasImperativeRisk) {
		return passthrough;
	}
	const highRisk = snapshot.symbolsChangedInDiff > 0 || snapshot.symbolsWithWrites >= 2;
	const selectedStrategy: DraftMode = highRisk ? 'pushback' : 'clarify';
	const gateReason = highRisk
		? `Gate override: imperative mutation evidence detected (${snapshot.symbolsWithWrites} symbol write path(s), ${snapshot.symbolsWithMutationSignals} mutation-signal hit(s)); avoiding unsafe auto-agree.`
		: 'Gate override: possible imperative mutation paths detected; switching to clarify to prevent premature agreement.';
	return {
		strategy: selectedStrategy,
		confidence: Math.min(params.confidence ?? 0.65, highRisk ? 0.72 : 0.6),
		rationale: [gateReason, ...params.rationale].slice(0, 2),
		reply: highRisk
			? 'Thanks, I am going to hold off on accepting that change as-is because this path has write/mutation behavior that needs to be preserved.'
			: 'Thanks, I will double-check this path against the intended behavior before making that change.',
	};
}

function analyzeSymbolEvidenceContext(symbolEvidenceContext?: string): EvidenceSnapshot {
	if (!symbolEvidenceContext?.trim()) {
		return {
			totalSymbols: 0,
			symbolsWithWrites: 0,
			symbolsWithMutationSignals: 0,
			symbolsChangedInDiff: 0,
		};
	}

	const blocks = symbolEvidenceContext
		.split(/\n\s*\n/)
		.filter((block) => block.toLowerCase().includes('symbol:'));
	let symbolsWithWrites = 0;
	let symbolsWithMutationSignals = 0;
	let symbolsChangedInDiff = 0;

	for (const block of blocks) {
		const writeMatch = block.match(/Writes \((\d+)\):/i);
		const writeCount = writeMatch ? Number.parseInt(writeMatch[1], 10) : 0;
		if (writeCount > 0) {
			symbolsWithWrites += 1;
		}
		if (/Changed in diff:\s*yes/i.test(block)) {
			symbolsChangedInDiff += 1;
		}
		const mutationMatch = block.match(/Mutation signals:\s*(.+)/i);
		const mutationText = mutationMatch?.[1]?.trim().toLowerCase();
		if (mutationText && mutationText !== 'none detected') {
			symbolsWithMutationSignals += 1;
		}
	}

	return {
		totalSymbols: blocks.length,
		symbolsWithWrites,
		symbolsWithMutationSignals,
		symbolsChangedInDiff,
	};
}
