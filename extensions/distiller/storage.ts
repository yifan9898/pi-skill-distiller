import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { withDistillLock } from "./lock.ts";
import { parseSkillDocument } from "./skill-document.ts";
import type {
	CandidateMetadata,
	DistillCandidate,
	DistillTrigger,
	StagingMetadata,
	UsageDatabase,
} from "./types.ts";

export interface DistillPaths {
	piRoot: string;
	stagingRoot: string;
	projectSkillsRoot: string;
	globalSkillsRoot: string;
	usageFile: string;
	stagingMetadataFile: string;
}

export function distillPaths(cwd: string): DistillPaths {
	const piRoot = join(cwd, ".pi");
	return {
		piRoot,
		stagingRoot: join(piRoot, "distill-staging"),
		projectSkillsRoot: join(piRoot, "skills"),
		globalSkillsRoot: join(homedir(), ".pi", "agent", "skills"),
		usageFile: join(piRoot, "distill-usage.json"),
		stagingMetadataFile: join(piRoot, "distill-staging", ".metadata.json"),
	};
}

export function isWithin(root: string, candidate: string): boolean {
	const rel = relative(resolve(root), resolve(candidate));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes(".."));
}

export async function atomicWrite(filePath: string, content: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
	await writeFile(temporaryPath, content, "utf8");
	await rename(temporaryPath, filePath);
}

export async function atomicWriteStagedSkill(stagingRoot: string, filePath: string, content: string): Promise<void> {
	if (!isWithin(stagingRoot, filePath)) throw new Error("Unsafe staging path.");
	await mkdir(stagingRoot, { recursive: true });
	const rootInfo = await lstat(stagingRoot);
	if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("Staging root must be a real directory.");
	const parent = dirname(filePath);
	try {
		const parentInfo = await lstat(parent);
		if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
			throw new Error("Staging candidate directory must be a real directory.");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await mkdir(parent);
	}
	await atomicWrite(filePath, content);
}

export async function listCandidates(cwd: string): Promise<DistillCandidate[]> {
	const { stagingRoot } = distillPaths(cwd);
	let entries;
	try {
		entries = await readdir(stagingRoot, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}

	const candidates: DistillCandidate[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) continue;
		const filePath = join(stagingRoot, entry.name, "SKILL.md");
		try {
			const content = await readFile(filePath, "utf8");
			try {
				const parsed = parseSkillDocument(content);
				if (parsed.name !== entry.name) {
					candidates.push({ name: entry.name, description: "Invalid candidate: frontmatter name mismatch", filePath, content });
					continue;
				}
				candidates.push({ name: parsed.name, description: parsed.description, filePath, content });
			} catch (error) {
				candidates.push({
					name: entry.name,
					description: `Invalid candidate: ${error instanceof Error ? error.message : String(error)}`,
					filePath,
					content,
				});
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return candidates.sort((left, right) => left.name.localeCompare(right.name));
}

export async function discardCandidate(cwd: string, name: string): Promise<void> {
	const { stagingRoot } = distillPaths(cwd);
	const candidateDir = join(stagingRoot, name);
	if (!isWithin(stagingRoot, candidateDir)) throw new Error("Unsafe staging path.");
	await rm(candidateDir, { recursive: true, force: true });
	const metadata = await readStagingMetadata(cwd);
	delete metadata.candidates[name];
	await atomicWrite(distillPaths(cwd).stagingMetadataFile, `${JSON.stringify(metadata, null, 2)}\n`);
}

export async function readStagingMetadata(cwd: string): Promise<StagingMetadata> {
	const { stagingMetadataFile } = distillPaths(cwd);
	try {
		const value = JSON.parse(await readFile(stagingMetadataFile, "utf8")) as Partial<StagingMetadata>;
		if (value.version === 1 && value.candidates && typeof value.candidates === "object") {
			return { version: 1, candidates: value.candidates };
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
	}
	return { version: 1, candidates: {} };
}

export async function recordCandidateMetadata(args: {
	cwd: string;
	names: readonly string[];
	trigger: DistillTrigger;
	summary: string;
	sessionId: string;
}): Promise<void> {
	if (args.names.length === 0) return;
	const metadata = await readStagingMetadata(args.cwd);
	const value: CandidateMetadata = {
		trigger: args.trigger,
		summary: args.summary,
		sessionId: args.sessionId,
		createdAt: new Date().toISOString(),
	};
	for (const name of args.names) metadata.candidates[name] = value;
	await atomicWrite(distillPaths(args.cwd).stagingMetadataFile, `${JSON.stringify(metadata, null, 2)}\n`);
}

export async function readUsageDatabase(cwd: string): Promise<UsageDatabase> {
	const { usageFile } = distillPaths(cwd);
	try {
		const value = JSON.parse(await readFile(usageFile, "utf8")) as Partial<UsageDatabase>;
		if (value.version === 1 && value.skills && typeof value.skills === "object") {
			return { version: 1, skills: value.skills };
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
	}
	return { version: 1, skills: {} };
}

export async function recordSkillRead(cwd: string, skill: Skill, sessionId: string): Promise<void> {
	await withDistillLock(cwd, 1_000, async () => {
		const database = await readUsageDatabase(cwd);
		const key = resolve(skill.filePath);
		const previous = database.skills[key];
		database.skills[key] = {
			name: skill.name,
			filePath: key,
			readCount: (previous?.readCount ?? 0) + 1,
			lastReadAt: new Date().toISOString(),
			lastSessionId: sessionId,
		};
		await atomicWrite(distillPaths(cwd).usageFile, `${JSON.stringify(database, null, 2)}\n`);
	});
}

export async function staleSkillNames(cwd: string, skills: readonly Skill[], staleAfterDays: number): Promise<string[]> {
	const database = await readUsageDatabase(cwd);
	const cutoff = Date.now() - staleAfterDays * 24 * 60 * 60 * 1000;
	const stale: string[] = [];
	for (const skill of skills) {
		const usage = database.skills[resolve(skill.filePath)];
		if (usage) {
			if (Date.parse(usage.lastReadAt) < cutoff) stale.push(skill.name);
			continue;
		}
		try {
			if ((await stat(skill.filePath)).mtimeMs < cutoff) stale.push(skill.name);
		} catch {}
	}
	return stale.sort();
}
