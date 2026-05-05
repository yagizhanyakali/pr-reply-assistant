import * as vscode from 'vscode';
import { EvidenceItem } from '../agents';
import { SKIPPED_IDENTIFIER_WORDS } from '../constants';
import { escapeRegExp } from '../utils';
import { buildCodeContextFromDocumentRange } from './code';
import { buildSymbolEvidenceFromDocumentRange } from './evidence';
import { buildFullPageContext } from './comprehensive';

export type AnchorEvidenceResult = {
	locationHint?: string;
	seedEvidence?: EvidenceItem[];
	seedGaps?: string[];
};

export async function buildAnchorEvidence(seed: {
	commentText: string;
	commentUri?: vscode.Uri;
	commentRange?: vscode.Range;
}): Promise<AnchorEvidenceResult> {
	if (!seed.commentUri) {
		return {};
	}
	const relativePath = vscode.workspace.asRelativePath(seed.commentUri, false).replace(/\\/g, '/');
	let document: vscode.TextDocument | undefined;
	try {
		document = await vscode.workspace.openTextDocument(seed.commentUri);
	} catch {
		return { locationHint: `${relativePath} (file unreadable)` };
	}

	const items: EvidenceItem[] = [];
	let nextId = 1;
	const hasRange = Boolean(seed.commentRange);
	const locationHint =
		hasRange && seed.commentRange
			? `${relativePath}:${seed.commentRange.start.line + 1}-${seed.commentRange.end.line + 1}`
			: `${relativePath} (exact line range not provided by host)`;

	if (hasRange && seed.commentRange) {
		const focused = await buildCodeContextFromDocumentRange(document, seed.commentRange);
		if (focused) {
			items.push({
				id: `E${nextId}`,
				kind: 'code',
				source: `${relativePath}:${seed.commentRange.start.line + 1}-${seed.commentRange.end.line + 1} (anchor)`,
				summary: 'Code around the PR comment anchor',
				content: focused,
			});
			nextId += 1;
		}
		const enclosing = findEnclosingFunctionBlock(document, seed.commentRange.start.line);
		if (enclosing && enclosing.endLine - enclosing.startLine <= 320) {
			items.push({
				id: `E${nextId}`,
				kind: 'code',
				source: `${relativePath}:${enclosing.startLine + 1}-${enclosing.endLine + 1} (anchor: full enclosing function)`,
				summary: 'Full body of the function enclosing the PR comment anchor',
				content: sliceLinesWithNumbers(document, enclosing.startLine, enclosing.endLine),
			});
			nextId += 1;
		}
		const symbolEvidence = await buildSymbolEvidenceFromDocumentRange(
			seed.commentText,
			document,
			seed.commentRange,
		);
		if (symbolEvidence) {
			items.push({
				id: `E${nextId}`,
				kind: 'symbol-evidence',
				source: `${relativePath} (anchor symbols)`,
				summary: 'Read/write/mutation evidence for symbols near the comment',
				content: symbolEvidence,
			});
			nextId += 1;
		}
		const referenced = buildReferencedSymbolEvidence(
			seed.commentText,
			document,
			seed.commentRange,
			nextId,
		);
		for (const item of referenced) {
			items.push(item);
			nextId += 1;
		}
	} else {
		const fullPage = buildFullPageContext(document);
		items.push({
			id: `E${nextId}`,
			kind: 'code',
			source: `${relativePath} (full file — anchor line unknown)`,
			summary:
				'Full content of the commented file. Find the section the reviewer is referring to before reasoning.',
			content: fullPage,
		});
		nextId += 1;

		const candidates = findCandidateAnchorLines(seed.commentText, document);
		if (candidates) {
			items.push({
				id: `E${nextId}`,
				kind: 'note',
				source: `${relativePath} (candidate anchor lines)`,
				summary: 'Lines in the file matching tokens from the comment — likely candidates for the anchor.',
				content: candidates,
			});
			nextId += 1;
		}
	}

	const seedGaps = computeCoverageGaps(seed.commentText, items);
	return {
		locationHint,
		seedEvidence: items.length ? items : undefined,
		seedGaps: seedGaps.length ? seedGaps : undefined,
	};
}

