import * as vscode from 'vscode';

export type DraftMode = 'agree' | 'pushback' | 'clarify';

export type EvidenceKind =
	| 'code'
	| 'diff'
	| 'reference'
	| 'symbol-evidence'
	| 'thread'
	| 'web'
	| 'note'
	| 'commits';

export type EvidenceItem = {
	id: string;
	kind: EvidenceKind;
	source: string;
	summary: string;
	content: string;
};

export type ToolCallRecord = {
	tool: string;
	args: Record<string, unknown>;
	ok: boolean;
	note?: string;
};

export type EvidencePack = {
	items: EvidenceItem[];
	gaps: string[];
	toolCalls: ToolCallRecord[];
};

export type AgentDecision = {
	selectedStrategy: DraftMode | 'unknown';
	confidence?: number;
	rationale: string[];
	citations: string[];
	requestedEvidence?: string[];
	dissent?: string;
};

export type ArbiterResult = {
	selectedStrategy: DraftMode | 'unknown';
	confidence?: number;
	rationale: string[];
	citations: string[];
	reply: string;
	criticAgreement: 'aligned' | 'split' | 'unknown';
};

export type TokenUsageSummary = {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
};

export type ToolResult = {
	summary: string;
	content: string;
} | undefined;

export type ToolHandler = (
	args: Record<string, unknown>,
) => Promise<ToolResult>;

export type ToolSpec = {
	name: string;
	description: string;
	args: Record<string, string>;
	handler: ToolHandler;
};

export type ToolRegistry = ToolSpec[];

export type StylePreset = {
	id: string;
	label: string;
	detail: string;
	styleGuidance: string;
};

export type PipelineInputs = {
	model: vscode.LanguageModelChat;
	commentText: string;
	commentAuthor?: string;
	additionalInstructions: string;
	threadContext?: string;
	tonePreset: StylePreset;
	strategyInstruction: string;
	tools: ToolRegistry;
	logger?: (line: string) => void;
	commentLocationHint?: string;
	seedEvidence?: EvidenceItem[];
	seedGaps?: string[];
	language?: string;
	personalToneExamples?: string;
};

export type PipelineResult = {
	decision: ArbiterResult;
	deciderDecision: AgentDecision;
	criticDecision: AgentDecision;
	evidencePack: EvidencePack;
	tokenUsage: TokenUsageSummary;
	plannerIterations: number;
};

const PLANNER_MAX_ROUNDS_PRIMARY = 6;
const PLANNER_MAX_ROUNDS_SECONDARY = 3;
const MAX_EVIDENCE_ITEMS = 24;
const MAX_EVIDENCE_CONTENT_CHARS = 2_400;
const MAX_PACK_RENDERED_CHARS = 14_000;

export async function runQualityDraftPipeline(
	inputs: PipelineInputs,
): Promise<PipelineResult> {
	const log = inputs.logger ?? (() => {});
	log('Pipeline: starting ContextPlanner pass 1.');
	const seedPack: EvidencePack | undefined = (inputs.seedEvidence?.length || inputs.seedGaps?.length)
		? {
			items: inputs.seedEvidence ?? [],
			gaps: inputs.seedGaps ?? [],
			toolCalls: [],
		}
		: undefined;
	const plannerPass1Raw = await runContextPlanner({
		inputs,
		seedGaps: [],
		maxRounds: PLANNER_MAX_ROUNDS_PRIMARY,
		previousPack: seedPack,
	});
	const plannerPass1 = {
		...plannerPass1Raw,
		pack: seedPack
			? mergeEvidencePacks(seedPack, plannerPass1Raw.pack)
			: plannerPass1Raw.pack,
	};
	log(
		`Planner pass 1 done: ${plannerPass1.pack.items.length} evidence items, ` +
			`${plannerPass1.pack.gaps.length} gap(s), ${plannerPass1.iterations} round(s).`,
	);

	const deciderRun = await runDecider({
		inputs,
		evidencePack: plannerPass1.pack,
	});
	log(
		`Decider: ${deciderRun.decision.selectedStrategy} (confidence ${deciderRun.decision.confidence ?? 'n/a'}).`,
	);

	const criticPass1 = await runCritic({
		inputs,
		evidencePack: plannerPass1.pack,
		deciderDecision: deciderRun.decision,
	});
	log(
		`Critic pass 1: ${criticPass1.decision.selectedStrategy} ` +
			`(${criticPass1.decision.requestedEvidence?.length ?? 0} extra evidence requests).`,
	);

	let activePack = plannerPass1.pack;
	let plannerIterations = plannerPass1.iterations;
	let criticDecision = criticPass1.decision;
	const additionalRequests = criticPass1.decision.requestedEvidence ?? [];
	if (additionalRequests.length) {
		log(`Planner pass 2 starting for critic requests: ${additionalRequests.join(' | ')}`);
		const plannerPass2 = await runContextPlanner({
			inputs,
			seedGaps: additionalRequests,
			maxRounds: PLANNER_MAX_ROUNDS_SECONDARY,
			previousPack: activePack,
		});
		activePack = mergeEvidencePacks(activePack, plannerPass2.pack);
		plannerIterations += plannerPass2.iterations;
		log(
			`Planner pass 2 done: ${plannerPass2.pack.items.length} new item(s), total ${activePack.items.length}.`,
		);
		const criticPass2 = await runCritic({
			inputs,
			evidencePack: activePack,
			deciderDecision: deciderRun.decision,
			previousCritic: criticPass1.decision,
		});
		criticDecision = criticPass2.decision;
		log(
			`Critic pass 2: ${criticDecision.selectedStrategy} (confidence ${criticDecision.confidence ?? 'n/a'}).`,
		);
	}

	const arbiterRun = await runArbiter({
		inputs,
		evidencePack: activePack,
		deciderDecision: deciderRun.decision,
		criticDecision,
	});
	log(
		`Arbiter: ${arbiterRun.result.selectedStrategy} (confidence ${arbiterRun.result.confidence ?? 'n/a'}).`,
	);
	const sanitizedReply = stripFishingQuestions(arbiterRun.result.reply);
	if (sanitizedReply !== arbiterRun.result.reply) {
		log('Arbiter: stripped trailing clarification questions from reply to keep it sendable.');
		arbiterRun.result.reply = sanitizedReply;
	}

	const tokenUsage = mergeTokenUsage([
		plannerPass1.tokenUsage,
		deciderRun.tokenUsage,
		criticPass1.tokenUsage,
		criticDecision === criticPass1.decision ? emptyTokenUsage() : (criticPass1.tokenUsage ?? emptyTokenUsage()),
		arbiterRun.tokenUsage,
	]);

	return {
		decision: arbiterRun.result,
		deciderDecision: deciderRun.decision,
		criticDecision,
		evidencePack: activePack,
		tokenUsage,
		plannerIterations,
	};
}

