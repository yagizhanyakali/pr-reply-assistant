import * as path from 'node:path';
import * as vscode from 'vscode';
import { ToolRegistry, ToolSpec } from '../agents';
import { CONTEXT_LINES } from '../constants';
import { execFileAsync } from '../utils';
import { buildCodeContextFromDocumentRange } from '../context/code';
import { buildSymbolEvidenceFromDocumentRange } from '../context/evidence';
import {
	buildFullPageContext,
	findSymbolPosition,
	getComprehensiveContext,
} from '../context/comprehensive';
import {
	getAllPrChangesContext,
	getDeepContextForUri,
	getFullPrDiffContextForUri,
	getPageDiffContext,
} from '../context/git';
import { fetchDuckDuckGoSummary } from '../context/web';

export function buildContextToolRegistry(seed: {
	commentText: string;
	commentUri?: vscode.Uri;
	commentRange?: vscode.Range;
}): ToolRegistry {
	const seedFolder = seed.commentUri
		? vscode.workspace.getWorkspaceFolder(seed.commentUri)
		: vscode.workspace.workspaceFolders?.[0];
	const seedRelativePath = seed.commentUri
		? vscode.workspace.asRelativePath(seed.commentUri, false).replace(/\\/g, '/')
		: undefined;

	function resolveWorkspaceUri(
		relativePath?: string,
	): { uri: vscode.Uri; cwd: string; relativePath: string } | undefined {
		const folder = seedFolder ?? vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			return undefined;
		}
		const cwd = folder.uri.fsPath;
		const rel = (relativePath || seedRelativePath || '').trim();
		if (!rel) {
			return undefined;
		}
		const joined = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
		return { uri: vscode.Uri.file(joined), cwd, relativePath: rel.replace(/\\/g, '/') };
	}

	const tools: ToolSpec[] = [
		{
			name: 'read_file_range',
			description:
				'Read a slice of a workspace file with line numbers. Use to inspect specific code referenced by the comment.',
			args: {
				path: 'string (workspace-relative)',
				startLine: 'number (1-based, inclusive)',
				endLine: 'number (1-based, inclusive)',
			},
			handler: async (args) => {
				const relPath = asString(args.path);
				const startLine = asNumber(args.startLine) ?? 1;
				const endLine = asNumber(args.endLine);
				const resolved = resolveWorkspaceUri(relPath);
				if (!resolved) {
					return undefined;
				}
				try {
					const document = await vscode.workspace.openTextDocument(resolved.uri);
					const start = Math.max(0, startLine - 1);
					const end = Math.min(document.lineCount - 1, (endLine ?? document.lineCount) - 1);
					if (end < start) {
						return undefined;
					}
					const lines: string[] = [];
					for (let i = start; i <= end; i += 1) {
						lines.push(`${i + 1}: ${document.lineAt(i).text}`);
					}
					const content = `File: ${resolved.relativePath}\nLines ${start + 1}-${end + 1} of ${document.lineCount}\n${lines.join('\n')}`;
					return {
						summary: `${resolved.relativePath}:${start + 1}-${end + 1}`,
						content,
					};
				} catch {
					return undefined;
				}
			},
		},
		{
			name: 'read_full_file',
			description: 'Read an entire workspace file with line numbers. Prefer read_file_range when the file is large.',
			args: { path: 'string (workspace-relative)' },
			handler: async (args) => {
				const resolved = resolveWorkspaceUri(asString(args.path));
				if (!resolved) {
					return undefined;
				}
				try {
					const document = await vscode.workspace.openTextDocument(resolved.uri);
					return {
						summary: `${resolved.relativePath} (full, ${document.lineCount} lines)`,
						content: buildFullPageContext(document),
					};
				} catch {
					return undefined;
				}
			},
		},
		{
			name: 'code_context_around_comment',
			description: 'Return code, diff hunks, and related-symbol snippets around the commented range. Use as a starting point.',
			args: {},
			handler: async () => {
				if (!seed.commentUri || !seed.commentRange) {
					return undefined;
				}
				try {
					const document = await vscode.workspace.openTextDocument(seed.commentUri);
					const text = await buildCodeContextFromDocumentRange(document, seed.commentRange);
					if (!text) {
						return undefined;
					}
					return {
						summary: `code context around ${seedRelativePath ?? 'comment'}:${seed.commentRange.start.line + 1}`,
						content: text,
					};
				} catch {
					return undefined;
				}
			},
		},
		{
			name: 'symbol_evidence_around_comment',
			description:
				'Structured evidence for symbols mentioned in the comment: where they are read/written and whether the diff touches them.',
			args: {},
			handler: async () => {
				if (!seed.commentUri || !seed.commentRange) {
					return undefined;
				}
				try {
					const document = await vscode.workspace.openTextDocument(seed.commentUri);
					const text = await buildSymbolEvidenceFromDocumentRange(
						seed.commentText,
						document,
						seed.commentRange,
					);
					if (!text) {
						return undefined;
					}
					return {
						summary: `symbol evidence for ${seedRelativePath ?? 'commented file'}`,
						content: text,
					};
				} catch {
					return undefined;
				}
			},
		},
		{
			name: 'pr_diff_stat',
			description: 'List of files changed in the PR with insertion/deletion stats.',
			args: {},
			handler: async () => {
				const text = await getFullPrDiffContextForUri(seed.commentUri);
				if (!text) {
					return undefined;
				}
				return { summary: 'PR-wide diffstat', content: text };
			},
		},
		{
			name: 'pr_full_diff',
			description: 'Full unified diff across the PR (truncated). Expensive — use only when broad scope is needed.',
			args: {},
			handler: async () => {
				if (!seedFolder) {
					return undefined;
				}
				const text = await getAllPrChangesContext(seedFolder.uri.fsPath);
				if (!text) {
					return undefined;
				}
				return { summary: 'PR full diff (truncated)', content: text };
			},
		},
		{
			name: 'file_diff',
			description: 'Unified diff for a specific file (working tree, staged, or last commit).',
			args: { path: 'string (workspace-relative; default = commented file)' },
			handler: async (args) => {
				const resolved = resolveWorkspaceUri(asString(args.path));
				if (!resolved) {
					return undefined;
				}
				const text = await getPageDiffContext(resolved.cwd, resolved.relativePath);
				if (!text) {
					return undefined;
				}
				return { summary: `diff of ${resolved.relativePath}`, content: text };
			},
		},
		{
			name: 'find_references',
			description: 'Find references to a symbol in the workspace. Pass the file path of a known definition for best accuracy.',
			args: {
				symbol: 'string',
				path: 'string (optional, workspace-relative)',
				line: 'number (optional, 1-based)',
			},
			handler: async (args) => {
				const symbol = asString(args.symbol);
				if (!symbol) {
					return undefined;
				}
				const resolved = resolveWorkspaceUri(asString(args.path));
				const lineHint = asNumber(args.line);
				let document: vscode.TextDocument | undefined;
				let position: vscode.Position | undefined;
				if (resolved) {
					try {
						document = await vscode.workspace.openTextDocument(resolved.uri);
						const range = lineHint
							? new vscode.Range(
								Math.max(0, lineHint - 1),
								0,
								Math.max(0, lineHint - 1),
								document.lineAt(Math.max(0, lineHint - 1)).text.length,
							)
							: new vscode.Range(0, 0, Math.min(document.lineCount - 1, CONTEXT_LINES * 2), 0);
						position = findSymbolPosition(document, symbol, range);
					} catch {
						return undefined;
					}
				}
				if (!document || !position) {
					return undefined;
				}
				try {
					const refs = await vscode.commands.executeCommand<vscode.Location[]>(
						'vscode.executeReferenceProvider',
						document.uri,
						position,
					);
					if (!refs?.length) {
						return undefined;
					}
					const grouped = new Map<string, number>();
					for (const ref of refs) {
						const file = vscode.workspace.asRelativePath(ref.uri, false);
						grouped.set(file, (grouped.get(file) ?? 0) + 1);
					}
					const lines = [
						`Symbol: ${symbol}`,
						`Total references: ${refs.length}`,
						'By file:',
						...Array.from(grouped.entries())
							.sort(([, a], [, b]) => b - a)
							.slice(0, 12)
							.map(([file, count]) => `- ${file}: ${count}`),
						'Sample locations:',
						...refs
							.slice(0, 10)
							.map((ref) => `- ${vscode.workspace.asRelativePath(ref.uri, false)}:${ref.range.start.line + 1}`),
					];
					return { summary: `references to ${symbol}: ${refs.length}`, content: lines.join('\n') };
				} catch {
					return undefined;
				}
			},
		},
		{
			name: 'workspace_symbol_search',
			description: 'Search workspace symbols by name (uses LSP). Returns up to 10 matches.',
			args: { query: 'string' },
			handler: async (args) => {
				const query = asString(args.query);
				if (!query) {
					return undefined;
				}
				try {
					const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
						'vscode.executeWorkspaceSymbolProvider',
						query,
					);
					if (!symbols?.length) {
						return undefined;
					}
					const lines = symbols.slice(0, 10).map((sym) => {
						const file = vscode.workspace.asRelativePath(sym.location.uri, false);
						return `- ${sym.name} (${vscode.SymbolKind[sym.kind] ?? 'symbol'}) at ${file}:${sym.location.range.start.line + 1}`;
					});
					return {
						summary: `workspace symbols matching "${query}": ${symbols.length}`,
						content: [`Query: ${query}`, ...lines].join('\n'),
					};
				} catch {
					return undefined;
				}
			},
		},
		{
			name: 'grep_workspace',
			description: 'git grep for a pattern in tracked files. Returns up to 60 matching lines.',
			args: { query: 'string (regex or literal)' },
			handler: async (args) => {
				const query = asString(args.query);
				if (!query || !seedFolder) {
					return undefined;
				}
				try {
					const { stdout } = await execFileAsync('git', ['grep', '-n', '-E', '--', query], {
						cwd: seedFolder.uri.fsPath,
						timeout: 4_000,
						maxBuffer: 1024 * 1024,
					});
					const trimmed = stdout.trim();
					if (!trimmed) {
						return undefined;
					}
					const lines = trimmed.split('\n').slice(0, 60);
					return {
						summary: `grep matches for "${query}": ${lines.length}${trimmed.split('\n').length > lines.length ? '+' : ''}`,
						content: lines.join('\n'),
					};
				} catch {
					return undefined;
				}
			},
		},
		{
			name: 'git_log',
			description: 'Recent commit history. Optionally limit to a single file.',
			args: {
				path: 'string (optional, workspace-relative)',
				limit: 'number (default 10, max 30)',
			},
			handler: async (args) => {
				if (!seedFolder) {
					return undefined;
				}
				const limit = Math.max(1, Math.min(30, asNumber(args.limit) ?? 10));
				const targetPath = asString(args.path);
				const argv = ['log', '--pretty=%h %ad %an  %s', '--date=short', '-n', String(limit)];
				if (targetPath) {
					argv.push('--', targetPath);
				}
				try {
					const { stdout } = await execFileAsync('git', argv, {
						cwd: seedFolder.uri.fsPath,
						timeout: 3_000,
						maxBuffer: 1024 * 1024,
					});
					const trimmed = stdout.trim();
					if (!trimmed) {
						return undefined;
					}
					return {
						summary: `git log${targetPath ? ` for ${targetPath}` : ''} (${limit})`,
						content: trimmed,
					};
				} catch {
					return undefined;
				}
			},
		},
		{
			name: 'git_blame',
			description: 'Blame a single line of a file: returns commit, author, date, and original commit message.',
			args: { path: 'string (workspace-relative)', line: 'number (1-based)' },
			handler: async (args) => {
				const resolved = resolveWorkspaceUri(asString(args.path));
				const line = asNumber(args.line);
				if (!resolved || !line) {
					return undefined;
				}
				try {
					const { stdout } = await execFileAsync(
						'git',
						['blame', '-L', `${line},${line}`, '--porcelain', '--', resolved.relativePath],
						{ cwd: resolved.cwd, timeout: 3_000, maxBuffer: 256 * 1024 },
					);
					const trimmed = stdout.trim();
					if (!trimmed) {
						return undefined;
					}
					return {
						summary: `blame ${resolved.relativePath}:${line}`,
						content: trimmed,
					};
				} catch {
					return undefined;
				}
			},
		},
		{
			name: 'deep_context',
			description: 'Snapshot of changed-file diagnostics and detailed diffs across the PR.',
			args: {},
			handler: async () => {
				const text = await getDeepContextForUri(seed.commentUri);
				if (!text) {
					return undefined;
				}
				return { summary: 'deep PR context (diagnostics + detailed diffs)', content: text };
			},
		},
		{
			name: 'comprehensive_context_around_comment',
			description: 'Bundle: full commented file, file diff, reference impact, PR-wide diff. Expensive.',
			args: {},
			handler: async () => {
				if (!seed.commentUri) {
					return undefined;
				}
				const text = await getComprehensiveContext({
					commentText: seed.commentText,
					uri: seed.commentUri,
					range: seed.commentRange,
				});
				if (!text) {
					return undefined;
				}
				return { summary: 'comprehensive context bundle', content: text };
			},
		},
		{
			name: 'web_search',
			description:
				'Light-weight DuckDuckGo summary for an external concept. Use only when external docs are clearly needed.',
			args: { query: 'string' },
			handler: async (args) => {
				const query = asString(args.query);
				if (!query) {
					return undefined;
				}
				const summary = await fetchDuckDuckGoSummary(query);
				if (!summary) {
					return undefined;
				}
				return {
					summary: `web summary: ${query}`,
					content: `Query: ${query}\n${summary}`,
				};
			},
		},
	];
	return tools;
}

function asString(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}