export function sliceLinesWithNumbers(
	document: vscode.TextDocument,
	startLine: number,
	endLine: number,
): string {
	const lines: string[] = [];
	for (let i = startLine; i <= endLine; i += 1) {
		lines.push(`${i + 1}: ${document.lineAt(i).text}`);
	}
	const relativePath = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, '/');
	return [
		`File: ${relativePath}`,
		`Lines ${startLine + 1}-${endLine + 1} of ${document.lineCount}`,
		lines.join('\n'),
	].join('\n');
}

function buildReferencedSymbolEvidence(
	commentText: string,
	document: vscode.TextDocument,
	anchorRange: vscode.Range,
	startId: number,
): EvidenceItem[] {
	const relativePath = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, '/');
	const items: EvidenceItem[] = [];
	const symbols = new Set<string>();
	for (const match of commentText.matchAll(/\b([A-Za-z_][A-Za-z0-9_]{2,})\s*\(/g)) {
		const token = match[1];
		if (!SKIPPED_IDENTIFIER_WORDS.has(token)) {
			symbols.add(token);
		}
	}
	for (const match of commentText.matchAll(/`([A-Za-z_][A-Za-z0-9_]{2,})`/g)) {
		const token = match[1];
		if (!SKIPPED_IDENTIFIER_WORDS.has(token)) {
			symbols.add(token);
		}
	}
	const symbolList = Array.from(symbols).slice(0, 6);

	const lineRefs = new Set<number>();
	for (const match of commentText.matchAll(/(?:line\s*~?\s*|at\s+line\s*|:\s*)(\d{1,5})\b/gi)) {
		const value = Number.parseInt(match[1], 10);
		if (Number.isFinite(value) && value >= 1 && value <= document.lineCount) {
			lineRefs.add(value);
		}
	}

	const isInsideAnchor = (line: number): boolean =>
		line >= anchorRange.start.line && line <= anchorRange.end.line;
	const seenWindows = new Set<string>();
	let id = startId;
	let added = 0;
	const cap = 8;
	const maxBodyLines = 220;

	for (const symbol of symbolList) {
		if (added >= cap) {
			break;
		}
		const defLines = findSymbolDefinitionLines(document, symbol).slice(0, 2);
		for (const defLine of defLines) {
			if (added >= cap) {
				break;
			}
			if (isInsideAnchor(defLine)) {
				continue;
			}
			const block = extractFullFunctionBlock(document, defLine);
			let start: number;
			let end: number;
			let label: string;
			if (block && block.endLine - block.startLine <= maxBodyLines) {
				start = block.startLine;
				end = block.endLine;
				label = `referenced: ${symbol} — full body`;
			} else {
				start = Math.max(0, defLine - 6);
				end = Math.min(document.lineCount - 1, defLine + 30);
				label = `referenced: ${symbol} — window (full body too large or not found)`;
			}
			const key = `${start}-${end}`;
			if (seenWindows.has(key)) {
				continue;
			}
			seenWindows.add(key);
			items.push({
				id: `E${id}`,
				kind: 'code',
				source: `${relativePath}:${start + 1}-${end + 1} (${label})`,
				summary: `Body of \`${symbol}\` named in the reviewer comment`,
				content: sliceLinesWithNumbers(document, start, end),
			});
			id += 1;
			added += 1;
		}
	}

	for (const lineNumber of lineRefs) {
		if (added >= cap) {
			break;
		}
		const idx = lineNumber - 1;
		if (isInsideAnchor(idx)) {
			continue;
		}
		const start = Math.max(0, idx - 8);
		const end = Math.min(document.lineCount - 1, idx + 22);
		const key = `${start}-${end}`;
		if (seenWindows.has(key)) {
			continue;
		}
		seenWindows.add(key);
		items.push({
			id: `E${id}`,
			kind: 'code',
			source: `${relativePath}:${start + 1}-${end + 1} (referenced line ${lineNumber})`,
			summary: `Code around line ${lineNumber} cited by the reviewer comment`,
			content: sliceLinesWithNumbers(document, start, end),
		});
		id += 1;
		added += 1;
	}

	return items;
}

