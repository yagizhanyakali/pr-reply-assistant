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

	const workingTreeStat = await runGitDiff(['diff', '--stat'], cwd);
	if (workingTreeStat) {
		return truncateText(
			`Changed files (working tree):\n${workingTreeStat}`,
			MAX_PR_STAT_CHARS,
			'[PR stat truncated due to length.]',
		);
	}

	const stagedStat = await runGitDiff(['diff', '--cached', '--stat'], cwd);
	if (stagedStat) {
		return truncateText(
			`Changed files (staged):\n${stagedStat}`,
			MAX_PR_STAT_CHARS,
			'[PR stat truncated due to length.]',
		);
	}

	const lastCommitStat = await runGitDiff(['diff', '--stat', 'HEAD~1', 'HEAD'], cwd);
	if (lastCommitStat) {
		return truncateText(
			`Changed files (last commit):\n${lastCommitStat}`,
			MAX_PR_STAT_CHARS,
			'[PR stat truncated due to length.]',
		);
	}

	return undefined;
}

export async function getPageDiffContext(
	cwd: string,
	relativePath: string,
): Promise<string | undefined> {
	const diff =
		(await runGitDiff(['diff', '--unified=6', '--', relativePath], cwd)) ??
		(await runGitDiff(['diff', '--cached', '--unified=6', '--', relativePath], cwd)) ??
		(await runGitDiff(['diff', '--unified=6', 'HEAD~1', 'HEAD', '--', relativePath], cwd));
	if (!diff) {
		return undefined;
	}
	return truncateText(diff, MAX_FILE_DIFF_CONTEXT_CHARS, '[Page diff truncated due to length.]');
}

export async function getAllPrChangesContext(cwd: string): Promise<string | undefined> {
	const diff =
		(await runGitDiff(['diff', '--unified=3'], cwd)) ??
		(await runGitDiff(['diff', '--cached', '--unified=3'], cwd)) ??
		(await runGitDiff(['diff', '--unified=3', 'HEAD~1', 'HEAD'], cwd));
	if (!diff) {
		return undefined;
	}
	return truncateText(diff, MAX_ALL_PR_CHANGES_CHARS, '[PR-wide diff truncated due to length.]');
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
	const working = await runGitDiff(['diff', '--name-only'], cwd);
	const staged = await runGitDiff(['diff', '--cached', '--name-only'], cwd);
	const lastCommit = await runGitDiff(['diff', '--name-only', 'HEAD~1', 'HEAD'], cwd);
	const raw = working ?? staged ?? lastCommit;
	if (!raw) {
		return [];
	}
	return raw
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
		const diff =
			(await runGitDiff(['diff', '--unified=3', '--', file], cwd)) ??
			(await runGitDiff(['diff', '--cached', '--unified=3', '--', file], cwd));
		if (!diff) {
			continue;
		}
		snippets.push(`File diff: ${file}\n${truncateText(diff, 1_500, '[File diff truncated.]')}`);
	}
	if (!snippets.length) {
		return undefined;
	}
	return ['Detailed diffs for top changed files:', ...snippets].join('\n\n');
}
