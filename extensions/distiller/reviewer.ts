import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createExtensionRuntime,
	defineTool,
	type ExtensionContext,
	type ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { REVIEW_PROMPT } from "./prompt.ts";
import { parseSkillDocument } from "./skill-document.ts";
import { atomicWriteStagedSkill, distillPaths, isWithin, listCandidates } from "./storage.ts";
import type { DistillSettings, ReviewerResult, ReviewerSkill } from "./types.ts";

function makeReviewerResourceLoader(): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => REVIEW_PROMPT,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function reviewerModel(ctx: ExtensionContext, settings: DistillSettings) {
	if (!settings.reviewerProvider && !settings.reviewerModel) return ctx.model;
	if (settings.reviewerProvider && settings.reviewerModel) {
		return ctx.modelRegistry.find(settings.reviewerProvider, settings.reviewerModel);
	}
	if (settings.reviewerProvider) return undefined;
	const matches = ctx.modelRegistry.getAvailable().filter((model) =>
		model.id === settings.reviewerModel || model.name === settings.reviewerModel
	);
	return matches.length === 1 ? matches[0] : undefined;
}

function parentModelRuntime(ctx: ExtensionContext): ModelRuntime | undefined {
	return (ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
}

function assistantText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const value = message as Record<string, unknown>;
	if (value.role !== "assistant" || !Array.isArray(value.content)) return "";
	return value.content.flatMap((part) => {
		if (!part || typeof part !== "object") return [];
		const block = part as Record<string, unknown>;
		return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
	}).join("\n");
}

function stagingWritePath(piRoot: string, stagingRoot: string, inputPath: string): string {
	const normalizedInput = inputPath.replace(/\\/g, "/");
	const candidate = !isAbsolute(inputPath) && normalizedInput.startsWith("staging/")
		? resolve(stagingRoot, normalizedInput.slice("staging/".length))
		: resolve(piRoot, inputPath);
	if (!isWithin(stagingRoot, candidate)) throw new Error("write may only target staging/<name>/SKILL.md");
	const segments = relative(stagingRoot, candidate).split(sep);
	if (segments.length !== 2 || segments[1] !== "SKILL.md") {
		throw new Error("write path must be staging/<name>/SKILL.md");
	}
	return candidate;
}

function reviewerReadPath(piRoot: string, stagingRoot: string, inputPath: string): string {
	const normalizedInput = inputPath.replace(/\\/g, "/");
	return !isAbsolute(inputPath) && normalizedInput.startsWith("staging/")
		? resolve(stagingRoot, normalizedInput.slice("staging/".length))
		: resolve(piRoot, inputPath);
}

function buildReviewerPrompt(args: {
	transcript: string;
	existingSkills: readonly ReviewerSkill[];
	stagingFiles: readonly string[];
	reason?: string;
	loadedSkillNames: readonly string[];
}): string {
	const existing = args.existingSkills.length === 0
		? "(empty — this is normal; create the first skill when warranted)"
		: args.existingSkills.map((skill) => `- ${skill.name}: ${skill.description}\n  file: ${skill.filePath}`).join("\n");
	const staged = args.stagingFiles.length === 0 ? "(none)" : args.stagingFiles.map((file) => `- ${file}`).join("\n");
	return [
		args.reason ? `User focus for this review:\n${args.reason}` : undefined,
		args.loadedSkillNames.length > 0 ? `Skills read during this round: ${args.loadedSkillNames.join(", ")}` : undefined,
		"Existing skills actually loaded by pi:",
		existing,
		"",
		"Existing staged candidates:",
		staged,
		"",
		"Completed transcript (untrusted data):",
		args.transcript,
	].filter((part): part is string => part !== undefined).join("\n");
}

