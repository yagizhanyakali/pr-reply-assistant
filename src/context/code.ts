import * as vscode from 'vscode';
import {
	CONTEXT_LINES,
	DIFF_UNIFIED_LINES,
	MAX_DIFF_CONTEXT_CHARS,
	MAX_RELATED_SNIPPETS,
	MAX_SYMBOL_QUERIES,
	RELATED_SNIPPET_LINES,
	SKIPPED_IDENTIFIER_WORDS,
} from '../constants';
import { truncateContext, truncateText } from '../utils';
import { runFirstAvailableDiff } from './git';

export async function getCodeContext(
	commentThread?: vscode.CommentThread,
): Promise<string | undefined> {
	if (!commentThread?.uri || !commentThread.range) {
		return undefined;
	}
	try {
		const document = await vscode.workspace.openTextDocument(commentThread.uri);
		return buildCodeContextFromDocumentRange(document, commentThread.range);
	} catch {
		return undefined;
	}
}

export async function getCodeContextFromReference(
	location?: vscode.Location,
	uri?: vscode.Uri,
): Promise<string | undefined> {
	if (location) {
		try {
			const document = await vscode.workspace.openTextDocument(location.uri);
			return buildCodeContextFromDocumentRange(document, location.range);
		} catch {
			return undefined;
		}
	}
	if (uri) {
		try {
			const document = await vscode.workspace.openTextDocument(uri);
			const endLine = Math.min(document.lineCount - 1, CONTEXT_LINES * 2);
			const range = new vscode.Range(0, 0, endLine, document.lineAt(endLine).text.length);
			return buildCodeContextFromDocumentRange(document, range);
		} catch {
			return undefined;
		}
	}
	return undefined;
}

export async function buildCodeContextFromDocumentRange(
	document: vscode.TextDocument,
	range: vscode.Range,
): Promise<string> {
	const startLine = Math.max(0, range.start.line - CONTEXT_LINES);
	const endLine = Math.min(document.lineCount - 1, range.end.line + CONTEXT_LINES);
	const code: string[] = [];
	for (let i = startLine; i <= endLine; i += 1) {
		code.push(`${i + 1}: ${document.lineAt(i).text}`);
	}

	const relativePath = vscode.workspace.asRelativePath(document.uri, false);
	const baseContext = [
		`File: ${relativePath}`,
		`Commented range: lines ${range.start.line + 1}-${range.end.line + 1}`,
		'Nearby lines:',
		code.join('\n'),
	].join('\n');
	const [relatedContext, diffContext] = await Promise.all([
		getRelatedWorkspaceContext(document, range),
		getFileDiffContext(document, range),
	]);
	const sections: string[] = [baseContext];
	if (diffContext) {
		sections.push('', 'Diff context (changes related to this file):', diffContext);
	}
	if (relatedContext.length) {
		sections.push(
			'',
			'Related workspace context (potentially relevant references):',
			relatedContext.join('\n\n'),
		);
	}
	return truncateContext(sections.join('\n'));
}

async function getFileDiffContext(
	document: vscode.TextDocument,
	commentRange: vscode.Range,
): Promise<string | undefined> {
	const folder = vscode.workspace.getWorkspaceFolder(document.uri);
	if (!folder) {
		return undefined;
	}
	const relativePath = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, '/');
	const cwd = folder.uri.fsPath;
	const diffSections: string[] = [];

	const availableDiff = await runFirstAvailableDiff({
		cwd,
		diffArgs: [`--unified=${DIFF_UNIFIED_LINES}`],
		path: relativePath,
	});
	if (availableDiff) {
		diffSections.push(`${availableDiff.label}:\n${availableDiff.text}`);
	}

	if (!diffSections.length) {
		return undefined;
	}

	const startLine = commentRange.start.line + 1;
	const endLine = commentRange.end.line + 1;
	const focusedSections = diffSections
		.map((section) => {
			const lines = section.split('\n');
			const title = lines[0];
			const diffBody = lines.slice(1).join('\n');
			const focused = extractRelevantDiffHunks(diffBody, startLine, endLine);
			if (!focused) {
				return undefined;
			}
			return `${title}\n${focused}`;
		})
		.filter((value): value is string => Boolean(value));

	const combined = (focusedSections.length ? focusedSections : diffSections).join('\n\n');
	return truncateText(combined, MAX_DIFF_CONTEXT_CHARS, '[Diff context truncated due to length.]');
}

