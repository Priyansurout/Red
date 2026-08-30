import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { CompletionRecord } from "./types.ts";

interface JsonLine {
  type?: string;
  timestamp?: string;
  customType?: string;
  details?: unknown;
  message?: {
    role?: string;
    customType?: string;
    details?: unknown;
  };
}

function completionFromLine(line: JsonLine): CompletionRecord | undefined {
  if (line.type !== "custom_message" && line.type !== "message") return undefined;
  const customType = line.customType ?? line.message?.customType;
  if (customType !== "red-schedule-completion") return undefined;
  const details = (line.details ?? line.message?.details) as Partial<CompletionRecord> | undefined;
  if (
    !details ||
    typeof details.scheduleId !== "string" ||
    typeof details.occurrenceId !== "string" ||
    typeof details.scheduledFor !== "number" ||
    !["succeeded", "failed", "missed", "denied"].includes(details.status ?? "") ||
    typeof details.result !== "string"
  ) return undefined;
  const lineTimestamp = line.timestamp ? Date.parse(line.timestamp) : Number.NaN;
  return {
    scheduleId: details.scheduleId,
    occurrenceId: details.occurrenceId,
    scheduledFor: details.scheduledFor,
    status: details.status as CompletionRecord["status"],
    result: details.result,
    timestamp:
      typeof details.timestamp === "number"
        ? details.timestamp
        : Number.isFinite(lineTimestamp)
          ? lineTimestamp
          : details.scheduledFor,
  };
}

export function readCompletionHistory(sessionRoot: string, scheduleId: string): CompletionRecord[] {
  const directory = join(sessionRoot, scheduleId);
  if (!existsSync(directory)) return [];
  const records: CompletionRecord[] = [];
  for (const filename of readdirSync(directory).filter((name) => name.endsWith(".jsonl")).sort()) {
    const lines = readFileSync(join(directory, filename), "utf8").split("\n");
    for (const raw of lines) {
      if (!raw.trim()) continue;
      try {
        const record = completionFromLine(JSON.parse(raw) as JsonLine);
        if (record) records.push(record);
      } catch {
        // A partial final JSONL line can exist while Pi is writing. The next
        // inbox poll will retry it.
      }
    }
  }
  return records.sort((a, b) => a.timestamp - b.timestamp || a.occurrenceId.localeCompare(b.occurrenceId));
}
