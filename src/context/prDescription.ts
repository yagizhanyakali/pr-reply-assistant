import * as vscode from 'vscode';
import { MAX_PR_DESCRIPTION_CHARS } from '../constants';
import { execFileAsync, truncateText } from '../utils';

type GitHubRepo = {
	owner: string;
	repo: string;
};

type PullRequestSummary = {
	number: number;
	title: string;
	body?: string | null;
	html_url?: string;
	head?: { ref?: string };
	base?: { ref?: string };
};

export async function getPullRequestDescriptionContextForUri(
	uri?: vscode.Uri,
): Promise<string | undefined> {
	const folder = uri
		? vscode.workspace.getWorkspaceFolder(uri)
		: vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		return undefined;
	}
	return getPullRequestDescriptionContext(folder.uri.fsPath);
}

export async function getPullRequestDescriptionContext(
	cwd: string,
): Promise<string | undefined> {
	const [remoteUrl, branch] = await Promise.all([
		readGitValue(cwd, ['remote', 'get-url', 'origin']),
		readGitValue(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
	]);
	const repo = remoteUrl ? parseGitHubRemote(remoteUrl) : undefined;
	if (!repo || !branch || branch === 'HEAD') {
		return undefined;
	}

	const token = await getGitHubToken();
	const pr = await fetchPullRequestForBranch(repo, branch, token);
	if (!pr) {
		return undefined;
	}

	const body = pr.body?.trim() || '(empty description)';
	const lines = [
		`Pull request description (GitHub API, branch ${branch}):`,
		`PR: #${pr.number} ${pr.title}`,
		pr.html_url ? `URL: ${pr.html_url}` : undefined,
		pr.base?.ref ? `Base: ${pr.base.ref}` : undefined,
		pr.head?.ref ? `Head: ${pr.head.ref}` : undefined,
		'',
		body,
	].filter((line): line is string => Boolean(line));
	return truncateText(
		lines.join('\n'),
		MAX_PR_DESCRIPTION_CHARS,
		'[Pull request description truncated due to length.]',
	);
}

export function parseGitHubRemote(remoteUrl: string): GitHubRepo | undefined {
	const trimmed = remoteUrl.trim();
	const httpsMatch = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i);
	if (httpsMatch?.[1] && httpsMatch[2]) {
		return { owner: httpsMatch[1], repo: stripGitSuffix(httpsMatch[2]) };
	}
	const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
	if (sshMatch?.[1] && sshMatch[2]) {
		return { owner: sshMatch[1], repo: stripGitSuffix(sshMatch[2]) };
	}
	return undefined;
}

async function readGitValue(cwd: string, args: string[]): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync('git', args, {
			cwd,
			timeout: 3_000,
			maxBuffer: 256 * 1024,
		});
		const trimmed = stdout.trim();
		return trimmed || undefined;
	} catch {
		return undefined;
	}
}

async function getGitHubToken(): Promise<string | undefined> {
	try {
		const session = await vscode.authentication.getSession('github', ['repo'], {
			createIfNone: false,
		});
		return session?.accessToken;
	} catch {
		return undefined;
	}
}

async function fetchPullRequestForBranch(
	repo: GitHubRepo,
	branch: string,
	token?: string,
): Promise<PullRequestSummary | undefined> {
	const byHead = await fetchJson<PullRequestSummary[]>(
		`https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls?state=open&head=${encodeURIComponent(`${repo.owner}:${branch}`)}&per_page=5`,
		token,
	);
	if (byHead?.length) {
		return byHead[0];
	}

	const search = await fetchJson<{ items?: PullRequestSummary[] }>(
		`https://api.github.com/search/issues?q=${encodeURIComponent(`repo:${repo.owner}/${repo.repo} is:pr is:open head:${branch}`)}&per_page=5`,
		token,
	);
	return search?.items?.[0];
}

async function fetchJson<T>(url: string, token?: string): Promise<T | undefined> {
	try {
		const response = await fetch(url, {
			headers: {
				Accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
		});
		if (!response.ok) {
			return undefined;
		}
		return (await response.json()) as T;
	} catch {
		return undefined;
	}
}

function stripGitSuffix(value: string): string {
	return value.endsWith('.git') ? value.slice(0, -4) : value;
}
