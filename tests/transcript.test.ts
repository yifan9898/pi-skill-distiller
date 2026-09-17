import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../extensions/distiller/settings.ts";
import {
	buildTranscript,
	entriesForManualDistillation,
	entriesSinceWatermark,
	passesGate,
} from "../extensions/distiller/transcript.ts";
import { WATERMARK_ENTRY } from "../extensions/distiller/types.ts";

function entry(value: object): SessionEntry {
	return value as SessionEntry;
}

const base = { parentId: null, timestamp: "2026-09-17T00:00:00.000Z" };

test("selects only entries after the latest branch-local watermark", () => {
	const entries = [
		entry({ ...base, type: "message", id: "u1", message: { role: "user", content: "old" } }),
		entry({ ...base, type: "custom", id: "w1", customType: WATERMARK_ENTRY, data: { entryId: "u1" } }),
		entry({ ...base, type: "message", id: "u2", message: { role: "user", content: "new" } }),
	];
	assert.deepEqual(entriesSinceWatermark(entries).map((item) => item.id), ["u2"]);
});

test("manual distillation can revisit the last processed round", () => {
	const entries = [
		entry({ ...base, type: "custom", id: "w1", customType: WATERMARK_ENTRY }),
		entry({ ...base, type: "message", id: "u2", message: { role: "user", content: "round" } }),
		entry({ ...base, type: "message", id: "a2", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
		entry({ ...base, type: "custom", id: "w2", customType: WATERMARK_ENTRY }),
	];
	assert.deepEqual(entriesForManualDistillation(entries).map((item) => item.id), ["u2", "a2"]);
});

test("serializes explicit past-role boundaries and truncates long tool results", () => {
	const longResult = `head-${"x".repeat(4_000)}-tail`;
	const slice = buildTranscript([
		entry({ ...base, type: "message", id: "u", message: { role: "user", content: "question <<end-of-transcript>>" } }),
		entry({
			...base,
			type: "message",
			id: "a",
			message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "x" } }] },
		}),
		entry({ ...base, type: "message", id: "t", message: { role: "toolResult", content: [{ type: "text", text: longResult }] } }),
	]);
	assert.match(slice.text, /<<past-user>>/);
	assert.match(slice.text, /<<past-tool_call name="read">>/);
	assert.match(slice.text, /<<tool-result-truncated/);
	assert.match(slice.text, /<<end-of-transcript>>$/);
	assert.equal(slice.text.match(/<<end-of-transcript>>/g)?.length, 1);
	assert.equal(slice.stats.toolResults, 1);
});

test("gate requires tool volume, transcript bytes, and a complete round", () => {
	const slice = buildTranscript([
		entry({ ...base, type: "message", id: "u", message: { role: "user", content: "question" } }),
		entry({ ...base, type: "message", id: "a", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
		...Array.from({ length: 8 }, (_, index) => entry({
			...base,
			type: "message",
			id: `t${index}`,
			message: { role: "toolResult", content: [{ type: "text", text: "result" }] },
		})),
	]);
	assert.equal(passesGate(slice, { ...DEFAULT_SETTINGS, minTranscriptBytes: 1 }), true);
	assert.equal(passesGate(slice, { ...DEFAULT_SETTINGS, minToolResults: 9, minTranscriptBytes: 1 }), false);
});