type PlannerPassResult = {
	pack: EvidencePack;
	iterations: number;
	tokenUsage: TokenUsageSummary;
};

async function runContextPlanner(params: {
	inputs: PipelineInputs;
	seedGaps: string[];
	maxRounds: number;
	previousPack?: EvidencePack;
}): Promise<PlannerPassResult> {
	const { inputs, seedGaps, maxRounds, previousPack } = params;
	const newItems: EvidenceItem[] = [];
	const toolCalls: ToolCallRecord[] = [];
	const gaps: string[] = [];
	const usages: TokenUsageSummary[] = [];
	let nextEvidenceIndex = (previousPack?.items.length ?? 0) + 1;
	const seenSignatures = new Set<string>(
		(previousPack?.items ?? []).map((item) => `${item.kind}:${item.source}`),
	);
	let priorPlannerThought = '';

	for (let round = 0; round < maxRounds; round += 1) {
		inputs.logger?.(`Planner round ${round + 1}/${maxRounds}: thinking about what to inspect next…`);
		const prompt = buildPlannerPrompt({
			inputs,
			seedGaps,
			previousPack,
			collectedSoFar: newItems,
			toolCallHistory: toolCalls,
			priorPlannerThought,
			roundNumber: round + 1,
			maxRounds,
		});
		const messages = [vscode.LanguageModelChatMessage.User(prompt)];
		const { text, tokenUsage } = await collectResponseWithUsage(inputs.model, messages);
		usages.push(tokenUsage);
		const parsed = parsePlannerResponse(text);
		priorPlannerThought = parsed.thought ?? priorPlannerThought;

		if (parsed.done) {
			gaps.push(...parsed.gaps);
			inputs.logger?.(`Planner round ${round + 1}: planner finished collecting evidence.`);
			break;
		}

		if (!parsed.toolCalls.length) {
			gaps.push(...parsed.gaps);
			break;
		}

		inputs.logger?.(
			`Planner round ${round + 1}: calling ${parsed.toolCalls.map((c) => c.name).join(', ')}…`,
		);
		for (const call of parsed.toolCalls) {
			const tool = inputs.tools.find((entry) => entry.name === call.name);
			if (!tool) {
				toolCalls.push({
					tool: call.name,
					args: call.args,
					ok: false,
					note: 'unknown tool',
				});
				continue;
			}

			inputs.logger?.(`Tool: ${tool.name}(${describeSource(tool.name, call.args)})`);
			let result: ToolResult;
			try {
				result = await tool.handler(call.args);
			} catch (error) {
				toolCalls.push({
					tool: call.name,
					args: call.args,
					ok: false,
					note: error instanceof Error ? error.message : 'tool error',
				});
				continue;
			}

			if (!result || !result.content?.trim()) {
				toolCalls.push({
					tool: call.name,
					args: call.args,
					ok: false,
					note: 'empty result',
				});
				continue;
			}

			const signature = `${tool.name}:${stableStringify(call.args)}`;
			if (seenSignatures.has(signature)) {
				toolCalls.push({
					tool: call.name,
					args: call.args,
					ok: true,
					note: 'duplicate skipped',
				});
				continue;
			}
			seenSignatures.add(signature);

			const id = `E${nextEvidenceIndex}`;
			nextEvidenceIndex += 1;
			const kind = inferEvidenceKind(tool.name);
			const trimmed = truncate(result.content, MAX_EVIDENCE_CONTENT_CHARS, '[evidence truncated]');
			newItems.push({
				id,
				kind,
				source: describeSource(tool.name, call.args),
				summary: result.summary || `${tool.name} ${describeSource(tool.name, call.args)}`,
				content: trimmed,
			});
			toolCalls.push({
				tool: call.name,
				args: call.args,
				ok: true,
				note: id,
			});

			if (newItems.length + (previousPack?.items.length ?? 0) >= MAX_EVIDENCE_ITEMS) {
				break;
			}
		}

		if (newItems.length + (previousPack?.items.length ?? 0) >= MAX_EVIDENCE_ITEMS) {
			gaps.push('Evidence cap reached; stopped early.');
			break;
		}
	}

	return {
		pack: {
			items: newItems,
			gaps,
			toolCalls,
		},
		iterations: usages.length,
		tokenUsage: mergeTokenUsage(usages),
	};
}

