import * as vscode from 'vscode';
import { CONFIG_SECTION } from './constants';

type ModelMatchReason = 'id' | 'family' | 'vendor' | 'auto';

export function hasLmApi(): boolean {
	const api = (vscode as unknown as { lm?: { selectChatModels?: unknown } }).lm;
	return typeof api?.selectChatModels === 'function';
}

export function hasChatParticipantApi(): boolean {
	const api = (vscode as unknown as { chat?: { createChatParticipant?: unknown } }).chat;
	return typeof api?.createChatParticipant === 'function';
}

export async function resolveModelForDraft(
	preferredModelId?: string,
	logger?: (line: string) => void,
): Promise<vscode.LanguageModelChat> {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const configuredModelId = config.get<string>('modelId')?.trim();
	const configuredFamily = config.get<string>('modelFamily')?.trim();
	const configuredVendor = config.get<string>('modelVendor')?.trim();
	const shouldPrompt = config.get<boolean>('promptForModelSelection', false);
	const shouldPersist = config.get<boolean>('persistSelectedModel', true);
	const effectivePreferredId = configuredModelId || preferredModelId;

	if (!shouldPrompt) {
		const { model, matchedBy } = await pickModelWithFallback({
			id: effectivePreferredId,
			family: configuredFamily,
			vendor: configuredVendor,
		});
		logger?.(
			`Model: ${model.name} [${model.id}] family=${model.family} vendor=${model.vendor} (matched by ${matchedBy}, requested id=${effectivePreferredId ?? 'none'}, family=${configuredFamily ?? 'none'}).`,
		);
		if (
			matchedBy !== 'id' &&
			shouldPersist &&
			effectivePreferredId &&
			effectivePreferredId !== model.id
		) {
			await config.update('modelId', model.id, vscode.ConfigurationTarget.Global);
			await config.update('modelFamily', model.family, vscode.ConfigurationTarget.Global);
			await config.update('modelVendor', model.vendor, vscode.ConfigurationTarget.Global);
			logger?.(
				`Model: saved id was stale; refreshed settings to ${model.id} / ${model.family} / ${model.vendor}.`,
			);
		}
		return model;
	}

	const selected = await selectChatModelWithQuickPick(effectivePreferredId);
	if (!selected) {
		throw new Error('Model selection was cancelled.');
	}

	if (shouldPersist) {
		await config.update('modelId', selected.id, vscode.ConfigurationTarget.Global);
		await config.update('modelFamily', selected.family, vscode.ConfigurationTarget.Global);
		await config.update('modelVendor', selected.vendor, vscode.ConfigurationTarget.Global);
		logger?.(`Model: persisted ${selected.id} / ${selected.family} / ${selected.vendor}.`);
	}

	return selected;
}

export async function selectChatModelWithQuickPick(
	preferredModelId?: string,
): Promise<vscode.LanguageModelChat | undefined> {
	const models = await listAvailableChatModels();
	if (!models.length) {
		throw new Error(
			'No language model is available. Sign in to GitHub Copilot and ensure chat access is enabled.',
		);
	}

	const items = models.map((model) => ({
		label: model.name,
		description: `${model.vendor}/${model.family} ${model.version}`,
		detail: model.id === preferredModelId ? 'Preferred model' : model.id,
		model,
	}));
	const selected = await vscode.window.showQuickPick(items, {
		placeHolder: 'Select model for PR reply draft',
		ignoreFocusOut: true,
	});
	if (selected) {
		return selected.model;
	}

	return preferredModelId ? models.find((model) => model.id === preferredModelId) : undefined;
}

export async function listAvailableChatModels(): Promise<vscode.LanguageModelChat[]> {
	if (!hasLmApi()) {
		return [];
	}
	let models: vscode.LanguageModelChat[] = [];
	try {
		models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
	} catch {
		models = [];
	}
	if (!models.length) {
		try {
			models = await vscode.lm.selectChatModels({});
		} catch {
			models = [];
		}
	}
	return models;
}

async function pickModelWithFallback(prefs: {
	id?: string;
	family?: string;
	vendor?: string;
}): Promise<{ model: vscode.LanguageModelChat; matchedBy: ModelMatchReason }> {
	if (!hasLmApi()) {
		throw new Error(
			'The Language Model API is unavailable in this editor build. Update VS Code/Cursor and ensure Copilot Chat is enabled.',
		);
	}

	if (prefs.id) {
		try {
			const byId = await vscode.lm.selectChatModels({ id: prefs.id });
			if (byId.length) {
				return { model: byId[0], matchedBy: 'id' };
			}
		} catch {
			// fall through
		}
		try {
			const all = await vscode.lm.selectChatModels({});
			const exact = all.find((m) => m.id === prefs.id);
			if (exact) {
				return { model: exact, matchedBy: 'id' };
			}
		} catch {
			// fall through
		}
	}

	if (prefs.family) {
		try {
			const byFamily = await vscode.lm.selectChatModels({ family: prefs.family });
			if (byFamily.length) {
				return { model: byFamily[0], matchedBy: 'family' };
			}
		} catch {
			// fall through
		}
	}

	const vendorFilter = prefs.vendor || 'copilot';
	try {
		const byVendor = await vscode.lm.selectChatModels({ vendor: vendorFilter });
		if (byVendor.length) {
			return { model: byVendor[0], matchedBy: 'vendor' };
		}
	} catch {
		// fall through
	}

	const all = await vscode.lm.selectChatModels({});
	if (!all.length) {
		throw new Error(
			'No language model is available. Sign in to GitHub Copilot and ensure chat access is enabled.',
		);
	}
	return { model: all[0], matchedBy: 'auto' };
}

export async function resolveSmallModel(
	logger?: (line: string) => void,
): Promise<vscode.LanguageModelChat> {
	if (!hasLmApi()) {
		throw new Error(
			'The Language Model API is unavailable in this editor build. Update VS Code/Cursor and ensure Copilot Chat is enabled.',
		);
	}

	const allModels = await listAvailableChatModels();
	if (!allModels.length) {
		throw new Error(
			'No language model is available. Sign in to GitHub Copilot and ensure chat access is enabled.',
		);
	}

	// Look for typical small/fast models
	const smallKeywords = ['mini', 'haiku', 'flash', 'small', 'lite', 'gpt-3.5', 'llama-3-8b', 'llama3-8b', '8b'];
	for (const keyword of smallKeywords) {
		const found = allModels.find(
			(m) =>
				m.id.toLowerCase().includes(keyword) ||
				m.family.toLowerCase().includes(keyword) ||
				m.name.toLowerCase().includes(keyword),
		);
		if (found) {
			logger?.(`Auto-selected small model: ${found.name} (${found.id}) based on keyword '${keyword}'`);
			return found;
		}
	}

	// Fallback to first available model
	const fallback = allModels[0];
	logger?.(`No small model identified. Falling back to default model: ${fallback.name} (${fallback.id})`);
	return fallback;
}

