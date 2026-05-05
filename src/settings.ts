import * as vscode from 'vscode';
import { CONFIG_SECTION } from './constants';
import {
	CONTEXT_MODE_PRESETS,
	ContextModePreset,
	STRATEGY_PRESETS,
	StrategyPreset,
	TONE_PRESETS,
	TonePreset,
} from './presets';

export type UserSettings = {
	tone: TonePreset['id'];
	strategy: StrategyPreset['id'];
	contextDepth: ContextModePreset['id'];
	language: string;
	askForExtraInstructions: boolean;
};

export const DEFAULT_USER_SETTINGS: UserSettings = {
	tone: 'balanced',
	strategy: 'auto',
	contextDepth: 'standard',
	language: 'English',
	askForExtraInstructions: false,
};

export function readUserSettings(): UserSettings {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const tone = config.get<string>('tone', DEFAULT_USER_SETTINGS.tone);
	const strategy = config.get<string>('strategy', DEFAULT_USER_SETTINGS.strategy);
	const depth = config.get<string>('contextDepth', DEFAULT_USER_SETTINGS.contextDepth);
	const language =
		config.get<string>('language', DEFAULT_USER_SETTINGS.language)?.trim() ||
		DEFAULT_USER_SETTINGS.language;
	const ask = config.get<boolean>(
		'askForExtraInstructions',
		DEFAULT_USER_SETTINGS.askForExtraInstructions,
	);
	return {
		tone: TONE_PRESETS.some((p) => p.id === tone) ? (tone as TonePreset['id']) : DEFAULT_USER_SETTINGS.tone,
		strategy: STRATEGY_PRESETS.some((p) => p.id === strategy)
			? (strategy as StrategyPreset['id'])
			: DEFAULT_USER_SETTINGS.strategy,
		contextDepth: CONTEXT_MODE_PRESETS.some((p) => p.id === depth)
			? (depth as ContextModePreset['id'])
			: DEFAULT_USER_SETTINGS.contextDepth,
		language,
		askForExtraInstructions: ask ?? DEFAULT_USER_SETTINGS.askForExtraInstructions,
	};
}
