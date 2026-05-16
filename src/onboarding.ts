import * as vscode from 'vscode';
import { CONFIG_SECTION } from './constants';
import { CONTEXT_MODE_PRESETS, ContextModePreset } from './presets';
import { listAvailableChatModels, hasLmApi } from './modelResolver';

const ONBOARDING_LANGUAGE_OPTIONS: Array<{ label: string; description?: string; value: string }> = [
	{ label: 'English', value: 'English' },
	{ label: 'Türkçe', description: 'Turkish', value: 'Türkçe' },
	{ label: 'Español', description: 'Spanish', value: 'Español' },
	{ label: 'Deutsch', description: 'German', value: 'Deutsch' },
	{ label: 'Français', description: 'French', value: 'Français' },
	{ label: 'Italiano', description: 'Italian', value: 'Italiano' },
	{ label: 'Português', description: 'Portuguese', value: 'Português' },
	{ label: '日本語', description: 'Japanese', value: '日本語' },
	{ label: '中文', description: 'Chinese (Simplified)', value: '中文' },
	{ label: '한국어', description: 'Korean', value: '한국어' },
	{ label: 'Русский', description: 'Russian', value: 'Русский' },
];

export async function runOnboardingWizard(opts: { force: boolean }): Promise<boolean> {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	if (!opts.force && config.get<boolean>('onboardingComplete', false)) {
		return true;
	}

	const intro = await vscode.window.showInformationMessage(
		'Welcome to PR Reply Assistant. Optional setup lets you choose language, model, context depth, and personal tone examples. You can change these later in Settings.',
		{ modal: false },
		'Continue',
		'Skip for now',
	);
	if (intro !== 'Continue') {
		return false;
	}

	const language = await pickLanguage();
	if (!language) {
		return false;
	}

	const modelChoice = await pickModel(config);
	if (modelChoice === undefined) {
		return false;
	}

	const depth = await pickDepth();
	if (!depth) {
		return false;
	}
	const personalToneExamples = await pickPersonalToneExamples(config);

	await config.update('language', language, vscode.ConfigurationTarget.Global);
	await config.update('contextDepth', depth, vscode.ConfigurationTarget.Global);
	if (personalToneExamples !== undefined) {
		await config.update('personalToneExamples', personalToneExamples, vscode.ConfigurationTarget.Global);
	}
	if (modelChoice.modelId) {
		await config.update('modelId', modelChoice.modelId, vscode.ConfigurationTarget.Global);
	}
	if (modelChoice.modelFamily) {
		await config.update('modelFamily', modelChoice.modelFamily, vscode.ConfigurationTarget.Global);
	}
	if (modelChoice.modelVendor) {
		await config.update('modelVendor', modelChoice.modelVendor, vscode.ConfigurationTarget.Global);
	}
	await config.update('onboardingComplete', true, vscode.ConfigurationTarget.Global);

	await reportOnboardingResult({
		expectedModelId: modelChoice.modelId,
		expectedDepth: depth,
	});
	return true;
}

export async function maybeRunOnboardingOnStartup(): Promise<void> {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	if (config.get<boolean>('onboardingComplete', false)) {
		return;
	}
	const choice = await vscode.window.showInformationMessage(
		'PR Reply Assistant works with defaults. Optional setup can tune language, model, depth, and tone.',
		'Set up now',
		'Later',
	);
	if (choice === 'Set up now') {
		await runOnboardingWizard({ force: true });
	}
}

async function pickPersonalToneExamples(
	config: vscode.WorkspaceConfiguration,
): Promise<string | undefined> {
	const current = config.get<string>('personalToneExamples', '') ?? '';
	const typed = await vscode.window.showInputBox({
		title: 'PR Reply Assistant — Optional: Personal tone examples',
		prompt: 'Paste 3-5 previous PR replies to help drafts sound more like you, or leave blank.',
		value: current,
		ignoreFocusOut: true,
	});
	if (typed === undefined) {
		return undefined;
	}
	return typed.trim();
}

