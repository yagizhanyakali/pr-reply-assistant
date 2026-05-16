import * as vscode from 'vscode';
import {
	CONTEXT_LINES,
	MAX_COMPREHENSIVE_CONTEXT_CHARS,
	MAX_EVIDENCE_SYMBOLS,
	MAX_FULL_PAGE_CONTEXT_CHARS,
	MAX_REFERENCE_IMPACT_CHARS,
	SKIPPED_IDENTIFIER_WORDS,
} from '../constants';
import { escapeRegExp, truncateText } from '../utils';
import { getAllPrChangesContext, getPageDiffContext } from './git';

export async function getComprehensiveContextForComment(
	commentText: string,
	commentThread?: vscode.CommentThread,
): Promise<string | undefined> {
	if (!commentThread?.uri) {
		return undefined;
	}
	return getComprehensiveContext({
		commentText,
		uri: commentThread.uri,
		range: commentThread.range,
	});
}

export async function getComprehensiveContextForReference(
	commentText: string | undefined,
	location?: vscode.Location,
	uri?: vscode.Uri,
): Promise<string | undefined> {
	if (!commentText?.trim()) {
		return undefined;
	}
	if (location) {
		return getComprehensiveContext({
			commentText,
			uri: location.uri,
			range: location.range,
		});
	}
	if (uri) {
		return getComprehensiveContext({ commentText, uri });
	}
	return undefined;
}

export async function getComprehensiveContext(params: {
	commentText: string;
	uri: vscode.Uri;
	range?: vscode.Range;
}): Promise<string | undefined> {
	const folder = vscode.workspace.getWorkspaceFolder(params.uri);
	if (!folder) {
		return undefined;
	}

	try {
		const document = await vscode.workspace.openTextDocument(params.uri);
		const relativePath = vscode.workspace.asRelativePath(params.uri, false);
		const cwd = folder.uri.fsPath;
		const fullPage = buildFullPageContext(document);
		const pageDiff = await getPageDiffContext(cwd, relativePath);
		const referenceImpact = await getReferenceImpactContext(
			document,
			params.commentText,
			params.range,
		);
		const allPrChanges = await getAllPrChangesContext(cwd);
		const sections = [
			'1) Full page content (commented file):',
			fullPage,
			'',
			'2) Changes on this page:',
			pageDiff ?? 'No page-level diff found.',
			'',
			'3) Codebase impact (references/usages):',
			referenceImpact ?? 'No significant reference impact found.',
			'',
			'4) Available change context:',
			allPrChanges ?? 'No available change diff found.',
		];
		return truncateText(
			sections.join('\n'),
			MAX_COMPREHENSIVE_CONTEXT_CHARS,
			'[Comprehensive context truncated due to length.]',
		);
	} catch {
		return undefined;
	}
}

export function buildFullPageContext(document: vscode.TextDocument): string {
	const lines: string[] = [];
	for (let i = 0; i < document.lineCount; i += 1) {
		lines.push(`${i + 1}: ${document.lineAt(i).text}`);
	}
	const header = `File: ${vscode.workspace.asRelativePath(document.uri, false)}\nTotal lines: ${document.lineCount}`;
	return truncateText(
		`${header}\n${lines.join('\n')}`,
		MAX_FULL_PAGE_CONTEXT_CHARS,
		'[Full page context truncated due to length.]',
	);
}

export function findSymbolPosition(
	document: vscode.TextDocument,
	symbol: string,
	range: vscode.Range,
): vscode.Position | undefined {
	const regex = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
	for (let line = range.start.line; line <= range.end.line; line += 1) {
		const text = document.lineAt(line).text;
		const match = regex.exec(text);
		if (match?.index !== undefined) {
			return new vscode.Position(line, match.index);
		}
	}
	for (let line = 0; line < document.lineCount; line += 1) {
		const text = document.lineAt(line).text;
		const match = regex.exec(text);
		if (match?.index !== undefined) {
			return new vscode.Position(line, match.index);
		}
	}
	return undefined;
}

async function getReferenceImpactContext(
	document: vscode.TextDocument,
	commentText: string,
	range?: vscode.Range,
): Promise<string | undefined> {
	const effectiveRange =
		range ??
		new vscode.Range(
			0,
			0,
			Math.min(document.lineCount - 1, CONTEXT_LINES * 2),
			document.lineAt(Math.min(document.lineCount - 1, CONTEXT_LINES * 2)).text.length,
		);
	const symbols = extractReferenceSymbols(commentText, document, effectiveRange);
	if (!symbols.length) {
		return undefined;
	}

	const lines: string[] = [];
	for (const symbol of symbols.slice(0, MAX_EVIDENCE_SYMBOLS)) {
		const position = findSymbolPosition(document, symbol, effectiveRange);
		if (!position) {
			continue;
		}
		const refs = await vscode.commands.executeCommand<vscode.Location[]>(
			'vscode.executeReferenceProvider',
			document.uri,
			position,
		);
		if (!refs?.length) {
			continue;
		}
		const external = refs.filter((ref) => ref.uri.toString() !== document.uri.toString());
		const sample = external.slice(0, 4).map((ref) => {
			const pathText = vscode.workspace.asRelativePath(ref.uri, false);
			return `${pathText}:${ref.range.start.line + 1}`;
		});
		lines.push(
			[
				`Symbol: ${symbol}`,
				`Total references: ${refs.length}`,
				`External references: ${external.length}`,
				`Sample external usage: ${sample.length ? sample.join(', ') : 'none'}`,
			].join('\n'),
		);
	}

	if (!lines.length) {
		return undefined;
	}
	return truncateText(
		lines.join('\n\n'),
		MAX_REFERENCE_IMPACT_CHARS,
		'[Reference impact truncated due to length.]',
	);
}

function extractReferenceSymbols(
	commentText: string,
	document: vscode.TextDocument,
	range: vscode.Range,
): string[] {
	const identifiers = new Set<string>();
	const collect = (text: string) => {
		for (const match of text.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []) {
			identifiers.add(match);
		}
	};
	collect(commentText);
	for (let line = range.start.line; line <= range.end.line; line += 1) {
		collect(document.lineAt(line).text);
	}
	return Array.from(identifiers)
		.filter((token) => !SKIPPED_IDENTIFIER_WORDS.has(token))
		.filter((token) => token.length >= 3)
		.slice(0, MAX_EVIDENCE_SYMBOLS);
}