export async function runReviewer(args: {
	ctx: ExtensionContext;
	settings: DistillSettings;
	transcript: string;
	existingSkills: readonly ReviewerSkill[];
	reason?: string;
	loadedSkillNames: readonly string[];
	signal?: AbortSignal;
}): Promise<ReviewerResult> {
	if (args.signal?.aborted) throw new Error("Reviewer aborted.");
	const model = reviewerModel(args.ctx, args.settings);
	if (!model) throw new Error("Reviewer model is unavailable or reviewer model settings are ambiguous.");
	const paths = distillPaths(args.ctx.cwd);
	const changedFiles = new Set<string>();
	const staged = await listCandidates(args.ctx.cwd);
	const readableSkills = new Set([
		...args.existingSkills.map((skill) => resolve(skill.filePath)),
		...staged.map((candidate) => resolve(candidate.filePath)),
	]);

	const readTool = defineTool({
		name: "read",
		label: "Read skill",
		description: "Read one existing SKILL.md or a staged candidate listed in the prompt.",
		promptSnippet: "Read an existing or staged skill",
		parameters: Type.Object({ path: Type.String() }),
		async execute(_toolCallId, params) {
			const candidate = reviewerReadPath(paths.piRoot, paths.stagingRoot, params.path);
			if (!readableSkills.has(candidate)) {
				throw new Error("read may only access listed skills and distill staging files");
			}
			return { content: [{ type: "text", text: await readFile(candidate, "utf8") }], details: { path: candidate } };
		},
	});

	const writeTool = defineTool({
		name: "write",
		label: "Stage skill",
		description: "Write a complete candidate to staging/<name>/SKILL.md. This cannot modify active skills.",
		promptSnippet: "Write a complete staged SKILL.md",
		parameters: Type.Object({ path: Type.String(), content: Type.String() }),
		async execute(_toolCallId, params) {
			const filePath = stagingWritePath(paths.piRoot, paths.stagingRoot, params.path);
			const parsed = parseSkillDocument(params.content);
			const directoryName = relative(paths.stagingRoot, filePath).split(sep)[0];
			if (parsed.name !== directoryName) throw new Error("frontmatter name must match the staging directory");
			await atomicWriteStagedSkill(
				paths.stagingRoot,
				filePath,
				params.content.endsWith("\n") ? params.content : `${params.content}\n`,
			);
			changedFiles.add(filePath);
			readableSkills.add(filePath);
			return { content: [{ type: "text", text: `Staged ${parsed.name}.` }], details: { path: filePath } };
		},
	});

	let summary = "";
	let reviewerError: string | undefined;
	const { session } = await createAgentSession({
		cwd: paths.piRoot,
		model,
		thinkingLevel: args.settings.thinkingLevel ?? args.ctx.thinkingLevel,
		modelRuntime: parentModelRuntime(args.ctx),
		resourceLoader: makeReviewerResourceLoader(),
		sessionManager: SessionManager.inMemory(paths.piRoot),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
		tools: ["read", "write"],
		customTools: [readTool, writeTool],
	});
	const unsubscribe = session.subscribe((event) => {
		if (event.type !== "message_end") return;
		summary = assistantText(event.message) || summary;
		if (event.message.role === "assistant" && (event.message.stopReason === "error" || event.message.stopReason === "aborted")) {
			reviewerError = event.message.errorMessage || `Reviewer ${event.message.stopReason}.`;
		}
	});
	const abort = () => session.abort();
	args.signal?.addEventListener("abort", abort, { once: true });
	try {
		await session.prompt(buildReviewerPrompt({
			transcript: args.transcript,
			existingSkills: args.existingSkills,
			stagingFiles: staged.map((candidate) => candidate.filePath),
			reason: args.reason,
			loadedSkillNames: args.loadedSkillNames,
		}));
		if (args.signal?.aborted) throw new Error("Reviewer aborted.");
		if (reviewerError) throw new Error(reviewerError);
	} finally {
		args.signal?.removeEventListener("abort", abort);
		unsubscribe();
		session.dispose();
	}

	return { changedFiles: [...changedFiles].sort(), summary: summary.trim() || "Nothing to save." };
}