function buildPlannerPrompt(params: {
	inputs: PipelineInputs;
	seedGaps: string[];
	previousPack?: EvidencePack;
	collectedSoFar: EvidenceItem[];
	toolCallHistory: ToolCallRecord[];
	priorPlannerThought: string;
	roundNumber: number;
	maxRounds: number;
}): string {
	const { inputs, seedGaps, previousPack, collectedSoFar, toolCallHistory } = params;
	const toolCatalog = params.inputs.tools.map((tool) => {
		const argSummary = Object.entries(tool.args)
			.map(([name, type]) => `${name}: ${type}`)
			.join(', ');
		return `- ${tool.name}(${argSummary}) — ${tool.description}`;
	}).join('\n');

	const sections: string[] = [
		'You are ContextPlanner — the only agent allowed to inspect the codebase.',
		'Goal: gather concrete, citable evidence so downstream agents can decide whether the PR comment is correct or wrong.',
		'Strategy: think about what evidence would prove or disprove the reviewer claim. Then call tools to fetch it.',
		'Rules:',
		'- Always reason about what is missing before calling tools.',
		'- Locate the anchor first. If the seed evidence does not include the exact code being commented on, your highest priority is to find it: search the candidate anchor lines, read those line ranges, and confirm which section the reviewer is referring to. Do not gather broad context until the anchor is identified.',
		'- Verify the call chain. If the reviewer names other functions or line numbers (e.g. "X delegates to Y at line N"), you must inspect those targets before deciding. Pre-seeded items labelled "referenced: ..." cover the named symbols — if any named function still lacks evidence for its body, fetch it.',
		'- Before stopping, confirm: every function name and line number cited in the comment has at least one piece of evidence in the pack covering its actual body.',
		'- If the anchor cannot be confidently identified, record that in `gaps` — do NOT guess. Downstream agents will default to clarify.',
		'- Prefer cheap tools (read_file_range, git_diff, grep_workspace) before deep ones.',
		'- Stop calling tools once you have enough to answer with confidence — output {"done": true}.',
		'- Never invent file contents. Only rely on tool outputs.',
		`- You have at most ${params.maxRounds} planning rounds. This is round ${params.roundNumber}.`,
		'',
		'Available tools:',
		toolCatalog,
		'',
		'Output JSON only (no markdown fences). One of two shapes:',
		'1) Continue: {"thought": "...", "toolCalls": [{"name": "tool", "args": {...}, "reason": "..."}]}',
		'2) Stop: {"thought": "...", "done": true, "gaps": ["unanswered question", ...]}',
		'You may call up to 3 tools per round. Avoid duplicate calls.',
		'',
		`PR comment:\n${inputs.commentText}`,
	];

	if (inputs.commentLocationHint) {
		sections.push('', `Comment is anchored at: ${inputs.commentLocationHint}`);
	}

	if (inputs.commentAuthor) {
		sections.push('', `Comment author: ${inputs.commentAuthor}`);
	}
	if (inputs.additionalInstructions.trim()) {
		sections.push('', `Author of the PR added guidance:\n${inputs.additionalInstructions.trim()}`);
	}
	if (inputs.threadContext) {
		sections.push('', `Thread conversation:\n${inputs.threadContext}`);
	}
	if (seedGaps.length) {
		sections.push('', `Critic asked for additional evidence on:\n${seedGaps.map((q) => `- ${q}`).join('\n')}`);
	}
	if (previousPack?.items.length) {
		sections.push('', 'Evidence already collected (do not re-fetch):');
		sections.push(renderEvidencePackForPlanner(previousPack));
	}
	if (collectedSoFar.length) {
		sections.push('', 'Evidence collected this pass:');
		sections.push(renderEvidenceList(collectedSoFar));
	}
	if (toolCallHistory.length) {
		const recent = toolCallHistory.slice(-8);
		sections.push('', 'Recent tool calls:');
		sections.push(
			recent
				.map((call) => `- ${call.tool}(${stableStringify(call.args)}) -> ${call.ok ? 'ok' : 'fail'}${call.note ? ` (${call.note})` : ''}`)
				.join('\n'),
		);
	}
	if (params.priorPlannerThought) {
		sections.push('', `Your previous thought:\n${params.priorPlannerThought}`);
	}

	return sections.join('\n');
}