function findSymbolDefinitionLines(document: vscode.TextDocument, symbol: string): number[] {
	const escaped = escapeRegExp(symbol);
	const definitionPatterns = [
		new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+${escaped}\\s*\\(`),
		new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*=`),
		new RegExp(`^\\s*(?:public|private|protected)?\\s*(?:static\\s+)?(?:async\\s+)?${escaped}\\s*\\(`),
		new RegExp(`^\\s*${escaped}\\s*[:=]\\s*(?:async\\s*)?\\(`),
		new RegExp(`^\\s*(?:public|private|protected)\\s+(?:async\\s+)?${escaped}\\s*[:(]`),
	];
	const usagePattern = new RegExp(`\\b${escaped}\\s*\\(`);
	const definitionLines: number[] = [];
	const usageLines: number[] = [];
	for (let i = 0; i < document.lineCount; i += 1) {
		const text = document.lineAt(i).text;
		if (definitionPatterns.some((pattern) => pattern.test(text))) {
			definitionLines.push(i);
		} else if (usagePattern.test(text)) {
			usageLines.push(i);
		}
	}
	if (definitionLines.length) {
		return definitionLines.slice(0, 3);
	}
	return usageLines.slice(0, 3);
}

function findEnclosingFunctionBlock(
	document: vscode.TextDocument,
	line: number,
): { startLine: number; endLine: number } | undefined {
	for (let i = line; i >= Math.max(0, line - 400); i -= 1) {
		const text = document.lineAt(i).text;
		if (!isPlausibleDefinitionLine(text)) {
			continue;
		}
		const block = extractFullFunctionBlock(document, i);
		if (block && block.endLine >= line) {
			return block;
		}
	}
	return undefined;
}

function isPlausibleDefinitionLine(text: string): boolean {
	if (!text.trim()) {
		return false;
	}
	return (
		/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b/.test(text) ||
		/^\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:async\s*)?(?:\(|function\b)/.test(text) ||
		/^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:async\s+)?[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(text) ||
		/^\s*[A-Za-z_][A-Za-z0-9_]*\s*[:=]\s*(?:async\s*)?\(/.test(text)
	);
}

function extractFullFunctionBlock(
	document: vscode.TextDocument,
	defLine: number,
): { startLine: number; endLine: number } | undefined {
	if (defLine < 0 || defLine >= document.lineCount) {
		return undefined;
	}
	let braceLine = -1;
	let braceCol = -1;
	const search = Math.min(document.lineCount, defLine + 6);
	for (let i = defLine; i < search; i += 1) {
		const text = document.lineAt(i).text;
		const idx = findOpenBraceOutsideLiterals(text);
		if (idx >= 0) {
			braceLine = i;
			braceCol = idx;
			break;
		}
	}
	if (braceLine < 0) {
		return undefined;
	}
	let depth = 0;
	let inSingle = false;
	let inDouble = false;
	let inBacktick = false;
	let inBlockComment = false;
	const maxLines = Math.min(document.lineCount, braceLine + 600);
	for (let i = braceLine; i < maxLines; i += 1) {
		const text = document.lineAt(i).text;
		let inLineComment = false;
		const startCol = i === braceLine ? braceCol : 0;
		for (let j = startCol; j < text.length; j += 1) {
			const ch = text[j];
			const next = text[j + 1];
			if (inLineComment) {
				break;
			}
			if (inBlockComment) {
				if (ch === '*' && next === '/') {
					inBlockComment = false;
					j += 1;
				}
				continue;
			}
			if (inSingle) {
				if (ch === '\\') {
					j += 1;
					continue;
				}
				if (ch === "'") {
					inSingle = false;
				}
				continue;
			}
			if (inDouble) {
				if (ch === '\\') {
					j += 1;
					continue;
				}
				if (ch === '"') {
					inDouble = false;
				}
				continue;
			}
			if (inBacktick) {
				if (ch === '\\') {
					j += 1;
					continue;
				}
				if (ch === '`') {
					inBacktick = false;
				}
				continue;
			}
			if (ch === '/' && next === '/') {
				inLineComment = true;
				break;
			}
			if (ch === '/' && next === '*') {
				inBlockComment = true;
				j += 1;
				continue;
			}
			if (ch === "'") {
				inSingle = true;
				continue;
			}
			if (ch === '"') {
				inDouble = true;
				continue;
			}
			if (ch === '`') {
				inBacktick = true;
				continue;
			}
			if (ch === '{') {
				depth += 1;
			} else if (ch === '}') {
				depth -= 1;
				if (depth === 0) {
					return { startLine: defLine, endLine: i };
				}
			}
		}
	}
	return undefined;
}

function findOpenBraceOutsideLiterals(text: string): number {
	let inSingle = false;
	let inDouble = false;
	let inBacktick = false;
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		const next = text[i + 1];
		if (inSingle) {
			if (ch === '\\') {
				i += 1;
				continue;
			}
			if (ch === "'") {
				inSingle = false;
			}
			continue;
		}
		if (inDouble) {
			if (ch === '\\') {
				i += 1;
				continue;
			}
			if (ch === '"') {
				inDouble = false;
			}
			continue;
		}
		if (inBacktick) {
			if (ch === '\\') {
				i += 1;
				continue;
			}
			if (ch === '`') {
				inBacktick = false;
			}
			continue;
		}
		if (ch === '/' && next === '/') {
			return -1;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === '`') {
			inBacktick = true;
			continue;
		}
		if (ch === '{') {
			return i;
		}
	}
	return -1;
}

