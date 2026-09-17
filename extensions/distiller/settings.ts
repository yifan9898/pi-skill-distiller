import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DistillSettings } from "./types.ts";

export const DEFAULT_SETTINGS: DistillSettings = {
	enabled: true,
	autoDistill: true,
	minToolResults: 8,
	minTranscriptBytes: 30 * 1024,
	injectMaintenancePrompt: true,
	feedbackMinSkills: 15,
	staleAfterDays: 90,
};

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

export async function loadSettings(cwd: string): Promise<DistillSettings> {
	const filePath = join(cwd, ".pi", "pi-skill-distiller-settings.json");
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_SETTINGS };
		throw new Error(`Cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}

	const thinkingLevel = optionalString(parsed.thinkingLevel);
	return {
		enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_SETTINGS.enabled,
		autoDistill: typeof parsed.autoDistill === "boolean" ? parsed.autoDistill : DEFAULT_SETTINGS.autoDistill,
		minToolResults: positiveInteger(parsed.minToolResults, DEFAULT_SETTINGS.minToolResults),
		minTranscriptBytes: positiveInteger(parsed.minTranscriptBytes, DEFAULT_SETTINGS.minTranscriptBytes),
		reviewerProvider: optionalString(parsed.reviewerProvider),
		reviewerModel: optionalString(parsed.reviewerModel),
		thinkingLevel: thinkingLevel && THINKING_LEVELS.has(thinkingLevel)
			? thinkingLevel as DistillSettings["thinkingLevel"]
			: undefined,
		injectMaintenancePrompt: typeof parsed.injectMaintenancePrompt === "boolean"
			? parsed.injectMaintenancePrompt
			: DEFAULT_SETTINGS.injectMaintenancePrompt,
		feedbackMinSkills: positiveInteger(parsed.feedbackMinSkills, DEFAULT_SETTINGS.feedbackMinSkills),
		staleAfterDays: positiveInteger(parsed.staleAfterDays, DEFAULT_SETTINGS.staleAfterDays),
	};
}