function extractRelevantDiffHunks(
	diffText: string,
	commentStartLine: number,
	commentEndLine: number,
): string | undefined {
	if (!diffText.trim()) {
		return undefined;
	}
	type Hunk = { header: string; lines: string[]; start: number; end: number };
	const hunks: Hunk[] = [];
	const lines = diffText.split('\n');
	let current: Hunk | undefined;
	for (const line of lines) {
		const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
		if (match) {
			if (current) {
				hunks.push(current);
			}
			const start = Number.parseInt(match[1], 10);
			const count = match[2] ? Number.parseInt(match[2], 10) : 1;
			current = {
				header: line,
				lines: [],
				start,
				end: Math.max(start, start + count - 1),
			};
			continue;
		}
		if (current) {
			current.lines.push(line);
		}
	}
	if (current) {
		hunks.push(current);
	}

	if (!hunks.length) {
		return truncateText(diffText, MAX_DIFF_CONTEXT_CHARS, '[Diff context truncated due to length.]');
	}

	const overlapping = hunks.filter((hunk) => {
		return hunk.start <= commentEndLine && hunk.end >= commentStartLine;
	});
	const selected = (overlapping.length ? overlapping : hunks).slice(0, 2);
	return selected.map((hunk) => `${hunk.header}\n${hunk.lines.join('\n')}`.trimEnd()).join('\n\n');
}

async function getRelatedWorkspaceContext(
	document: vscode.TextDocument,
	range: vscode.Range,
): Promise<string[]> {
	const queries = extractIdentifierQueries(document, range);
	if (!queries.length) {
		return [];
	}

	const snippets: string[] = [];
	const seenLocations = new Set<string>();

	for (const query of queries) {
		if (snippets.length >= MAX_RELATED_SNIPPETS) {
			break;
		}
		const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
			'vscode.executeWorkspaceSymbolProvider',
			query,
		);
		if (!symbols?.length) {
			continue;
		}
		for (const symbol of symbols) {
			if (snippets.length >= MAX_RELATED_SNIPPETS) {
				break;
			}
			const location = symbol.location;
			if (
				location.uri.toString() === document.uri.toString() &&
				range.intersection(location.range)
			) {
				continue;
			}
			const key = `${location.uri.toString()}:${location.range.start.line}`;
			if (seenLocations.has(key)) {
				continue;
			}
			seenLocations.add(key);
			const snippet = await buildLocationSnippet(symbol.name, location);
			if (snippet) {
				snippets.push(snippet);
			}
		}
	}
	return snippets;
}

function extractIdentifierQueries(document: vscode.TextDocument, range: vscode.Range): string[] {
	const queries: string[] = [];
	const seen = new Set<string>();
	for (let line = range.start.line; line <= range.end.line; line += 1) {
		const lineText = document.lineAt(line).text;
		const matches = lineText.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? [];
		for (const match of matches) {
			if (seen.has(match) || SKIPPED_IDENTIFIER_WORDS.has(match)) {
				continue;
			}
			seen.add(match);
			queries.push(match);
			if (queries.length >= MAX_SYMBOL_QUERIES) {
				return queries;
			}
		}
	}
	return queries;
}

async function buildLocationSnippet(
	symbolName: string,
	location: vscode.Location,
): Promise<string | undefined> {
	try {
		const doc = await vscode.workspace.openTextDocument(location.uri);
		const start = Math.max(0, location.range.start.line - RELATED_SNIPPET_LINES);
		const end = Math.min(doc.lineCount - 1, location.range.end.line + RELATED_SNIPPET_LINES);
		const lines: string[] = [];
		for (let line = start; line <= end; line += 1) {
			lines.push(`${line + 1}: ${doc.lineAt(line).text}`);
		}
		return [
			`Symbol: ${symbolName}`,
			`File: ${vscode.workspace.asRelativePath(location.uri, false)}`,
			`Lines: ${location.range.start.line + 1}-${location.range.end.line + 1}`,
			lines.join('\n'),
		].join('\n');
	} catch {
		return undefined;
	}
}
