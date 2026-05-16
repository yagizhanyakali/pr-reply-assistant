import * as vscode from 'vscode';
import {
	CONTEXT_LINES,
	EVIDENCE_SIGNAL_KEYWORDS,
	MAX_EVIDENCE_LINES_PER_KIND,
	MAX_EVIDENCE_SYMBOLS,
	SKIPPED_IDENTIFIER_WORDS,
} from '../constants';
import { escapeRegExp, truncateText } from '../utils';
import { runFirstAvailableDiff } from './git';

export async function getSymbolEvidenceContext(
	commentText: string,
	commentThread?: vscode.CommentThread,
): Promise<string | undefined> {
	if (!commentThread?.uri || !commentThread.range) {
		return undefined;
	}
	try {
		const document = await vscode.workspace.openTextDocument(commentThread.uri);
		return buildSymbolEvidenceFromDocumentRange(commentText, document, commentThread.range);
	} catch {
		return undefined;
	}
}

export async function getSymbolEvidenceContextFromReference(
	commentText: string | undefined,
	location?: vscode.Location,
	uri?: vscode.Uri,
): Promise<string | undefined> {
	if (!commentText?.trim()) {
		return undefined;
	}
	if (location) {
		try {
			const document = await vscode.workspace.openTextDocument(location.uri);
			return buildSymbolEvidenceFromDocumentRange(commentText, document, location.range);
		} catch {
			return undefined;
		}
	}
	if (uri) {
		try {
			const document = await vscode.workspace.openTextDocument(uri);
			const endLine = Math.min(document.lineCount - 1, CONTEXT_LINES * 2);
			const seedRange = new vscode.Range(0, 0, endLine, document.lineAt(endLine).text.length);
			return buildSymbolEvidenceFromDocumentRange(commentText, document, seedRange);
		} catch {
			return undefined;
		}
	}
	return undefined;
}

export async function buildSymbolEvidenceFromDocumentRange(
	commentText: string,
	document: vscode.TextDocument,
	range: vscode.Range,
): Promise<string | undefined> {
	const symbols = extractEvidenceSymbols(commentText, document, range);
	if (!symbols.length) {
		return undefined;
	}

	const relativePath = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, '/');
	const folder = vscode.workspace.getWorkspaceFolder(document.uri);
	let diffText: string | undefined;
	if (folder) {
		const cwd = folder.uri.fsPath;
		diffText = (await runFirstAvailableDiff({
			cwd,
			diffArgs: ['--unified=0'],
			path: relativePath,
		}))?.text;
	}

	const evidenceBlocks: string[] = [];
	for (const symbol of symbols) {
		const writeLines: string[] = [];
		const readLines: string[] = [];
		const mutationSignals = new Set<string>();

		for (let i = 0; i < document.lineCount; i += 1) {
			const text = document.lineAt(i).text;
			if (!new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(text)) {
				continue;
			}
			if (isWriteAccess(text, symbol)) {
				if (writeLines.length < MAX_EVIDENCE_LINES_PER_KIND) {
					writeLines.push(`${i + 1}: ${text.trim()}`);
				}
				for (const signal of EVIDENCE_SIGNAL_KEYWORDS) {
					if (text.includes(signal)) {
						mutationSignals.add(signal);
					}
				}
				continue;
			}
			if (isReadAccess(text, symbol) && readLines.length < MAX_EVIDENCE_LINES_PER_KIND) {
				readLines.push(`${i + 1}: ${text.trim()}`);
			}
		}

		const changedInDiff = diffText
			? new RegExp(`[+-].*\\b${escapeRegExp(symbol)}\\b`).test(diffText)
			: false;
		if (!writeLines.length && !readLines.length && !changedInDiff) {
			continue;
		}

		evidenceBlocks.push(
			[
				`Symbol: ${symbol}`,
				`Changed in diff: ${changedInDiff ? 'yes' : 'no'}`,
				`Writes (${writeLines.length}):`,
				...(writeLines.length ? writeLines : ['- none found']),
				`Reads (${readLines.length}):`,
				...(readLines.length ? readLines : ['- none found']),
				`Mutation signals: ${
					mutationSignals.size ? Array.from(mutationSignals).join(', ') : 'none detected'
				}`,
			].join('\n'),
		);
	}

	if (!evidenceBlocks.length) {
		return undefined;
	}

	return truncateText(
		evidenceBlocks.join('\n\n'),
		2_500,
		'[Symbol evidence truncated due to length.]',
	);
}

function extractEvidenceSymbols(
	commentText: string,
	document: vscode.TextDocument,
	range: vscode.Range,
): string[] {
	const identifiers = new Set<string>();
	for (const token of collectIdentifierTokens(commentText)) {
		identifiers.add(token);
	}
	for (let line = range.start.line; line <= range.end.line; line += 1) {
		for (const token of collectIdentifierTokens(document.lineAt(line).text)) {
			identifiers.add(token);
		}
	}
	return Array.from(identifiers)
		.filter((token) => !SKIPPED_IDENTIFIER_WORDS.has(token))
		.filter((token) => token.length >= 3)
		.slice(0, MAX_EVIDENCE_SYMBOLS);
}

function collectIdentifierTokens(text: string): string[] {
	return text.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? [];
}

function isWriteAccess(line: string, symbol: string): boolean {
	const escaped = escapeRegExp(symbol);
	const writePatterns = [
		new RegExp(`\\b${escaped}\\b\\s*=`),
		new RegExp(`\\b${escaped}\\.value\\s*=`),
		new RegExp(`\\b${escaped}\\b\\+\\+|\\b${escaped}\\b--`),
	];
	return writePatterns.some((pattern) => pattern.test(line));
}

function isReadAccess(line: string, symbol: string): boolean {
	const escaped = escapeRegExp(symbol);
	return new RegExp(`\\b${escaped}\\b`).test(line) && !isWriteAccess(line, symbol);
}