type PlannerParseResult = {
	thought?: string;
	done: boolean;
	gaps: string[];
	toolCalls: { name: string; args: Record<string, unknown>; reason?: string }[];
};

function parsePlannerResponse(raw: string): PlannerParseResult {
	const cleaned = stripMarkdownCodeFence(raw.trim());
	const fallback: PlannerParseResult = { done: true, gaps: [], toolCalls: [] };
	if (!cleaned) {
		return fallback;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(cleaned);
	} catch {
		const recovered = extractJsonObject(cleaned);
		if (!recovered) {
			return fallback;
		}
		try {
			parsed = JSON.parse(recovered);
		} catch {
			return fallback;
		}
	}

	if (!parsed || typeof parsed !== 'object') {
		return fallback;
	}

	const obj = parsed as {
		thought?: unknown;
		done?: unknown;
		gaps?: unknown;
		toolCalls?: unknown;
	};

	const result: PlannerParseResult = {
		thought: typeof obj.thought === 'string' ? obj.thought.trim() : undefined,
		done: obj.done === true,
		gaps: Array.isArray(obj.gaps)
			? obj.gaps.filter((g): g is string => typeof g === 'string').map((g) => g.trim()).filter(Boolean)
			: [],
		toolCalls: [],
	};

	if (Array.isArray(obj.toolCalls)) {
		for (const entry of obj.toolCalls) {
			if (!entry || typeof entry !== 'object') {
				continue;
			}
			const call = entry as { name?: unknown; args?: unknown; reason?: unknown };
			if (typeof call.name !== 'string' || !call.name.trim()) {
				continue;
			}
			const args = call.args && typeof call.args === 'object' && !Array.isArray(call.args)
				? (call.args as Record<string, unknown>)
				: {};
			result.toolCalls.push({
				name: call.name.trim(),
				args,
				reason: typeof call.reason === 'string' ? call.reason : undefined,
			});
		}
	}

	if (!result.toolCalls.length && !result.done) {
		result.done = true;
	}

	return result;
}

type DeciderRun = {
	decision: AgentDecision;
	tokenUsage: TokenUsageSummary;
};

async function runDecider(params: {
	inputs: PipelineInputs;
	evidencePack: EvidencePack;
}): Promise<DeciderRun> {
	const prompt = buildDeciderPrompt(params);
	const messages = [vscode.LanguageModelChatMessage.User(prompt)];
	const { text, tokenUsage } = await collectResponseWithUsage(params.inputs.model, messages);
	const decision = parseAgentDecision(text);
	return { decision, tokenUsage };
}

function buildDeciderPrompt(params: {
	inputs: PipelineInputs;
	evidencePack: EvidencePack;
}): string {
	const { inputs, evidencePack } = params;
	const sections: string[] = [
		'You are Decider — judge whether the PR comment is correct.',
		inputs.strategyInstruction,
		'Reason ONLY from the supplied evidence. Cite evidence ids like [E1] in every rationale bullet.',
		'Strongly prefer agree or pushback. Clarify is a last resort, only used when the reviewer\'s intent itself is ambiguous (not when you simply want one more evidence item). Default to agree when the evidence supports the reviewer\'s factual claim.',
		'Anchor rule: only fall back to clarify when the anchor line is truly unknown AND no candidate in the evidence pack matches the reviewer\'s claim. If candidate evidence partially matches, prefer agree-with-best-interpretation.',
		'Call-chain rule: when the reviewer names other functions or line numbers (e.g. "createOrder delegates to createOrderNewVersion at line 1972"), look for evidence items labeled "(referenced: X)" or covering the cited line numbers. If those items confirm the chain — even partially — agree. Missing one peripheral body is NOT a reason to clarify.',
		'Do not flag "extra" issues that the reviewer did not raise. Stay scoped to the reviewer claim.',
		'Do not be overly cautious. If the evidence clearly supports the reviewer\'s claim, agree with high confidence — do not ask for clarification just because you want a tighter proof.',
		'Choose strategy:',
		'- agree: reviewer claim is supported by evidence.',
		'- pushback: evidence shows reviewer is wrong, would regress behavior, or breaks an invariant.',
		'- clarify: evidence is missing or ambiguous; one focused question would unblock the decision.',
		'Output strict JSON only (no markdown fences):',
		'{"selectedStrategy": "agree|pushback|clarify", "confidence": 0..1, "rationale": ["...[E#]"], "citations": ["E1", ...]}',
		'',
		`PR comment:\n${inputs.commentText}`,
	];
	if (inputs.commentAuthor) {
		sections.push('', `Comment author: ${inputs.commentAuthor}`);
	}
	if (inputs.additionalInstructions.trim()) {
		sections.push('', `PR author guidance:\n${inputs.additionalInstructions.trim()}`);
	}
	if (inputs.threadContext) {
		sections.push('', `Thread conversation:\n${inputs.threadContext}`);
	}
	sections.push('', 'Evidence pack:');
	sections.push(renderEvidencePack(evidencePack));
	return sections.join('\n');
}

