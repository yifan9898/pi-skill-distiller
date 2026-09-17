const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ParsedSkillDocument {
	name: string;
	description: string;
}

export function parseSkillDocument(content: string): ParsedSkillDocument {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/u.exec(content);
	if (!match) throw new Error("SKILL.md must contain YAML frontmatter and a non-empty body.");
	const frontmatter = match[1] ?? "";
	const body = match[2]?.trim() ?? "";
	const name = /^name:\s*(.+?)\s*$/mu.exec(frontmatter)?.[1]?.trim();
	const description = /^description:\s*(.+?)\s*$/mu.exec(frontmatter)?.[1]?.trim();
	if (!name || !NAME_PATTERN.test(name) || name.length > 64) {
		throw new Error("Skill name must be 1-64 lowercase letters, numbers, or single hyphens.");
	}
	if (!description || description.length > 1024) {
		throw new Error("Skill description must be present and at most 1024 characters.");
	}
	if (!body) throw new Error("SKILL.md body must not be empty.");
	return { name, description };
}

export function keywordOverlap(left: string, right: string): number {
	const words = (value: string): Set<string> => new Set(
		value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3),
	);
	const leftWords = words(left);
	const rightWords = words(right);
	if (leftWords.size === 0 || rightWords.size === 0) return 0;
	let intersection = 0;
	for (const word of leftWords) if (rightWords.has(word)) intersection++;
	return intersection / Math.min(leftWords.size, rightWords.size);
}

export function editDistance(left: string, right: string): number {
	const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
		const current = [leftIndex];
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
			current[rightIndex] = Math.min(
				(current[rightIndex - 1] ?? 0) + 1,
				(previous[rightIndex] ?? 0) + 1,
				(previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
			);
		}
		previous.splice(0, previous.length, ...current);
	}
	return previous[right.length] ?? left.length;
}
