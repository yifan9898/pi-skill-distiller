import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Skill } from "@earendil-works/pi-coding-agent";
import { withDistillLock } from "./lock.ts";
import { editDistance, keywordOverlap, parseSkillDocument, type ParsedSkillDocument } from "./skill-document.ts";
import {
	atomicWrite,
	discardCandidate,
	distillPaths,
	listCandidates,
	readStagingMetadata,
	staleSkillNames,
} from "./storage.ts";
import type { DistillCandidate, DistillSettings } from "./types.ts";

function duplicateWarning(candidate: DistillCandidate, skills: readonly Skill[]): string | undefined {
	const similar = skills.filter((skill) =>
		editDistance(candidate.name, skill.name) <= 2
		|| keywordOverlap(candidate.description, skill.description) >= 0.6
	);
	return similar.length > 0 ? `Possible overlap: ${similar.map((skill) => skill.name).join(", ")}` : undefined;
}

async function gitCommit(args: {
	pi: ExtensionAPI;
	root: string;
	name: string;
	action: "create" | "update";
	sessionId: string;
	trigger: string;
	reason: string;
}): Promise<string | undefined> {
	await mkdir(args.root, { recursive: true });
	const init = await args.pi.exec("git", ["init"], { cwd: args.root, timeout: 10_000 });
	if (init.code !== 0) return init.stderr.trim() || "git init failed";
	const relativePath = `${args.name}/SKILL.md`;
	const add = await args.pi.exec("git", ["add", "--", relativePath], { cwd: args.root, timeout: 10_000 });
	if (add.code !== 0) return add.stderr.trim() || "git add failed";
	const diff = await args.pi.exec("git", ["diff", "--cached", "--quiet", "--", relativePath], {
		cwd: args.root,
		timeout: 10_000,
	});
	if (diff.code === 0) return undefined;
	if (diff.code !== 1) return diff.stderr.trim() || "git diff failed";
	const message = [
		`distill(${args.action}): ${args.name}`,
		"",
		`session: ${args.sessionId}`,
		`trigger: ${args.trigger}`,
		`reason: ${args.reason.replace(/\s+/g, " ").trim() || "reviewed candidate"}`,
	].join("\n");
	const commit = await args.pi.exec("git", ["commit", "-m", message, "--", relativePath], {
		cwd: args.root,
		timeout: 20_000,
	});
	return commit.code === 0 ? undefined : commit.stderr.trim() || "git commit failed";
}

async function approveCandidate(args: {
	pi: ExtensionAPI;
	ctx: ExtensionCommandContext;
	candidate: DistillCandidate;
	content: string;
	target: "project" | "global";
}): Promise<void> {
	const parsed = parseSkillDocument(args.content);
	if (parsed.name !== args.candidate.name) throw new Error("Edited frontmatter name must match the staged directory name.");
	const paths = distillPaths(args.ctx.cwd);
	const root = args.target === "project" ? paths.projectSkillsRoot : paths.globalSkillsRoot;
	const destination = join(root, parsed.name, "SKILL.md");
	let action: "create" | "update" = "create";
	try {
		await access(destination);
		action = "update";
	} catch {}
	await atomicWrite(destination, args.content.endsWith("\n") ? args.content : `${args.content}\n`);
	const metadata = (await readStagingMetadata(args.ctx.cwd)).candidates[parsed.name];
	const gitError = await gitCommit({
		pi: args.pi,
		root,
		name: parsed.name,
		action,
		sessionId: metadata?.sessionId ?? args.ctx.sessionManager.getSessionId(),
		trigger: metadata?.trigger ?? "/distill-review",
		reason: metadata?.summary ?? "reviewed staged candidate",
	});
	await discardCandidate(args.ctx.cwd, parsed.name);
	if (gitError) args.ctx.ui.notify(`Saved ${parsed.name}, but git history was not recorded: ${gitError}`, "warning");
	else args.ctx.ui.notify(`Saved ${parsed.name} to ${args.target} skills.`, "info");
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function reviewOne(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	candidate: DistillCandidate,
	skills: readonly Skill[],
): Promise<boolean> {
	const warning = duplicateWarning(candidate, skills);
	const edited = await ctx.ui.editor(`Review ${candidate.name}${warning ? ` — ${warning}` : ""}`, candidate.content);
	if (edited === undefined) return false;
	let parsed: ParsedSkillDocument;
	try {
		parsed = parseSkillDocument(edited);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return false;
	}
	if (parsed.name !== candidate.name) {
		ctx.ui.notify("Edited frontmatter name must match the staged directory name.", "error");
		return false;
	}
	const paths = distillPaths(ctx.cwd);
	const projectLabel = await pathExists(join(paths.projectSkillsRoot, candidate.name, "SKILL.md"))
		? "Approve for project (update existing)"
		: "Approve for project";
	const globalLabel = await pathExists(join(paths.globalSkillsRoot, candidate.name, "SKILL.md"))
		? "Approve globally (update existing)"
		: "Approve globally";
	const action = await ctx.ui.select(`Approve ${candidate.name}`, [
		projectLabel,
		globalLabel,
		"Discard",
		"Keep staged",
	]);
	if (action === projectLabel || action === globalLabel) {
		await approveCandidate({
			pi,
			ctx,
			candidate,
			content: edited,
			target: action === projectLabel ? "project" : "global",
		});
		return true;
	}
	if (action === "Discard") await discardCandidate(ctx.cwd, candidate.name);
	if (action === "Keep staged") {
		await atomicWrite(candidate.filePath, edited.endsWith("\n") ? edited : `${edited}\n`);
	}
	return false;
}

export async function reviewStaging(args: {
	pi: ExtensionAPI;
	ctx: ExtensionCommandContext;
	skills: readonly Skill[];
	settings: DistillSettings;
}): Promise<void> {
	await withDistillLock(args.ctx.cwd, 10_000, async () => {
		const candidates = await listCandidates(args.ctx.cwd);
		if (args.skills.length >= args.settings.feedbackMinSkills) {
			const stale = await staleSkillNames(args.ctx.cwd, args.skills, args.settings.staleAfterDays);
			if (stale.length > 0) {
				args.ctx.ui.notify(`Skills not read recently: ${stale.slice(0, 8).join(", ")}${stale.length > 8 ? "…" : ""}`, "warning");
			}
		}
		if (candidates.length === 0) {
			args.ctx.ui.notify("No staged skill candidates.", "info");
			return;
		}
		const action = await args.ctx.ui.select(`Distilled ${candidates.length} candidate(s)`, [
			"Review one by one",
			"Discard all",
			"Keep for later",
		]);
		if (action === "Discard all") {
			if (await args.ctx.ui.confirm("Discard all candidates", "This permanently removes every staged candidate.")) {
				for (const candidate of candidates) await discardCandidate(args.ctx.cwd, candidate.name);
			}
			return;
		}
		if (action !== "Review one by one") return;
		let changed = false;
		for (const candidate of candidates) {
			changed = await reviewOne(args.pi, args.ctx, candidate, args.skills) || changed;
		}
		if (changed) await args.ctx.reload();
	});
}