type CriticRun = {
	decision: AgentDecision;
	tokenUsage: TokenUsageSummary;
};

async function runCritic(params: {
	inputs: PipelineInputs;
	evidencePack: EvidencePack;
	deciderDecision: AgentDecision;
	previousCritic?: AgentDecision;
}): Promise<CriticRun> {
	const prompt = buildCriticPrompt(params);
	const messages = [vscode.LanguageModelChatMessage.User(prompt)];
	const { text, tokenUsage } = await collectResponseWithUsage(params.inputs.model, messages);
	const decision = parseAgentDecision(text, true);
	return { decision, tokenUsage };
}

function buildCriticPrompt(params: {
	inputs: PipelineInputs;
	evidencePack: EvidencePack;
	deciderDecision: AgentDecision;
	previousCritic?: AgentDecision;
}): string {
	const { inputs, evidencePack, deciderDecision, previousCritic } = params;
	const sections: string[] = [
		'You are Critic — adversarial reviewer of the Decider.',
		'Job: try to break the Decider verdict. Look for missing evidence, wrong inferences, or unconsidered code paths.',
		'Prefer correctness over politeness. If Decider over-agreed without proof, push back. If Decider over-pushed-back without proof, push the other way.',
		'Anchor rule: clarify is appropriate only when the anchor line is genuinely unknown and no candidate evidence matches. If anchor is verified or partial evidence matches, push the Decider toward agree or pushback.',
		'Call-chain rule: if the Decider chose clarify while the evidence pack contains the chain the reviewer named (even if a peripheral body is partial), flag this as over-cautious and push the verdict to agree.',
		'Sendable-reply rule: the final reply must not ask the reviewer for more info, lines, or confirmation. If you spot the Decider doing this, flag it as a failure mode and override toward a confident statement.',
		'Do not invent extra bugs or "while you\'re at it" issues that the reviewer did not raise. Stay scoped to the reviewer claim.',
		'Vue/template caveat: in Vue templates, `ref` values are auto-unwrapped, so `someRef === value` inside templates is valid. Do not flag this as a bug.',
		'You may either accept (with reservations), counter, or escalate to clarify.',
		'You may request more evidence: list concrete questions the planner should answer.',
		'Output strict JSON only (no markdown fences):',
		'{"selectedStrategy": "agree|pushback|clarify", "confidence": 0..1, "rationale": ["...[E#]"], "citations": ["E1"], "requestedEvidence": ["question", ...], "dissent": "what Decider got wrong"}',
		'requestedEvidence may be empty. Cite evidence in rationale wherever possible.',
		'',
		`PR comment:\n${inputs.commentText}`,
	];
	if (inputs.commentAuthor) {
		sections.push('', `Comment author: ${inputs.commentAuthor}`);
	}
	if (inputs.additionalInstructions.trim()) {
		sections.push('', `PR author guidance:\n${inputs.additionalInstructions.trim()}`);
	}
	if (inputs.threadContext) {
		sections.push('', `Thread conversation:\n${inputs.threadContext}`);
	}
	sections.push('', 'Decider verdict:');
	sections.push(formatDecisionForPrompt(deciderDecision));
	if (previousCritic) {
		sections.push('', 'Your previous critique (now refine with new evidence):');
		sections.push(formatDecisionForPrompt(previousCritic));
	}
	sections.push('', 'Evidence pack:');
	sections.push(renderEvidencePack(evidencePack));
	return sections.join('\n');
}

type ArbiterRun = {
	result: ArbiterResult;
	tokenUsage: TokenUsageSummary;
};

async function runArbiter(params: {
	inputs: PipelineInputs;
	evidencePack: EvidencePack;
	deciderDecision: AgentDecision;
	criticDecision: AgentDecision;
}): Promise<ArbiterRun> {
	const prompt = buildArbiterPrompt(params);
	const messages = [vscode.LanguageModelChatMessage.User(prompt)];
	const { text, tokenUsage } = await collectResponseWithUsage(params.inputs.model, messages);
	const result = parseArbiterResponse(text);
	return { result, tokenUsage };
}