function findCandidateAnchorLines(
	commentText: string,
	document: vscode.TextDocument,
): string | undefined {
	const tokens = Array.from(
		new Set(
			(commentText.match(/`([^`]+)`/g) ?? [])
				.map((token) => token.replace(/`/g, '').trim())
				.filter((token) => token.length >= 3 && token.length <= 64),
		),
	);
	const identifierTokens = (commentText.match(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g) ?? []).filter(
		(token) => !SKIPPED_IDENTIFIER_WORDS.has(token),
	);
	const queries = Array.from(new Set([...tokens, ...identifierTokens])).slice(0, 8);
	if (!queries.length) {
		return undefined;
	}

	const lines: string[] = [`Search tokens: ${queries.join(', ')}`];
	let totalHits = 0;
	for (const query of queries) {
		const escaped = escapeRegExp(query);
		const regex = new RegExp(`\\b${escaped}\\b`);
		const hits: string[] = [];
		for (let i = 0; i < document.lineCount; i += 1) {
			const text = document.lineAt(i).text;
			if (regex.test(text)) {
				hits.push(`  ${i + 1}: ${text.trim()}`);
				if (hits.length >= 5) {
					break;
				}
			}
		}
		if (hits.length) {
			lines.push(`Token "${query}":`);
			lines.push(...hits);
			totalHits += hits.length;
		}
	}
	return totalHits ? lines.join('\n') : undefined;
}

function computeCoverageGaps(commentText: string, items: EvidenceItem[]): string[] {
	const namedFunctions = new Set<string>();
	for (const match of commentText.matchAll(/\b([A-Za-z_][A-Za-z0-9_]{2,})\s*\(/g)) {
		const token = match[1];
		if (!SKIPPED_IDENTIFIER_WORDS.has(token)) {
			namedFunctions.add(token);
		}
	}
	for (const match of commentText.matchAll(/`([A-Za-z_][A-Za-z0-9_]{2,})`/g)) {
		const token = match[1];
		if (!SKIPPED_IDENTIFIER_WORDS.has(token)) {
			namedFunctions.add(token);
		}
	}
	const gaps: string[] = [];
	for (const symbol of namedFunctions) {
		const hasFullBody = items.some(
			(item) => item.source.includes(`referenced: ${symbol}`) && item.source.includes('full body'),
		);
		const isAnchorEnclosing = items.some(
			(item) =>
				item.source.includes('anchor: full enclosing function') &&
				new RegExp(`\\b${escapeRegExp(symbol)}\\s*\\(`).test(item.content),
		);
		if (!hasFullBody && !isAnchorEnclosing) {
			gaps.push(
				`Body of \`${symbol}\` was not fully captured in the seed evidence — fetch it before deciding (use read_file_range or workspace_symbol_search).`,
			);
		}
	}
	return gaps;
}
