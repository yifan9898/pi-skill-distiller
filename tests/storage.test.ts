import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	atomicWrite,
	atomicWriteStagedSkill,
	distillPaths,
	isWithin,
	listCandidates,
} from "../extensions/distiller/storage.ts";

test("staging stays outside the recursively discovered skill directory", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-skill-distiller-"));
	try {
		const paths = distillPaths(cwd);
		assert.equal(isWithin(paths.projectSkillsRoot, paths.stagingRoot), false);
		await atomicWrite(join(paths.stagingRoot, "safe-skill", "SKILL.md"), `---
name: safe-skill
description: A valid staged skill.
---

# Safe skill

Use the safe workflow.
`);
		const candidates = await listCandidates(cwd);
		assert.deepEqual(candidates.map((candidate) => candidate.name), ["safe-skill"]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("path containment rejects sibling-prefix and traversal paths", () => {
	assert.equal(isWithin("/tmp/skills", "/tmp/skills/a/SKILL.md"), true);
	assert.equal(isWithin("/tmp/skills", "/tmp/skills-evil/a/SKILL.md"), false);
	assert.equal(isWithin("/tmp/skills", "/tmp/skills/../outside"), false);
});

test("staged writes reject symlinked candidate directories", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-skill-distiller-link-"));
	try {
		const paths = distillPaths(cwd);
		const outside = join(cwd, "outside");
		await mkdir(paths.stagingRoot, { recursive: true });
		await mkdir(outside);
		await symlink(outside, join(paths.stagingRoot, "linked-skill"));
		await assert.rejects(
			atomicWriteStagedSkill(
				paths.stagingRoot,
				join(paths.stagingRoot, "linked-skill", "SKILL.md"),
				"unsafe",
			),
			/real directory/,
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