function buildArbiterPrompt(params: {
	inputs: PipelineInputs;
	evidencePack: EvidencePack;
	deciderDecision: AgentDecision;
	criticDecision: AgentDecision;
}): string {
	const { inputs, evidencePack, deciderDecision, criticDecision } = params;
	const sections: string[] = [
		'You are Arbiter — produce the final PR reply.',
		'Inputs: comment, curated evidence pack, Decider verdict, Critic challenge.',
		'Your job: weigh the Decider and Critic, pick the strategy that the EVIDENCE most strongly supports, and write the reply.',
		'Selection rules:',
		'- Strongly prefer agree or pushback. Clarify is a last resort, only when the reviewer\'s intent itself is genuinely ambiguous (not when YOU lack one extra piece of evidence). Do not punt to clarify to avoid committing.',
		'- If Decider and Critic agree, follow them with high confidence.',
		'- If they disagree, side with whichever cites more concrete evidence ids that actually appear in the pack.',
		'- If the evidence pack does not contain the exact anchored code (anchor line unknown or unverified), still avoid asking the reviewer to point at lines — instead, take a best-effort position based on what is visible (typically agree-with-acknowledgment).',
		'- If the evidence pack clearly contains the call chain or claim the reviewer described (every named function and line has a covering evidence item, even if some sub-function bodies are partial), pick agree and confirm. Do NOT downgrade to clarify because one peripheral function body is incomplete.',
		'- Do NOT add unrelated bugs or refactors the reviewer did not raise. Stay scoped to the reviewer claim.',
		'- Vue/template caveat: in Vue templates `ref` is auto-unwrapped, so `someRef === x` is valid in templates. Never flag this as a bug.',
		'- Never invent code that is not in the evidence pack.',
		inputs.tonePreset.styleGuidance,
		buildPersonalToneGuidance(inputs.personalToneExamples),
		'Reply rules:',
		'- The reply must be READY TO SEND AS-IS. Treat it like the final PR comment, not a draft note to yourself.',
		'- Do NOT ask the reviewer for more info, more lines, more context, or for confirmation. No questions of any kind. The reply must contain zero question marks.',
		'- Forbidden phrasings: "Could you", "Can you", "Please confirm", "Let me know if", "point me to", "point us to", "I want to make sure", "I\'d like to confirm".',
		'- Do not narrate uncertainty ("I think", "it seems", "if I\'m reading this right"). State the conclusion as a fact grounded in the cited evidence.',
		`- Write the reply in ${(inputs.language ?? 'English').trim() || 'English'}. Code identifiers, file paths, and verbatim quotes from the codebase stay as-is; only the prose is translated.`,
		'- One concise message, no greetings, no signatures. Markdown allowed.',
		'',
		'Output strict JSON only (no markdown fences):',
		'{',
		'  "selectedStrategy": "agree|pushback|clarify",',
		'  "confidence": 0..1,',
		'  "rationale": ["short bullet citing [E#]", ...],',
		'  "citations": ["E1", "E3"],',
		'  "criticAgreement": "aligned|split",',
		'  "reply": "the actual reply text"',
		'}',
		'',
		`PR comment:\n${inputs.commentText}`,
	];
	if (inputs.commentAuthor) {
		sections.push('', `Comment author: ${inputs.commentAuthor}`);
	}
	if (inputs.additionalInstructions.trim()) {
		sections.push('', `PR author guidance:\n${inputs.additionalInstructions.trim()}`);
	}
	if (inputs.threadContext) {
		sections.push('', `Thread conversation:\n${inputs.threadContext}`);
	}
	sections.push('', 'Decider verdict:');
	sections.push(formatDecisionForPrompt(deciderDecision));
	sections.push('', 'Critic challenge:');
	sections.push(formatDecisionForPrompt(criticDecision));
	sections.push('', 'Evidence pack:');
	sections.push(renderEvidencePack(evidencePack));
	return sections.join('\n');
}

function buildPersonalToneGuidance(examples?: string): string {
	const trimmed = examples?.trim();
	if (!trimmed) {
		return 'No personal tone examples were provided.';
	}
	return [
		'Personal tone examples from the PR author are provided for style guidance only.',
		'Mirror the level of directness, warmth, and phrasing rhythm, but do not copy private details, names, exact sentences, or distinctive phrases unnecessarily.',
		`Examples:\n${truncate(trimmed, 1_800, '[Personal tone examples truncated]')}`,
	].join('\n');
}

function parseAgentDecision(raw: string, allowExtra = false): AgentDecision {
	const cleaned = stripMarkdownCodeFence(raw.trim());
	const fallback: AgentDecision = {
		selectedStrategy: 'unknown',
		rationale: [],
		citations: [],
	};
	if (!cleaned) {
		return fallback;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(cleaned);
	} catch {
		const recovered = extractJsonObject(cleaned);
		if (!recovered) {
			return fallback;
		}
		try {
			parsed = JSON.parse(recovered);
		} catch {
			return fallback;
		}
	}

	if (!parsed || typeof parsed !== 'object') {
		return fallback;
	}

	const obj = parsed as {
		selectedStrategy?: unknown;
		confidence?: unknown;
		rationale?: unknown;
		citations?: unknown;
		requestedEvidence?: unknown;
		dissent?: unknown;
	};

	const decision: AgentDecision = {
		selectedStrategy: normalizeStrategy(obj.selectedStrategy),
		confidence: normalizeConfidence(obj.confidence),
		rationale: normalizeStringArray(obj.rationale, 4),
		citations: normalizeStringArray(obj.citations, 8),
	};
	if (allowExtra) {
		decision.requestedEvidence = normalizeStringArray(obj.requestedEvidence, 5);
		if (typeof obj.dissent === 'string' && obj.dissent.trim()) {
			decision.dissent = obj.dissent.trim();
		}
	}
	return decision;
}

