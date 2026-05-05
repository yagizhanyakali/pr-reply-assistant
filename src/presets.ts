export type DraftMode = 'agree' | 'pushback' | 'clarify';

export type TonePreset = {
	id: string;
	label: string;
	detail: string;
	styleGuidance: string;
};

export type StrategyPreset = {
	id: 'auto' | DraftMode;
	label: string;
	detail: string;
	instruction: string;
};

export type ContextModePreset = {
	id: 'standard' | 'deep';
	label: string;
	detail: string;
};

export const TONE_PRESETS: TonePreset[] = [
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

export const STRATEGY_PRESETS: StrategyPreset[] = [
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

export const CONTEXT_MODE_PRESETS: ContextModePreset[] = [
	{
		id: 'standard',
		label: 'Standard context',
		detail: 'Fast, focused context around the comment',
	},
	{
		id: 'deep',
		label: 'Deep context',
		detail: 'Broader PR-wide context and diagnostics (slower)',
	},
];

export function getTonePresetById(id: TonePreset['id']): TonePreset {
	return TONE_PRESETS.find((preset) => preset.id === id) ?? TONE_PRESETS[0];
}

export function getStrategyPresetById(id: StrategyPreset['id']): StrategyPreset {
	return STRATEGY_PRESETS.find((preset) => preset.id === id) ?? STRATEGY_PRESETS[0];
}
