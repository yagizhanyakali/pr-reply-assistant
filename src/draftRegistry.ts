export type DraftRequestKeyInput = {
	commentText: string;
	commentAuthor?: string;
	uri?: string;
	range?: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
};

export class DraftInFlightRegistry {
	private readonly keys = new Set<string>();

	tryStart(input: DraftRequestKeyInput): string | undefined {
		const key = buildDraftRequestKey(input);
		if (this.keys.has(key)) {
			return undefined;
		}
		this.keys.add(key);
		return key;
	}

	finish(key: string | undefined): void {
		if (key) {
			this.keys.delete(key);
		}
	}
}

export function buildDraftRequestKey(input: DraftRequestKeyInput): string {
	const range = input.range
		? [
			input.range.start.line,
			input.range.start.character,
			input.range.end.line,
			input.range.end.character,
		].join(':')
		: 'no-range';
	return [
		input.uri ?? 'no-uri',
		range,
		input.commentAuthor ?? 'unknown-author',
		hashString(input.commentText),
	].join('|');
}

function hashString(value: string): string {
	let hash = 0;
	for (let i = 0; i < value.length; i += 1) {
		hash = Math.imul(31, hash) + value.charCodeAt(i);
		hash |= 0;
	}
	return hash.toString(36);
}