function parseArbiterResponse(raw: string): ArbiterResult {
	const cleaned = stripMarkdownCodeFence(raw.trim());
	const fallback: ArbiterResult = {
		selectedStrategy: 'unknown',
		rationale: [],
		citations: [],
		reply: '',
		criticAgreement: 'unknown',
	};
	if (!cleaned) {
		return fallback;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(cleaned);
	} catch {
		const recovered = extractJsonObject(cleaned);
		if (!recovered) {
			return fallback;
		}
		try {
			parsed = JSON.parse(recovered);
		} catch {
			return fallback;
		}
	}

	if (!parsed || typeof parsed !== 'object') {
		return fallback;
	}

	const obj = parsed as {
		selectedStrategy?: unknown;
		confidence?: unknown;
		rationale?: unknown;
		citations?: unknown;
		criticAgreement?: unknown;
		reply?: unknown;
	};

	let agreement: ArbiterResult['criticAgreement'] = 'unknown';
	if (typeof obj.criticAgreement === 'string') {
		const lower = obj.criticAgreement.toLowerCase();
		if (lower.startsWith('align')) {
			agreement = 'aligned';
		} else if (lower.startsWith('split') || lower.startsWith('disagree')) {
			agreement = 'split';
		}
	}

	return {
		selectedStrategy: normalizeStrategy(obj.selectedStrategy),
		confidence: normalizeConfidence(obj.confidence),
		rationale: normalizeStringArray(obj.rationale, 4),
		citations: normalizeStringArray(obj.citations, 8),
		reply: typeof obj.reply === 'string' ? obj.reply.trim() : '',
		criticAgreement: agreement,
	};
}

function formatDecisionForPrompt(decision: AgentDecision): string {
	const lines: string[] = [
		`Strategy: ${decision.selectedStrategy}`,
		`Confidence: ${decision.confidence ?? 'n/a'}`,
		`Citations: ${decision.citations.length ? decision.citations.join(', ') : 'none'}`,
		'Rationale:',
	];
	if (decision.rationale.length) {
		for (const item of decision.rationale) {
			lines.push(`- ${item}`);
		}
	} else {
		lines.push('- (none provided)');
	}
	if (decision.requestedEvidence?.length) {
		lines.push('Requested evidence:');
		for (const q of decision.requestedEvidence) {
			lines.push(`- ${q}`);
		}
	}
	if (decision.dissent) {
		lines.push(`Dissent: ${decision.dissent}`);
	}
	return lines.join('\n');
}

function renderEvidencePack(pack: EvidencePack): string {
	if (!pack.items.length) {
		return '(no evidence collected)';
	}
	const blocks = pack.items.map((item) => {
		return [
			`[${item.id}] (${item.kind}) ${item.source}`,
			`Summary: ${item.summary}`,
			'Content:',
			item.content,
		].join('\n');
	});
	const joined = blocks.join('\n\n---\n\n');
	const truncated = truncate(joined, MAX_PACK_RENDERED_CHARS, '[evidence pack truncated]');
	const tail: string[] = [truncated];
	if (pack.gaps.length) {
		tail.push('', 'Open gaps:');
		for (const gap of pack.gaps) {
			tail.push(`- ${gap}`);
		}
	}
	return tail.join('\n');
}

function renderEvidencePackForPlanner(pack: EvidencePack): string {
	return pack.items
		.map((item) => `[${item.id}] (${item.kind}) ${item.source} — ${item.summary}`)
		.join('\n');
}

function renderEvidenceList(items: EvidenceItem[]): string {
	return items
		.map((item) => `[${item.id}] (${item.kind}) ${item.source} — ${item.summary}`)
		.join('\n');
}

function mergeEvidencePacks(a: EvidencePack, b: EvidencePack): EvidencePack {
	return {
		items: [...a.items, ...b.items],
		gaps: [...a.gaps, ...b.gaps],
		toolCalls: [...a.toolCalls, ...b.toolCalls],
	};
}

function inferEvidenceKind(toolName: string): EvidenceKind {
	const lower = toolName.toLowerCase();
	if (lower.includes('diff')) {
		return 'diff';
	}
	if (lower.includes('reference') || lower.includes('refs')) {
		return 'reference';
	}
	if (lower.includes('symbol')) {
		return 'symbol-evidence';
	}
	if (lower.includes('thread')) {
		return 'thread';
	}
	if (lower.includes('description')) {
		return 'note';
	}
	if (lower.includes('web') || lower.includes('search')) {
		return 'web';
	}
	if (lower.includes('log') || lower.includes('commit')) {
		return 'commits';
	}
	return 'code';
}

function describeSource(toolName: string, args: Record<string, unknown>): string {
	const keys = Object.keys(args);
	if (!keys.length) {
		return toolName;
	}
	const parts = keys.map((key) => `${key}=${formatArgValue(args[key])}`);
	return `${toolName}(${parts.join(', ')})`;
}

