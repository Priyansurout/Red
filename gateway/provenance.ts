import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { relative, sep } from "node:path";

import { PI_SESSION_ROOT, RED_ROOT } from "./paths.ts";

export interface ProvenanceInput {
  sourceSessionId: string;
  sourceSessionFile: string;
  sourceEntryId: string;
  toolCallId: string;
}

export interface ValidatedProvenance {
  scheduleId: string;
  sourceMessageRef: string;
}

export interface ProvenanceValidationOptions {
  sessionRoot?: string;
  cwd?: string;
}

export function validateProvenance(
  input: ProvenanceInput,
  options: ProvenanceValidationOptions = {},
): ValidatedProvenance {
  for (const name of [
    "sourceSessionId",
    "sourceSessionFile",
    "sourceEntryId",
    "toolCallId",
  ] as const) {
    const value = input[name];
    if (typeof value !== "string" || value.length === 0 || value.length > 1000) {
      throw new Error(`Invalid provenance field: ${name}`);
    }
  }

  const root = realpathSync(options.sessionRoot ?? PI_SESSION_ROOT);
  const sessionFile = realpathSync(input.sourceSessionFile);
  const pathFromRoot = relative(root, sessionFile);
  if (pathFromRoot.startsWith(".." + sep) || pathFromRoot === ".." || pathFromRoot === "") {
    throw new Error("The source must be a persisted Pi session under ~/.pi/agent/sessions.");
  }

  const lines = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean);
  const header = JSON.parse(lines[0] ?? "null") as Record<string, unknown> | null;
  if (
    !header ||
    header.type !== "session" ||
    header.id !== input.sourceSessionId ||
    header.cwd !== (options.cwd ?? RED_ROOT)
  ) {
    throw new Error("The source Pi session identity or Red working directory is invalid.");
  }

  let foundUserMessage = false;
  let toolCallEntryId: string | undefined;
  const parents = new Map<string, string | null>();
  for (const raw of lines.slice(1)) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof entry.id === "string") {
      parents.set(entry.id, typeof entry.parentId === "string" ? entry.parentId : null);
    }
    if (entry.type !== "message") continue;
    const message = entry.message as Record<string, unknown> | undefined;
    if (entry.id === input.sourceEntryId) foundUserMessage = message?.role === "user";
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const hasToolCall = message.content.some((part) => {
      if (!part || typeof part !== "object") return false;
      const content = part as Record<string, unknown>;
      return content.type === "toolCall" && content.id === input.toolCallId && content.name === "schedule_create";
    });
    if (hasToolCall && typeof entry.id === "string") toolCallEntryId = entry.id;
  }
  if (!foundUserMessage) throw new Error("The source entry is not a real Pi user message.");
  if (!toolCallEntryId) throw new Error("The request is not a persisted schedule_create Pi tool call.");
  let ancestor: string | null | undefined = toolCallEntryId;
  let belongsToSource = false;
  while (ancestor) {
    if (ancestor === input.sourceEntryId) {
      belongsToSource = true;
      break;
    }
    ancestor = parents.get(ancestor);
  }
  if (!belongsToSource) throw new Error("The schedule tool call does not belong to the source user message.");

  const sourceMessageRef = `${input.sourceSessionId}:${input.sourceEntryId}`;
  const digest = createHash("sha256")
    .update(`${sourceMessageRef}:${input.toolCallId}`)
    .digest("hex")
    .slice(0, 16);
  return { scheduleId: `sch_${digest}`, sourceMessageRef };
}