async function pickLanguage(): Promise<string | undefined> {
	const customLabel = '$(edit) Custom...';
	const languageItems: vscode.QuickPickItem[] = ONBOARDING_LANGUAGE_OPTIONS.map((option) => ({
		label: option.label,
		description: option.description,
	}));
	languageItems.push({ label: customLabel, description: 'Type your own language name' });
	const pick = await vscode.window.showQuickPick(languageItems, {
		title: 'PR Reply Assistant — Step 1 of 3: Language',
		placeHolder: 'Language for your draft replies',
		ignoreFocusOut: true,
	});
	if (!pick) {
		return undefined;
	}
	if (pick.label === customLabel) {
		const typed = await vscode.window.showInputBox({
			title: 'Custom language',
			prompt: 'Enter the language for draft replies (e.g. "Polski", "Bahasa Indonesia").',
			ignoreFocusOut: true,
		});
		if (!typed?.trim()) {
			return undefined;
		}
		return typed.trim();
	}
	const matched = ONBOARDING_LANGUAGE_OPTIONS.find((option) => option.label === pick.label);
	return matched?.value ?? pick.label;
}

async function pickModel(config: vscode.WorkspaceConfiguration): Promise<
	| {
		modelId: string;
		modelFamily: string;
		modelVendor: string;
	}
	| undefined
> {
	const fallback = {
		modelId: config.get<string>('modelId', '') ?? '',
		modelFamily: config.get<string>('modelFamily', '') ?? '',
		modelVendor: config.get<string>('modelVendor', '') ?? '',
	};

	if (!hasLmApi()) {
		await vscode.window.showWarningMessage(
			'Could not enumerate language models for this build. Continuing with auto-select; you can pick one later in Settings.',
		);
		return fallback;
	}

	let models: vscode.LanguageModelChat[];
	try {
		models = await listAvailableChatModels();
	} catch {
		await vscode.window.showWarningMessage(
			'Could not enumerate language models for this build. Continuing with auto-select; you can pick one later in Settings.',
		);
		return fallback;
	}

	if (!models.length) {
		await vscode.window.showWarningMessage(
			'No language models are currently available. You can pick one later from Settings → "PR Reply Assistant: Model Id" once Copilot Chat is signed in.',
		);
		return fallback;
	}

	const items = models.map((model) => ({
		label: model.name,
		description: `${model.vendor}/${model.family} ${model.version}`,
		detail: model.id,
		model,
	}));
	const pick = await vscode.window.showQuickPick(items, {
		title: 'PR Reply Assistant — Step 2 of 3: Model',
		placeHolder: 'Pick the language model used for drafts',
		ignoreFocusOut: true,
	});
	if (!pick) {
		return undefined;
	}
	return {
		modelId: pick.model.id,
		modelFamily: pick.model.family,
		modelVendor: pick.model.vendor,
	};
}

async function pickDepth(): Promise<ContextModePreset['id'] | undefined> {
	const items: vscode.QuickPickItem[] = CONTEXT_MODE_PRESETS.map((preset) => ({
		label: preset.label,
		description: preset.detail,
	}));
	const pick = await vscode.window.showQuickPick(items, {
		title: 'PR Reply Assistant — Step 3 of 3: Context depth',
		placeHolder: 'How much context to gather upfront',
		ignoreFocusOut: true,
	});
	if (!pick) {
		return undefined;
	}
	const preset = CONTEXT_MODE_PRESETS.find((p) => p.label === pick.label) ?? CONTEXT_MODE_PRESETS[0];
	return preset.id;
}

async function reportOnboardingResult(params: {
	expectedModelId: string;
	expectedDepth: ContextModePreset['id'];
}): Promise<void> {
	const verify = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const persistedId = verify.get<string>('modelId', '') ?? '';
	const persistedFamily = verify.get<string>('modelFamily', '') ?? '';
	const persistedLanguage = verify.get<string>('language', '') ?? '';
	if (params.expectedModelId && persistedId !== params.expectedModelId) {
		await vscode.window.showWarningMessage(
			`PR Reply Assistant: model id was selected (${params.expectedModelId}) but the saved global setting reads back as "${persistedId}". A workspace-level override may be shadowing it. Open Settings (Workspace tab) and clear "Model Id" there if needed.`,
		);
		return;
	}
	await vscode.window.showInformationMessage(
		`PR Reply Assistant ready. Saved: language=${persistedLanguage || 'English'}, model=${persistedId || 'auto'}${persistedFamily ? ` (family ${persistedFamily})` : ''}, depth=${params.expectedDepth}. Click any PR comment's draft icon to generate a reply.`,
	);
}
