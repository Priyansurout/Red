import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { gatewayRequest } from "../gateway/client.ts";
import type {
  CompletionAcknowledgement,
  CompletionRecord,
  Schedule,
} from "../gateway/types.ts";
import {
  CompletionDeliveryTracker,
  SCHEDULE_RESULTS_CUSTOM_TYPE,
  completionAcknowledgement,
  persistedScheduleResultIds,
  type ScheduleResultMessageDetails,
} from "./schedule-completion-delivery.ts";

interface Inbox {
  approvals: Array<{
    scheduleId: string;
    instruction: string;
    scheduledFor: number;
    deadline: number;
  }>;
  completions: CompletionRecord[];
}

interface CreateResult {
  schedule: Schedule;
  created: boolean;
  warning: string | null;
}

function textResult(text: string, details: unknown = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

export function scheduleLine(schedule: Schedule): string {
  const next = schedule.next_run_at === null
    ? "no future run"
    : new Date(schedule.next_run_at).toLocaleString("en-IN", { timeZone: schedule.timezone });
  const permission = schedule.permission_required ? "approval required" : "pre-approved";
  const last = schedule.last_run_status === null
    ? "never run"
    : `${schedule.last_run_status}${schedule.last_run_reason ? ` (${schedule.last_run_reason})` : ""}`;
  return `${schedule.id} | ${schedule.status} | ${permission} | next: ${next} | last: ${last} | ${schedule.instruction.slice(0, 100)}`;
}

export function scheduleHistoryText(
  history: { schedule: Schedule; completions: CompletionRecord[] },
): string {
  const records = history.completions.length === 0
    ? "No completed executions yet."
    : history.completions.map((record) =>
        `${new Date(record.scheduledFor).toISOString()} | ${record.status} | ${record.result.slice(0, 500)}`,
      ).join("\n");
  return `${scheduleLine(history.schedule)}\n${records}`;
}

function sourceFor(ctx: ExtensionContext): {
  sourceSessionId: string;
  sourceSessionFile: string;
  sourceEntryId: string;
} {
  const sourceSessionFile = ctx.sessionManager.getSessionFile();
  if (!sourceSessionFile) {
    throw new Error("Scheduling requires a persisted Pi session; --no-session cannot create schedules.");
  }
  const entries = ctx.sessionManager.getBranch();
  const source = entries.toReversed().find((entry) => {
    if (entry.type !== "message") return false;
    return entry.message.role === "user";
  });
  if (!source || typeof source.id !== "string") {
    throw new Error("Could not find the source user message in this Pi session.");
  }
  return {
    sourceSessionId: ctx.sessionManager.getSessionId(),
    sourceSessionFile,
    sourceEntryId: source.id,
  };
}

function idParameters() {
  return Type.Object({
    id: Type.String({ description: "Schedule ID", minLength: 5, maxLength: 100 }),
  });
}

export default function redSchedulerExtension(pi: ExtensionAPI) {
  let timer: NodeJS.Timeout | undefined;
  let polling = false;
  let askingPermission = false;
  const delivery = new CompletionDeliveryTracker();

  function persistedOccurrenceIds(ctx: ExtensionContext): Set<string> {
    return persistedScheduleResultIds(ctx.sessionManager.getBranch());
  }

  async function acknowledge(items: CompletionAcknowledgement[]): Promise<void> {
    for (let offset = 0; offset < items.length; offset += 250) {
      const batch = items.slice(offset, offset + 250);
      await gatewayRequest("POST", "/inbox/ack", { items: batch });
      delivery.markAcknowledged(batch);
    }
  }

  async function pollInbox(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI || polling) return;
    polling = true;
    try {
      const inbox = await gatewayRequest<Inbox>("GET", "/inbox", undefined, 1500);
      delivery.syncInbox(inbox.completions);

      if (!askingPermission && inbox.approvals.length > 0) {
        askingPermission = true;
        const approval = inbox.approvals[0];
        try {
          const allowed = await ctx.ui.confirm(
            "Run scheduled instruction?",
            `${approval.instruction}\n\nSchedule: ${approval.scheduleId}\nDeadline: ${new Date(approval.deadline).toLocaleString()}`,
          );
          await gatewayRequest(
            "POST",
            `/schedules/${encodeURIComponent(approval.scheduleId)}/${allowed ? "approve" : "deny"}`,
          );
          ctx.ui.notify(allowed ? "Scheduled instruction approved." : "Scheduled instruction denied.", "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
        } finally {
          askingPermission = false;
        }
      }

      if (inbox.completions.length > 0) {
        const persisted = persistedOccurrenceIds(ctx);
        await acknowledge(delivery.persistedAcknowledgements(inbox.completions, persisted));

        const pending = delivery.pendingForDelivery(inbox.completions, persisted);
        if (pending.length === 0) return;

        const body = pending.map((record) =>
          [
            `<scheduled-result id="${record.occurrenceId}" status="${record.status}">`,
            record.result,
            "</scheduled-result>",
          ].join("\n"),
        ).join("\n\n");
        const details: ScheduleResultMessageDetails = {
          occurrenceIds: pending.map((record) => record.occurrenceId),
          acknowledgements: pending.map(completionAcknowledgement),
        };
        delivery.markQueued(pending);
        try {
          pi.sendMessage(
            {
              customType: SCHEDULE_RESULTS_CUSTOM_TYPE,
              content:
                `<red-schedule-results>\n${body}\nThese scheduled tasks have already executed. Report only the results naturally and concisely; do not repeat the instructions or call tools for them.\n</red-schedule-results>`,
              display: false,
              details,
            },
            { deliverAs: "followUp", triggerTurn: true },
          );
        } catch (error) {
          delivery.markUnqueued(pending);
          throw error;
        }
      }
    } catch {
      // The gateway can be restarting. /red-status exposes health; the next
      // two-second UI poll retries without interrupting the conversation.
    } finally {
      polling = false;
    }
  }

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    if (timer) clearInterval(timer);
    delivery.clearUnpersisted(persistedOccurrenceIds(ctx));
    void pollInbox(ctx);
    timer = setInterval(() => void pollInbox(ctx), 2000);
    timer.unref?.();
  });

  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  });

  pi.on("agent_settled", (_event, ctx) => {
    // Escape/abort clears Pi's in-memory follow-up queue. Anything that did not
    // reach the persisted branch becomes deliverable again on the next poll.
    delivery.clearUnpersisted(persistedOccurrenceIds(ctx));
  });

  pi.registerCommand("schedules", {
    description: "List Red schedules",
    handler: async (_args, ctx) => {
      try {
        const schedules = await gatewayRequest<Schedule[]>("GET", "/schedules");
        ctx.ui.notify(
          schedules.length === 0 ? "No schedules." : schedules.map(scheduleLine).join("\n"),
          "info",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("schedule-history", {
    description: "Read schedule history without starting a model turn",
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!id) {
        ctx.ui.notify("Usage: /schedule-history <id>", "warning");
        return;
      }
      try {
        const history = await gatewayRequest<{ schedule: Schedule; completions: CompletionRecord[] }>(
          "GET",
          `/schedules/${encodeURIComponent(id)}/history`,
        );
        ctx.ui.notify(scheduleHistoryText(history), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "schedule_create",
    label: "Create Schedule",
    description:
      "Create a durable one-time or recurring Red schedule when the user explicitly requests scheduled execution.",
    promptSnippet: "Create a durable local schedule",
    promptGuidelines: [
      "Call schedule_create only after the user explicitly asks for scheduled execution.",
      "Use permissionRequired false by default; set it true only when the user asks to approve at execution time.",
      "permissionRequired false authorizes the entire future occurrence, including its nested tools; creating or confirming it must not execute the instruction now.",
      "permissionRequired true asks once when due; approval authorizes the entire occurrence without nested tool prompts.",
      "Use runAt for one-time work or a five-field cron expression for recurring work, never both.",
    ],
    parameters: Type.Object({
      instruction: Type.String({ description: "What Red should do when the schedule fires", minLength: 1, maxLength: 20000 }),
      runAt: Type.Optional(Type.String({ description: "One-time ISO 8601 timestamp with Z or UTC offset" })),
      cron: Type.Optional(Type.String({ description: "Recurring five-field cron: minute hour day month weekday" })),
      timezone: Type.Optional(Type.String({ description: "IANA timezone; defaults to Asia/Kolkata" })),
      permissionRequired: Type.Optional(Type.Boolean({ description: "Ask in the open Pi UI when due; defaults to false" })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = await gatewayRequest<CreateResult>("POST", "/schedules", {
          ...params,
          ...sourceFor(ctx),
          toolCallId,
        });
        const prefix = result.created ? "Created" : "Already created";
        return textResult(
          `${prefix} ${scheduleLine(result.schedule)}${result.warning ? `\nWarning: ${result.warning}` : ""}`,
          result,
        );
      } catch (error) {
        return textResult(`Schedule creation failed: ${error instanceof Error ? error.message : String(error)}`, { error: true });
      }
    },
  });

  pi.registerTool({
    name: "schedule_list",
    label: "List Schedules",
    description: "List all Red schedules, including paused, cancelled, completed, and expired rows.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const schedules = await gatewayRequest<Schedule[]>("GET", "/schedules");
        return textResult(schedules.length === 0 ? "No schedules." : schedules.map(scheduleLine).join("\n"), { schedules });
      } catch (error) {
        return textResult(`Could not list schedules: ${error instanceof Error ? error.message : String(error)}`, { error: true });
      }
    },
  });

  for (const action of ["pause", "resume", "cancel"] as const) {
    pi.registerTool({
      name: `schedule_${action}`,
      label: `${action[0].toUpperCase()}${action.slice(1)} Schedule`,
      description: `${action[0].toUpperCase()}${action.slice(1)} a Red schedule. Use only when the user explicitly requests this change.`,
      parameters: idParameters(),
      async execute(_toolCallId, params) {
        try {
          const schedule = await gatewayRequest<Schedule>(
            "POST",
            `/schedules/${encodeURIComponent(params.id)}/${action}`,
          );
          return textResult(`${action[0].toUpperCase()}${action.slice(1)}d ${scheduleLine(schedule)}`, { schedule });
        } catch (error) {
          return textResult(`Could not ${action} schedule: ${error instanceof Error ? error.message : String(error)}`, { error: true });
        }
      },
    });
  }

  pi.registerTool({
    name: "schedule_history",
    label: "Schedule History",
    description: "Read one schedule and its durable Pi-session completion history.",
    parameters: idParameters(),
    async execute(_toolCallId, params) {
      try {
        const history = await gatewayRequest<{ schedule: Schedule; completions: CompletionRecord[] }>(
          "GET",
          `/schedules/${encodeURIComponent(params.id)}/history`,
        );
        return textResult(scheduleHistoryText(history), history);
      } catch (error) {
        return textResult(`Could not read schedule history: ${error instanceof Error ? error.message : String(error)}`, { error: true });
      }
    },
  });
}
