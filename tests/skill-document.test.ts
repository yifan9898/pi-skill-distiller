import assert from "node:assert/strict";
import test from "node:test";
import { editDistance, keywordOverlap, parseSkillDocument } from "../extensions/distiller/skill-document.ts";

const valid = `---
name: debug-node-tests
description: Diagnose flaky Node test failures and isolate their root cause.
---

# Debug Node tests

Run the smallest failing test first.
`;

test("parses a valid skill document", () => {
	assert.deepEqual(parseSkillDocument(valid), {
		name: "debug-node-tests",
		description: "Diagnose flaky Node test failures and isolate their root cause.",
	});
});

test("rejects invalid names and empty bodies", () => {
	assert.throws(() => parseSkillDocument(valid.replace("debug-node-tests", "Debug_Tests")), /Skill name/);
	assert.throws(() => parseSkillDocument(valid.replace("# Debug Node tests\n\nRun the smallest failing test first.", "")), /must not be empty/);
});

test("duplicate signals identify close names and descriptions", () => {
	assert.equal(editDistance("node-debug", "node-debugs"), 1);
	assert.ok(keywordOverlap(
		"Diagnose flaky Node test failures with focused test runs",
		"Focused Node test runs diagnose flaky failures",
	) >= 0.6);
});
