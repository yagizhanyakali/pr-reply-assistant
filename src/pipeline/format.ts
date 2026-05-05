import { DraftMode, StrategyPreset, TonePreset } from '../presets';
import { AutoDecisionResult } from './types';

export function humanizeStrategy(strategy: DraftMode | 'unknown'): string {
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

export function formatRationaleLines(rationale: string[]): string[] {
	if (!rationale.length) {
		return ['Rationale: n/a'];
	}
	return ['Rationale:', ...rationale.slice(0, 2).map((item) => `- ${item}`)];
}

export function formatSingleDraftOutput(params: {
	result: AutoDecisionResult;
	selectedTonePreset: TonePreset;
	selectedStrategyPreset: StrategyPreset;
	modelLabel?: string;
}): string {
	const strategyLabel =
		params.selectedStrategyPreset.id === 'auto'
			? `Auto -> ${humanizeStrategy(params.result.selectedStrategy)}`
			: humanizeStrategy(params.selectedStrategyPreset.id);
	const confidenceText =
		typeof params.result.confidence === 'number'
			? `${Math.round(Math.max(0, Math.min(1, params.result.confidence)) * 100)}%`
			: 'n/a';
	const lines: string[] = [
		`Model: ${params.modelLabel ?? 'unknown'}`,
		`Tone preset: ${params.selectedTonePreset.label} (${params.selectedTonePreset.detail})`,
		`Strategy: ${strategyLabel}`,
		`Confidence: ${confidenceText}`,
		`Token usage: prompt ${params.result.tokenUsage.promptTokens}, completion ${params.result.tokenUsage.completionTokens}, total ${params.result.tokenUsage.totalTokens}`,
	];

	const details = params.result.pipelineDetails;
	if (details) {
		const deciderConf =
			typeof details.deciderConfidence === 'number'
				? `${Math.round(details.deciderConfidence * 100)}%`
				: 'n/a';
		const criticConf =
			typeof details.criticConfidence === 'number'
				? `${Math.round(details.criticConfidence * 100)}%`
				: 'n/a';
		lines.push(
			`Anchor: ${details.anchorVerified ? 'verified (host provided line range)' : 'unverified — anchor gate forced clarify'}`,
			`Pipeline: planner ${details.plannerIterations} round(s), ${details.evidenceCount} evidence item(s), citations ${details.citations.length ? details.citations.join(', ') : 'none'}`,
			`Decider: ${humanizeStrategy(details.deciderStrategy)} (${deciderConf})`,
			`Critic: ${humanizeStrategy(details.criticStrategy)} (${criticConf}) — ${details.criticAgreement}`,
		);
		if (details.criticDissent) {
			lines.push(`Critic dissent: ${details.criticDissent}`);
		}
		if (details.gaps.length) {
			lines.push(`Open gaps: ${details.gaps.join(' | ')}`);
		}
	}

	lines.push(...formatRationaleLines(params.result.rationale));
	lines.push('', 'Draft reply:', params.result.reply.trim());
	return lines.join('\n');
}