function formatArgValue(value: unknown): string {
	if (value === null || value === undefined) {
		return '';
	}
	if (typeof value === 'string') {
		return value.length > 60 ? `${value.slice(0, 60)}...` : value;
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(',')}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

function stripMarkdownCodeFence(text: string): string {
	if (!text.startsWith('```')) {
		return text;
	}
	return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function extractJsonObject(text: string): string | undefined {
	const start = text.indexOf('{');
	if (start < 0) {
		return undefined;
	}
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = start; i < text.length; i += 1) {
		const ch = text[i];
		if (escape) {
			escape = false;
			continue;
		}
		if (inString) {
			if (ch === '\\') {
				escape = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === '{') {
			depth += 1;
		} else if (ch === '}') {
			depth -= 1;
			if (depth === 0) {
				return text.slice(start, i + 1);
			}
		}
	}
	return undefined;
}

function normalizeStrategy(value: unknown): DraftMode | 'unknown' {
	if (typeof value !== 'string') {
		return 'unknown';
	}
	const lower = value.toLowerCase().trim();
	if (lower.startsWith('agree')) {
		return 'agree';
	}
	if (lower.startsWith('push')) {
		return 'pushback';
	}
	if (lower.startsWith('clarif')) {
		return 'clarify';
	}
	return 'unknown';
}

function normalizeConfidence(value: unknown): number | undefined {
	if (typeof value !== 'number' || Number.isNaN(value)) {
		return undefined;
	}
	return Math.max(0, Math.min(1, value));
}

function normalizeStringArray(value: unknown, max: number): string[] {
	if (typeof value === 'string' && value.trim()) {
		return [value.trim()].slice(0, max);
	}
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.filter((item): item is string => typeof item === 'string')
		.map((item) => item.trim())
		.filter((item) => Boolean(item))
		.slice(0, max);
}

function truncate(text: string, max: number, suffix: string): string {
	if (text.length <= max) {
		return text;
	}
	return `${text.slice(0, max)}\n${suffix}`;
}

function stripFishingQuestions(reply: string): string {
	const trimmed = reply.trim();
	if (!trimmed) {
		return trimmed;
	}
	const fishingStart = /^(could|can|please|let me know|may i|might i|would you|do you|are you|is there|point me|point us|i want to make sure|i'd like to confirm|happy to revisit if)\b/i;
	const paragraphs = trimmed.split(/\n\s*\n/);
	while (paragraphs.length) {
		const last = paragraphs[paragraphs.length - 1].trim();
		if (!last) {
			paragraphs.pop();
			continue;
		}
		const sentences = last.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
		while (sentences.length) {
			const lastSentence = sentences[sentences.length - 1];
			const isQuestion = lastSentence.endsWith('?');
			const isFishing = fishingStart.test(lastSentence);
			if (isQuestion || isFishing) {
				sentences.pop();
				continue;
			}
			break;
		}
		const remainder = sentences.join(' ').trim();
		if (!remainder) {
			paragraphs.pop();
			continue;
		}
		paragraphs[paragraphs.length - 1] = remainder;
		break;
	}
	const cleaned = paragraphs.join('\n\n').trim();
	if (!cleaned) {
		return 'Acknowledged — the visible chain in the evidence supports this; no changes needed on my end.';
	}
	return cleaned;
}

function emptyTokenUsage(): TokenUsageSummary {
	return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function mergeTokenUsage(usages: TokenUsageSummary[]): TokenUsageSummary {
	return usages.reduce<TokenUsageSummary>(
		(acc, usage) => ({
			promptTokens: acc.promptTokens + usage.promptTokens,
			completionTokens: acc.completionTokens + usage.completionTokens,
			totalTokens: acc.totalTokens + usage.totalTokens,
		}),
		emptyTokenUsage(),
	);
}

async function collectResponseWithUsage(
	model: vscode.LanguageModelChat,
	messages: vscode.LanguageModelChatMessage[],
): Promise<{ text: string; tokenUsage: TokenUsageSummary }> {
	const response = await model.sendRequest(messages, {});
	let text = '';
	for await (const chunk of response.text) {
		text += toText(chunk);
	}
	const promptCounts = await Promise.all(
		messages.map((message) => countTokensBestEffort(model, message)),
	);
	const promptTokens = promptCounts.reduce((sum, n) => sum + n, 0);
	const completionTokens = await countTokensBestEffort(model, text);
	return {
		text,
		tokenUsage: {
			promptTokens,
			completionTokens,
			totalTokens: promptTokens + completionTokens,
		},
	};
}

async function countTokensBestEffort(
	model: vscode.LanguageModelChat,
	input: string | vscode.LanguageModelChatMessage,
): Promise<number> {
	try {
		const exact = await model.countTokens(input);
		if (Number.isFinite(exact) && exact > 0) {
			return exact;
		}
	} catch {
		// fall through
	}
	const text = typeof input === 'string' ? input : '';
	if (!text.trim()) {
		return 0;
	}
	return Math.max(1, Math.ceil(text.length / 4));
}

function toText(chunk: unknown): string {
	if (typeof chunk === 'string') {
		return chunk;
	}
	if (chunk && typeof chunk === 'object' && 'value' in chunk) {
		const value = (chunk as { value?: unknown }).value;
		return typeof value === 'string' ? value : '';
	}
	return '';
}
