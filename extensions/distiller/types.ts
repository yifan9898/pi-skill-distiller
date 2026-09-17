import type { Skill } from "@earendil-works/pi-coding-agent";

export const WATERMARK_ENTRY = "skill-distiller-watermark";

export type DistillTrigger = "agent_settled" | "session_before_compact" | "/distill" | "/distill-feedback";

export interface DistillWatermark {
	entryId: string | null;
	trigger: DistillTrigger;
	createdAt: string;
}

export interface DistillSettings {
	enabled: boolean;
	autoDistill: boolean;
	minToolResults: number;
	minTranscriptBytes: number;
	reviewerProvider?: string;
	reviewerModel?: string;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	injectMaintenancePrompt: boolean;
	feedbackMinSkills: number;
	staleAfterDays: number;
}

export interface TranscriptStats {
	toolResults: number;
	userMessages: number;
	assistantMessages: number;
	serializedBytes: number;
}

export interface TranscriptSlice {
	text: string;
	stats: TranscriptStats;
	lastEntryId: string | null;
}

export interface ReviewerSkill {
	name: string;
	description: string;
	filePath: string;
}

export interface ReviewerResult {
	changedFiles: string[];
	summary: string;
}

export interface DistillCandidate {
	name: string;
	filePath: string;
	content: string;
	description: string;
}

export interface CandidateMetadata {
	trigger: DistillTrigger;
	summary: string;
	sessionId: string;
	createdAt: string;
}

export interface StagingMetadata {
	version: 1;
	candidates: Record<string, CandidateMetadata>;
}

export interface UsageRecord {
	name: string;
	filePath: string;
	readCount: number;
	lastReadAt: string;
	lastSessionId: string;
}

export interface UsageDatabase {
	version: 1;
	skills: Record<string, UsageRecord>;
}

export function reviewerSkills(skills: readonly Skill[]): ReviewerSkill[] {
	return skills.map((skill) => ({ name: skill.name, description: skill.description, filePath: skill.filePath }));
}
