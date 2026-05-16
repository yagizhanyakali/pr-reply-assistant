import * as assert from 'assert';

import { DraftInFlightRegistry } from '../draftRegistry';
import { TONE_PRESETS, STRATEGY_PRESETS } from '../presets';
import { routeDraftEffort } from '../pipeline/effort';
import { formatSingleDraftOutput } from '../pipeline/format';
import { applyAnchorGate, applySafetyGate } from '../pipeline/gates';
import { AutoDecisionResult } from '../pipeline/types';
import { emptyTokenUsage } from '../llmClient';

suite('Extension Test Suite', () => {
	const tone = TONE_PRESETS[0];
	const autoStrategy = STRATEGY_PRESETS[0];

	function sampleResult(): AutoDecisionResult {
		return {
			selectedStrategy: 'agree',
			confidence: 0.92,
			rationale: ['Supported by [E1].'],
			reply: 'Thanks, I will make that change.',
			tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			pipelineDetails: {
				deciderStrategy: 'agree',
				deciderConfidence: 0.91,
				criticStrategy: 'agree',
				criticConfidence: 0.95,
				criticAgreement: 'aligned',
				citations: ['E1'],
				evidenceCount: 1,
				plannerIterations: 1,
				gaps: [],
				anchorVerified: true,
				anchorOverrideApplied: false,
			},
		};
	}

	test('formats reply-only output by default', () => {
		const formatted = formatSingleDraftOutput({
			result: sampleResult(),
			selectedTonePreset: tone,
			selectedStrategyPreset: autoStrategy,
			outputDetail: 'replyOnly',
		});
		assert.strictEqual(formatted, 'Thanks, I will make that change.');
	});

	test('formats compact output without planner, critic, or token details', () => {
		const formatted = formatSingleDraftOutput({
			result: sampleResult(),
			selectedTonePreset: tone,
			selectedStrategyPreset: autoStrategy,
			outputDetail: 'compact',
		});
		assert.match(formatted, /Strategy: Auto -> Agree/);
		assert.match(formatted, /Confidence: 92%/);
		assert.doesNotMatch(formatted, /Planner|Critic|Token usage/i);
	});

	test('formats full diagnostic output', () => {
		const formatted = formatSingleDraftOutput({
			result: sampleResult(),
			selectedTonePreset: tone,
			selectedStrategyPreset: autoStrategy,
			outputDetail: 'full',
		});
		assert.match(formatted, /Token usage: prompt 10, completion 5, total 15/);
		assert.match(formatted, /Decider: Agree/);
		assert.match(formatted, /Critic: Agree/);
	});

	test('safety gate replaces stale agree reply when overriding strategy', () => {
		const outcome = applySafetyGate({
			commentText: 'Can we replace this with a simpler refactor?',
			additionalInstructions: '',
			symbolEvidenceContext: [
				'Symbol: value',
				'Changed in diff: yes',
				'Writes (1):',
				'12: value = route.query.id',
				'Reads (1):',
				'20: return value',
				'Mutation signals: route',
			].join('\n'),
			strategy: 'agree',
			confidence: 0.9,
			rationale: ['Original agree rationale.'],
			reply: 'Sure, I will replace it.',
		});
		assert.strictEqual(outcome.strategy, 'pushback');
		assert.notStrictEqual(outcome.reply, 'Sure, I will replace it.');
		assert.match(outcome.reply ?? '', /hold off|double-check/);
	});

	test('unverified anchor fallback avoids correctness claims', () => {
		const outcome = applyAnchorGate({
			anchorVerified: false,
			strategy: 'clarify',
			confidence: 0.4,
			rationale: [],
			reply: '',
			relativeFilePath: 'src/example.ts',
		});
		assert.doesNotMatch(outcome.reply, /no additional updates needed|consistent with the change/i);
		assert.match(outcome.reply, /double-check/);
	});

	test('effort router chooses fast, standard, and deep routes', () => {
		assert.strictEqual(routeDraftEffort({
			commentText: 'nit: typo',
			strategy: 'auto',
			contextDepth: 'standard',
			anchorVerified: true,
		}), 'fast');
		assert.strictEqual(routeDraftEffort({
			commentText: 'Should this validation happen before saving?',
			strategy: 'auto',
			contextDepth: 'standard',
			anchorVerified: true,
		}), 'standard');
		assert.strictEqual(routeDraftEffort({
			commentText: 'Can you inspect the full context and call chain for this refactor?',
			strategy: 'auto',
			contextDepth: 'standard',
			anchorVerified: true,
		}), 'deep');
	});

	test('in-flight registry blocks duplicate comment runs and allows distinct comments', () => {
		const registry = new DraftInFlightRegistry();
		const first = registry.tryStart({
			commentText: 'Please rename this.',
			commentAuthor: 'Reviewer',
			uri: 'file:///repo/src/example.ts',
			range: {
				start: { line: 3, character: 0 },
				end: { line: 3, character: 12 },
			},
		});
		assert.ok(first);
		const duplicate = registry.tryStart({
			commentText: 'Please rename this.',
			commentAuthor: 'Reviewer',
			uri: 'file:///repo/src/example.ts',
			range: {
				start: { line: 3, character: 0 },
				end: { line: 3, character: 12 },
			},
		});
		assert.strictEqual(duplicate, undefined);
		const other = registry.tryStart({
			commentText: 'Please rename that.',
			commentAuthor: 'Reviewer',
			uri: 'file:///repo/src/example.ts',
			range: {
				start: { line: 8, character: 0 },
				end: { line: 8, character: 12 },
			},
		});
		assert.ok(other);
		registry.finish(first);
		assert.ok(registry.tryStart({
			commentText: 'Please rename this.',
			commentAuthor: 'Reviewer',
			uri: 'file:///repo/src/example.ts',
			range: {
				start: { line: 3, character: 0 },
				end: { line: 3, character: 12 },
			},
		}));
	});

	test('empty token usage remains available for lightweight test fixtures', () => {
		assert.deepStrictEqual(emptyTokenUsage(), {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
		});
	});
});
