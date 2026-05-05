import * as vscode from 'vscode';

export type TokenUsageSummary = {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
};

export async function collectResponseText(
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

export async function collectResponseWithUsage(
	model: vscode.LanguageModelChat,
	messages: vscode.LanguageModelChatMessage[],
): Promise<{ text: string; tokenUsage: TokenUsageSummary }> {
	const text = await collectResponseText(model, messages);
	const tokenUsage = await estimateTokenUsage(model, messages, text);
	return { text, tokenUsage };
}

export function emptyTokenUsage(): TokenUsageSummary {
	return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

export function mergeTokenUsage(usages: TokenUsageSummary[]): TokenUsageSummary {
	return usages.reduce<TokenUsageSummary>(
		(acc, usage) => ({
			promptTokens: acc.promptTokens + usage.promptTokens,
			completionTokens: acc.completionTokens + usage.completionTokens,
			totalTokens: acc.totalTokens + usage.totalTokens,
		}),
		emptyTokenUsage(),
	);
}

async function estimateTokenUsage(
	model: vscode.LanguageModelChat,
	messages: vscode.LanguageModelChatMessage[],
	completionText: string,
): Promise<TokenUsageSummary> {
	const promptCounts = await Promise.all(
		messages.map((message) => countTokensBestEffort(model, message)),
	);
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
