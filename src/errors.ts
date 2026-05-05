import { EXTENSION_NAME } from './constants';

export function getUserFacingErrorMessage(error: unknown): string {
	const details = error instanceof Error ? error.message : String(error);
	const lower = details.toLowerCase();

	if (
		lower.includes('not found') ||
		lower.includes('no copilot language model') ||
		lower.includes('unavailable')
	) {
		return 'Copilot model unavailable. Sign in to GitHub Copilot and make sure chat models are enabled.';
	}

	if (
		lower.includes('auth') ||
		lower.includes('sign in') ||
		lower.includes('unauthorized') ||
		lower.includes('forbidden')
	) {
		return 'Copilot authentication is required. Sign in to GitHub and verify your Copilot subscription.';
	}

	return `${EXTENSION_NAME} failed: ${details}`;
}
