import * as path from 'node:path';
import * as vscode from 'vscode';
import {
	MAX_ALL_PR_CHANGES_CHARS,
	MAX_DEEP_CHANGED_FILES,
	MAX_DEEP_CONTEXT_CHARS,
	MAX_DEEP_DIFF_FILES,
	MAX_FILE_DIFF_CONTEXT_CHARS,
	MAX_PR_STAT_CHARS,
} from '../constants';
import { execFileAsync, truncateText } from '../utils';

export async function runGitDiff(args: string[], cwd: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync('git', args, {
			cwd,
			timeout: 3000,
			maxBuffer: 1024 * 1024,
		});
		const trimmed = stdout.trim();
		return trimmed ? trimmed : undefined;
	} catch {
		return undefined;
	}
}

export type GitDiffSource = {
	label: string;
	args: string[];
};

export async function runFirstAvailableDiff(params: {
	cwd: string;
	diffArgs?: string[];
	path?: string;
}): Promise<{ label: string; text: string } | undefined> {
	const pathArgs = params.path ? ['--', params.path] : [];
	const branchBase = await getBranchBaseRef(params.cwd);
	const attempts: GitDiffSource[] = [
		{
			label: 'working tree diff',
			args: ['diff', ...(params.diffArgs ?? []), ...pathArgs],
		},
		{
			label: 'staged diff',
			args: ['diff', '--cached', ...(params.diffArgs ?? []), ...pathArgs],
		},
	];
	if (branchBase) {
		attempts.push({
			label: `branch-base diff (${branchBase.label})`,
			args: ['diff', ...(params.diffArgs ?? []), branchBase.base, 'HEAD', ...pathArgs],
		});
	}
	attempts.push(
		{
			label: 'last commit diff',
			args: ['diff', ...(params.diffArgs ?? []), 'HEAD~1', 'HEAD', ...pathArgs],
		},
	);

	for (const attempt of attempts) {
		const text = await runGitDiff(attempt.args, params.cwd);
		if (text) {
			return { label: attempt.label, text };
		}
	}
	return undefined;
}

export async function getFullPrDiffContext(
	commentThread?: vscode.CommentThread,
): Promise<string | undefined> {
	return getFullPrDiffContextForUri(commentThread?.uri);
}

export async function getFullPrDiffContextForUri(uri?: vscode.Uri): Promise<string | undefined> {
	const folder = uri
		? vscode.workspace.getWorkspaceFolder(uri)
		: vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return undefined;
	}

	const cwd = folder.uri.fsPath;

	const available = await runFirstAvailableDiff({ cwd, diffArgs: ['--stat'] });
	if (available) {
		return truncateText(
			`Available change context (${available.label}):\n${available.text}`,
			MAX_PR_STAT_CHARS,
			'[Available change context truncated due to length.]',
		);
	}

	return undefined;
}

export async function getPageDiffContext(
	cwd: string,
	relativePath: string,
): Promise<string | undefined> {
	const diff = await runFirstAvailableDiff({
		cwd,
		diffArgs: ['--unified=6'],
		path: relativePath,
	});
	if (!diff) {
		return undefined;
	}
	return truncateText(
		`${diff.label}:\n${diff.text}`,
		MAX_FILE_DIFF_CONTEXT_CHARS,
		'[Page diff truncated due to length.]',
	);
}

export async function getAllPrChangesContext(cwd: string): Promise<string | undefined> {
	const diff = await runFirstAvailableDiff({ cwd, diffArgs: ['--unified=3'] });
	if (!diff) {
		return undefined;
	}
	return truncateText(
		`${diff.label}:\n${diff.text}`,
		MAX_ALL_PR_CHANGES_CHARS,
		'[Available change context truncated due to length.]',
	);
}

export async function getDeepContextForComment(
	commentThread?: vscode.CommentThread,
): Promise<string | undefined> {
	return getDeepContextForUri(commentThread?.uri);
}

