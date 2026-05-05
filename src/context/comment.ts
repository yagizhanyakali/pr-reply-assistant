import * as vscode from 'vscode';

export function extractCommentData(commentContext?: unknown): {
	commentText?: string;
	commentThread?: vscode.CommentThread;
	commentAuthor?: string;
} {
	if (!commentContext || typeof commentContext !== 'object') {
		return {};
	}

	const directComment = commentContext as Partial<vscode.Comment>;
	if (directComment.body !== undefined) {
		return {
			commentText: normalizeCommentBody(directComment.body),
			commentThread: extractCommentThread(commentContext),
			commentAuthor: directComment.author?.name,
		};
	}

	const nestedComment = (commentContext as { comment?: vscode.Comment }).comment;
	if (nestedComment?.body !== undefined) {
		return {
			commentText: normalizeCommentBody(nestedComment.body),
			commentThread: extractCommentThread(commentContext),
			commentAuthor: nestedComment.author?.name,
		};
	}

	return {
		commentThread: extractCommentThread(commentContext),
	};
}

export function normalizeCommentBody(body: string | vscode.MarkdownString): string {
	return typeof body === 'string' ? body : body.value;
}

export function getThreadConversationContext(
	commentThread: vscode.CommentThread,
): string | undefined {
	const { comments, label } = commentThread;
	if (!comments.length) {
		return undefined;
	}

	const lines: string[] = [];
	if (label) {
		lines.push(`Thread label: ${label}`);
	}

	const stateText =
		commentThread.state === vscode.CommentThreadState.Resolved ? 'Resolved' : 'Unresolved';
	lines.push(`Thread state: ${stateText}`);
	lines.push(`Thread history (${comments.length} comment${comments.length !== 1 ? 's' : ''}):`);

	for (const comment of comments) {
		const author = comment.author?.name ?? 'Unknown';
		const body = normalizeCommentBody(comment.body).trim();
		lines.push(`[${author}]: ${body}`);
	}
	return lines.join('\n');
}

export function getActiveEditorRangeForUri(uri?: vscode.Uri): vscode.Range | undefined {
	if (!uri) {
		return undefined;
	}
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.document.uri.toString() !== uri.toString()) {
		return undefined;
	}
	if (!editor.selection.isEmpty) {
		return new vscode.Range(editor.selection.start, editor.selection.end);
	}
	const line = editor.selection.active.line;
	const text = editor.document.lineAt(line).text;
	return new vscode.Range(line, 0, line, text.length);
}

function extractCommentThread(commentContext: unknown): vscode.CommentThread | undefined {
	if (!commentContext || typeof commentContext !== 'object') {
		return undefined;
	}
	const threadContext = commentContext as {
		commentThread?: vscode.CommentThread;
		thread?: vscode.CommentThread;
	};
	const direct = threadContext.commentThread ?? threadContext.thread;
	if (direct && looksLikeThread(direct)) {
		return direct;
	}
	return findThreadDeep(commentContext);
}

function looksLikeThread(value: unknown): value is vscode.CommentThread {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const t = value as { uri?: unknown; range?: unknown; comments?: unknown };
	return Boolean(
		t.uri instanceof vscode.Uri && t.range instanceof vscode.Range && Array.isArray(t.comments),
	);
}

function findThreadDeep(
	value: unknown,
	depth = 0,
	seen = new Set<unknown>(),
): vscode.CommentThread | undefined {
	if (depth > 4 || !value || typeof value !== 'object' || seen.has(value)) {
		return undefined;
	}
	seen.add(value);
	if (looksLikeThread(value)) {
		return value;
	}
	for (const child of Object.values(value as Record<string, unknown>)) {
		const found = findThreadDeep(child, depth + 1, seen);
		if (found) {
			return found;
		}
	}
	return undefined;
}
