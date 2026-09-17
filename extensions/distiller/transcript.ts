import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { WATERMARK_ENTRY, type DistillSettings, type TranscriptSlice } from "./types.ts";

const TOOL_RESULT_LIMIT_BYTES = 2 * 1024;
const TOOL_RESULT_EDGE_BYTES = 1024;

function escapeTranscriptMarkers(value: string): string {
	return value.replaceAll("<<", "<\u200b<");
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return escapeTranscriptMarkers(content);
	if (!Array.isArray(content)) return String(content ?? "");
	return content.map((part) => {
		if (!part || typeof part !== "object") return String(part);
		const value = part as Record<string, unknown>;
		if (value.type === "text" && typeof value.text === "string") return escapeTranscriptMarkers(value.text);
		if (value.type === "thinking" && typeof value.thinking === "string") {
			return `[thinking]\n${escapeTranscriptMarkers(value.thinking)}`;
		}
		if (value.type === "toolCall") {
			const name = typeof value.name === "string" ? value.name : "unknown";
			return `<<past-tool_call name="${name}">>\n${escapeTranscriptMarkers(JSON.stringify(value.arguments ?? {}))}\n<<end-past-tool_call>>`;
		}
		if (value.type === "image") return "[image omitted]";
		return escapeTranscriptMarkers(JSON.stringify(value));
	}).join("\n");
}

function truncateToolResult(value: string): string {
	const data = Buffer.from(value, "utf8");
	if (data.byteLength <= TOOL_RESULT_LIMIT_BYTES) return value;
	const head = data.subarray(0, TOOL_RESULT_EDGE_BYTES).toString("utf8");
	const tail = data.subarray(data.byteLength - TOOL_RESULT_EDGE_BYTES).toString("utf8");
	return `${head}\n<<tool-result-truncated ${data.byteLength - 2 * TOOL_RESULT_EDGE_BYTES} bytes>>\n${tail}`;
}

function serializeMessage(message: unknown): { text: string; role: string } | undefined {
	if (!message || typeof message !== "object") return undefined;
	const value = message as Record<string, unknown>;
	if (typeof value.role !== "string") return undefined;
	const role = value.role === "toolResult" ? "tool_result" : value.role.replace(/[^a-zA-Z0-9_-]/g, "-");
	const body = value.role === "toolResult"
		? truncateToolResult(textFromContent(value.content))
		: textFromContent(value.content);
	return { role, text: `<<past-${role}>>\n${body}\n<<end-past-${role}>>` };
}

export function entriesSinceWatermark(entries: readonly SessionEntry[]): SessionEntry[] {
	let watermarkIndex = -1;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "custom" && entry.customType === WATERMARK_ENTRY) {
			watermarkIndex = index;
			break;
		}
	}
	return entries.slice(watermarkIndex + 1);
}

export function entriesForManualDistillation(entries: readonly SessionEntry[]): SessionEntry[] {
	const fresh = entriesSinceWatermark(entries);
	if (buildTranscript(fresh).lastEntryId) return fresh;
	let latestWatermark = -1;
	let previousWatermark = -1;
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== WATERMARK_ENTRY) continue;
		previousWatermark = latestWatermark;
		latestWatermark = index;
	}
	if (latestWatermark < 0) return [...entries];
	return entries.slice(previousWatermark + 1, latestWatermark);
}

export function buildTranscript(entries: readonly SessionEntry[]): TranscriptSlice {
	const chunks: string[] = [];
	let toolResults = 0;
	let userMessages = 0;
	let assistantMessages = 0;
	let lastEntryId: string | null = null;

	for (const entry of entries) {
		if (entry.type === "message") {
			const serialized = serializeMessage(entry.message);
			if (!serialized) continue;
			chunks.push(serialized.text);
			if (serialized.role === "tool_result") toolResults++;
			if (serialized.role === "user") userMessages++;
			if (serialized.role === "assistant") assistantMessages++;
			lastEntryId = entry.id;
			continue;
		}
		if (entry.type === "compaction") {
			chunks.push(`<<past-compaction>>\n${escapeTranscriptMarkers(entry.summary)}\n<<end-past-compaction>>`);
			lastEntryId = entry.id;
			continue;
		}
		if (entry.type === "branch_summary") {
			chunks.push(`<<past-branch_summary>>\n${escapeTranscriptMarkers(entry.summary)}\n<<end-past-branch_summary>>`);
			lastEntryId = entry.id;
			continue;
		}
		if (entry.type === "custom_message") {
			chunks.push(`<<past-custom_message>>\n${textFromContent(entry.content)}\n<<end-past-custom_message>>`);
			lastEntryId = entry.id;
		}
	}

	const text = `${chunks.join("\n\n")}\n\n<<end-of-transcript>>`;
	return {
		text,
		stats: {
			toolResults,
			userMessages,
			assistantMessages,
			serializedBytes: Buffer.byteLength(text, "utf8"),
		},
		lastEntryId,
	};
}

export function passesGate(slice: TranscriptSlice, settings: DistillSettings): boolean {
	return slice.stats.toolResults >= settings.minToolResults
		&& slice.stats.serializedBytes >= settings.minTranscriptBytes
		&& slice.stats.userMessages >= 1
		&& slice.stats.assistantMessages >= 1;
}
