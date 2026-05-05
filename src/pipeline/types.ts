import { ArbiterResult } from '../agents';
import { TokenUsageSummary } from '../llmClient';
import { DraftMode } from '../presets';

export type AutoDecisionResult = {
	selectedStrategy: DraftMode | 'unknown';
	confidence?: number;
	rationale: string[];
	reply: string;
	tokenUsage: TokenUsageSummary;
	pipelineDetails?: PipelineDetailSummary;
};

export type PipelineDetailSummary = {
	deciderStrategy: DraftMode | 'unknown';
	deciderConfidence?: number;
	criticStrategy: DraftMode | 'unknown';
	criticConfidence?: number;
	criticAgreement: ArbiterResult['criticAgreement'];
	criticDissent?: string;
	citations: string[];
	evidenceCount: number;
	plannerIterations: number;
	gaps: string[];
	anchorVerified: boolean;
	anchorOverrideApplied: boolean;
};
