import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MAX_CONTEXT_CHARS } from './constants';

export const execFileAsync = promisify(execFile);

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function truncateText(text: string, maxChars: number, suffix: string): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars)}\n\n${suffix}`;
}

export function truncateContext(text: string): string {
	return truncateText(text, MAX_CONTEXT_CHARS, '[Context truncated due to length.]');
}