export async function getDeepContextForUri(uri?: vscode.Uri): Promise<string | undefined> {
	const folder = uri
		? vscode.workspace.getWorkspaceFolder(uri)
		: vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return undefined;
	}

	const cwd = folder.uri.fsPath;
	const changedFiles = await getChangedFilesForDeepContext(cwd);
	if (!changedFiles.length) {
		return undefined;
	}

	const diagnosticsSummary = await getDiagnosticsSummaryForChangedFiles(folder.uri, changedFiles);
	const detailedDiff = await getDetailedDiffForChangedFiles(cwd, changedFiles);
	const parts = [
		`Deep context changed files (${changedFiles.length}):`,
		changedFiles.map((file) => `- ${file}`).join('\n'),
	];
	if (diagnosticsSummary) {
		parts.push('', diagnosticsSummary);
	}
	if (detailedDiff) {
		parts.push('', detailedDiff);
	}

	return truncateText(parts.join('\n'), MAX_DEEP_CONTEXT_CHARS, '[Deep context truncated due to length.]');
}

async function getChangedFilesForDeepContext(cwd: string): Promise<string[]> {
	const diff = await runFirstAvailableDiff({ cwd, diffArgs: ['--name-only'] });
	if (!diff) {
		return [];
	}
	return diff.text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => Boolean(line))
		.slice(0, MAX_DEEP_CHANGED_FILES);
}

async function getDiagnosticsSummaryForChangedFiles(
	folderUri: vscode.Uri,
	changedFiles: string[],
): Promise<string | undefined> {
	const lines: string[] = [];
	for (const file of changedFiles) {
		try {
			const fileUri = vscode.Uri.file(path.join(folderUri.fsPath, file));
			const diagnostics = vscode.languages.getDiagnostics(fileUri);
			if (!diagnostics.length) {
				continue;
			}
			const severities = diagnostics.reduce(
				(acc, diagnostic) => {
					if (diagnostic.severity === vscode.DiagnosticSeverity.Error) {
						acc.errors += 1;
					} else if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) {
						acc.warnings += 1;
					}
					return acc;
				},
				{ errors: 0, warnings: 0 },
			);
			lines.push(
				`- ${file}: ${severities.errors} error(s), ${severities.warnings} warning(s)`,
			);
		} catch {
			// Ignore diagnostics failures per file.
		}
	}
	if (!lines.length) {
		return undefined;
	}
	return ['Diagnostics on changed files:', ...lines].join('\n');
}

async function getDetailedDiffForChangedFiles(
	cwd: string,
	changedFiles: string[],
): Promise<string | undefined> {
	const selected = changedFiles.slice(0, MAX_DEEP_DIFF_FILES);
	const snippets: string[] = [];
	for (const file of selected) {
		const diff = await runFirstAvailableDiff({
			cwd,
			diffArgs: ['--unified=3'],
			path: file,
		});
		if (!diff) {
			continue;
		}
		snippets.push(`File diff: ${file} (${diff.label})\n${truncateText(diff.text, 1_500, '[File diff truncated.]')}`);
	}
	if (!snippets.length) {
		return undefined;
	}
	return ['Detailed diffs for top changed files:', ...snippets].join('\n\n');
}

async function getBranchBaseRef(cwd: string): Promise<{ base: string; label: string } | undefined> {
	const candidates = await getBranchBaseCandidates(cwd);
	for (const candidate of candidates) {
		const base = await runGitDiff(['merge-base', 'HEAD', candidate], cwd);
		if (base) {
			return { base, label: candidate };
		}
	}
	return undefined;
}

async function getBranchBaseCandidates(cwd: string): Promise<string[]> {
	const candidates: string[] = [];
	const originHead = await runGitDiff(['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], cwd);
	if (originHead) {
		candidates.push(originHead);
	}
	candidates.push('origin/main', 'origin/master', 'main', 'master', '@{upstream}');
	const unique: string[] = [];
	for (const candidate of candidates) {
		if (!unique.includes(candidate)) {
			unique.push(candidate);
		}
	}
	return unique;
}
