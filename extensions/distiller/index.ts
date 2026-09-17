import { resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
	Skill,
} from "@earendil-works/pi-coding-agent";
import { withDistillLock } from "./lock.ts";
import { MAINTENANCE_PROMPT } from "./prompt.ts";
import { reviewStaging } from "./review-ui.ts";
import { runReviewer } from "./reviewer.ts";
import { loadSettings } from "./settings.ts";
import { listCandidates, recordCandidateMetadata, recordSkillRead } from "./storage.ts";
import { buildTranscript, entriesForManualDistillation, entriesSinceWatermark, passesGate } from "./transcript.ts";
import {
	reviewerSkills,
	type DistillSettings,
	type DistillTrigger,
	WATERMARK_ENTRY,
} from "./types.ts";

interface DistillRunResult {
	changed: number;
	processed: boolean;
}

function candidateName(filePath: string): string {
	const normalized = filePath.replace(/\\/g, "/");
	return normalized.split("/").at(-2) ?? normalized;
}

export default function skillDistiller(pi: ExtensionAPI): void {
	let currentSkills: readonly Skill[] = [];
	let loadedThisRound = new Set<string>();
	let automaticRunActive = false;

	async function distill(args: {
		ctx: ExtensionContext;
		settings: DistillSettings;
		trigger: DistillTrigger;
		force: boolean;
		reason?: string;
		signal?: AbortSignal;
	}): Promise<DistillRunResult> {
		return withDistillLock(args.ctx.cwd, args.force ? 10_000 : 2_000, async () => {
			const branch = args.ctx.sessionManager.getBranch() as SessionEntry[];
			const selectedEntries = args.force ? entriesForManualDistillation(branch) : entriesSinceWatermark(branch);
			const slice = buildTranscript(selectedEntries);
			if (!slice.lastEntryId) return { changed: 0, processed: false };
			if (!args.force && !passesGate(slice, args.settings)) return { changed: 0, processed: false };
			const result = await runReviewer({
				ctx: args.ctx,
				settings: args.settings,
				transcript: slice.text,
				existingSkills: reviewerSkills(currentSkills),
				reason: args.reason,
				loadedSkillNames: [...loadedThisRound].sort(),
				signal: args.signal ?? args.ctx.signal,
			});
			const names = result.changedFiles.map(candidateName);
			try {
				await recordCandidateMetadata({
					cwd: args.ctx.cwd,
					names,
					trigger: args.trigger,
					summary: result.summary,
					sessionId: args.ctx.sessionManager.getSessionId(),
				});
			} catch (error) {
				args.ctx.ui.notify(`Candidate metadata was not saved: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
			pi.appendEntry(WATERMARK_ENTRY, {
				entryId: slice.lastEntryId,
				trigger: args.trigger,
				createdAt: new Date().toISOString(),
			});
			return { changed: names.length, processed: true };
		});
	}

	async function runManual(ctx: ExtensionCommandContext, trigger: "/distill" | "/distill-feedback", reason: string): Promise<void> {
		ctx.ui.notify("Distillation started; waiting for the current turn, then reviewing the conversation…", "info");
		ctx.ui.setStatus("skill-distiller", "Distilling…");
		try {
			await ctx.waitForIdle();
			const settings = await loadSettings(ctx.cwd);
			if (!settings.enabled) {
				ctx.ui.notify("Skill distiller is disabled in settings.", "warning");
				return;
			}
			currentSkills = ctx.getSystemPromptOptions().skills ?? [];
			const result = await distill({ ctx, settings, trigger, force: true, reason: reason.trim() || undefined });
			ctx.ui.setStatus("skill-distiller", undefined);
			if (!result.processed) ctx.ui.notify("No conversation to distill yet. Complete a conversation turn, then run /distill.", "info");
			if (result.changed === 0 && result.processed) ctx.ui.notify("Nothing to save.", "info");
			if (result.changed > 0 && !ctx.hasUI) {
				ctx.ui.notify(`Distilled ${result.changed} candidate(s); review them later with /distill-review.`, "info");
			}
			if (ctx.hasUI && (result.changed > 0 || (await listCandidates(ctx.cwd)).length > 0)) {
				await reviewStaging({ pi, ctx, skills: currentSkills, settings });
			}
		} catch (error) {
			ctx.ui.notify(`Distillation failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			ctx.ui.setStatus("skill-distiller", undefined);
		}
	}

	pi.on("before_agent_start", async (event, ctx) => {
		currentSkills = event.systemPromptOptions.skills ?? [];
		loadedThisRound = new Set<string>();
		let settings: DistillSettings;
		try {
			settings = await loadSettings(event.systemPromptOptions.cwd);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
			return;
		}
		if (!settings.enabled || !settings.injectMaintenancePrompt || currentSkills.length < settings.feedbackMinSkills) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${MAINTENANCE_PROMPT}` };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "read" || currentSkills.length === 0) return;
		const rawPath = event.input.path;
		if (typeof rawPath !== "string") return;
		const absolutePath = resolve(ctx.cwd, rawPath);
		const skill = currentSkills.find((item) => resolve(item.filePath) === absolutePath);
		if (!skill) return;
		loadedThisRound.add(skill.name);
		try {
			const settings = await loadSettings(ctx.cwd);
			if (currentSkills.length < settings.feedbackMinSkills) return;
			await recordSkillRead(ctx.cwd, skill, ctx.sessionManager.getSessionId());
		} catch {}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (automaticRunActive || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		automaticRunActive = true;
		try {
			const settings = await loadSettings(ctx.cwd);
			if (!settings.enabled || !settings.autoDistill) return;
			const result = await distill({ ctx, settings, trigger: "agent_settled", force: false });
			if (result.changed > 0) ctx.ui.notify(`Distilled ${result.changed} candidate(s); run /distill-review.`, "info");
		} catch (error) {
			ctx.ui.notify(`Automatic distillation skipped: ${error instanceof Error ? error.message : String(error)}`, "warning");
		} finally {
			automaticRunActive = false;
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (automaticRunActive) return;
		automaticRunActive = true;
		try {
			const settings = await loadSettings(ctx.cwd);
			if (!settings.enabled || !settings.autoDistill) return;
			await distill({ ctx, settings, trigger: "session_before_compact", force: false, signal: event.signal });
		} catch (error) {
			ctx.ui.notify(`Pre-compaction distillation skipped: ${error instanceof Error ? error.message : String(error)}`, "warning");
		} finally {
			automaticRunActive = false;
		}
	});

	pi.on("session_compact", async (event, ctx) => {
		try {
			if (!(await loadSettings(ctx.cwd)).enabled) return;
			pi.appendEntry(WATERMARK_ENTRY, {
				entryId: event.compactionEntry.id,
				trigger: "session_before_compact",
				createdAt: new Date().toISOString(),
			});
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
		}
	});

	pi.registerCommand("distill", {
		description: "Distill the current conversation slice and review candidates",
		handler: async (reason, ctx) => runManual(ctx, "/distill", reason),
	});

	pi.registerCommand("distill-feedback", {
		description: "Create a correction candidate for skills used in the current round",
		handler: async (reason, ctx) => {
			const context = loadedThisRound.size > 0 ? `Loaded skills: ${[...loadedThisRound].sort().join(", ")}. ` : "";
			await runManual(ctx, "/distill-feedback", `${context}${reason || "Correct the skill guidance that failed in this round."}`);
		},
	});

	pi.registerCommand("distill-review", {
		description: "Review, edit, approve, or discard staged skill candidates",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			try {
				const settings = await loadSettings(ctx.cwd);
				await reviewStaging({ pi, ctx, skills: currentSkills, settings });
			} catch (error) {
				ctx.ui.notify(`Review failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
