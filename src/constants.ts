export const EXTENSION_NAME = 'PR Reply Assistant';
export const PARTICIPANT_ID = 'pr-reply-assistant.participant';
export const DRAFT_REPLY_COMMAND = 'pr-reply-assistant.draftReply';
export const RUN_ONBOARDING_COMMAND = 'pr-reply-assistant.runOnboarding';
export const OPEN_SETTINGS_COMMAND = 'pr-reply-assistant.openSettings';
export const CONFIG_SECTION = 'prReplyAssistant';

export const CONTEXT_LINES = 20;
export const RELATED_SNIPPET_LINES = 8;
export const MAX_RELATED_SNIPPETS = 4;
export const MAX_SYMBOL_QUERIES = 5;
export const MAX_CONTEXT_CHARS = 10_000;
export const MAX_DIFF_CONTEXT_CHARS = 3_500;
export const DIFF_UNIFIED_LINES = 8;
export const MAX_WEB_QUERY_COUNT = 2;
export const MAX_WEB_SUMMARY_CHARS = 2_000;
export const MAX_PR_STAT_CHARS = 1_500;
export const MAX_EVIDENCE_SYMBOLS = 4;
export const MAX_EVIDENCE_LINES_PER_KIND = 3;
export const MAX_DEEP_CHANGED_FILES = 12;
export const MAX_DEEP_DIFF_FILES = 4;
export const MAX_DEEP_CONTEXT_CHARS = 5_000;
export const MAX_FULL_PAGE_CONTEXT_CHARS = 12_000;
export const MAX_FILE_DIFF_CONTEXT_CHARS = 8_000;
export const MAX_REFERENCE_IMPACT_CHARS = 5_000;
export const MAX_ALL_PR_CHANGES_CHARS = 12_000;
export const MAX_COMPREHENSIVE_CONTEXT_CHARS = 20_000;
export const MAX_PR_DESCRIPTION_CHARS = 4_000;

export const SKIPPED_IDENTIFIER_WORDS = new Set([
	'const',
	'let',
	'var',
	'function',
	'return',
	'if',
	'else',
	'for',
	'while',
	'switch',
	'case',
	'new',
	'class',
	'async',
	'await',
	'this',
	'true',
	'false',
	'null',
	'undefined',
	'import',
	'from',
	'export',
	'default',
]);

export const EVIDENCE_SIGNAL_KEYWORDS = [
	'watch',
	'watchEffect',
	'onMounted',
	'onUpdated',
	'onUnmounted',
	'addEventListener',
	'scroll',
	'route',
	'router',
	'navigate',
	'setTimeout',
	'setInterval',
];

export const REFACTOR_INTENT_KEYWORDS = [
	'use ',
	'replace',
	'refactor',
	'simplif',
	'convert',
	'should we',
	'can we',
	'instead',
	'migrate',
];
