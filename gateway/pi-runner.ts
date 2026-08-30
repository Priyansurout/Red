import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { PI_AGENT_DIR, RED_ROOT, SCHEDULE_SESSION_DIR } from "./paths.ts";
import type { CompletionRecord, Schedule } from "./types.ts";

export interface ScheduledModelSelection {
  provider: string;
  modelId: string;
  thinkingLevel:
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max";
}

const EXCLUDED_TOOLS = [
  "bg_run",
  "bg_run_pi_attested",
  "bg_delegate",
  "bg_status",
  "bg_logs",
  "bg_result",
  "bg_kill",
  "fusion_launch",
  "fusion_delegate",
];

export function scheduledExtensionPaths(
  redRoot: string = RED_ROOT,
): string[] {
  return [
    join(redRoot, "extensions", "red-status.ts"),
    join(redRoot, "extensions", "red-time.ts"),
    join(redRoot, "extensions", "red-preferences.ts"),
    join(redRoot, ".pi", "npm", "node_modules", "pi-web-access", "index.ts"),
    join(redRoot, ".pi", "npm", "node_modules", "pi-mcp-adapter", "index.ts"),
  ];
}

export function scheduledModelSelection(
  settings: Pick<
    SettingsManager,
    "getDefaultProvider" | "getDefaultModel" | "getDefaultThinkingLevel"
  >,
): ScheduledModelSelection {
  const provider = settings.getDefaultProvider();
  const modelId = settings.getDefaultModel();
  if (!provider || !modelId) {
    throw new Error(
      "Red has no default model. Run pi, use /login and /model, then restart the gateway.",
    );
  }
  return {
    provider,
    modelId,
    thinkingLevel: settings.getDefaultThinkingLevel() ?? "medium",
  };
}

function desktopNotification(schedule: Schedule, status: CompletionRecord["status"]): void {
  const title = status === "succeeded" ? "Red schedule completed" : `Red schedule ${status}`;
  const body = `${schedule.id}: ${schedule.instruction.slice(0, 100)}`;
  const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
  const child = spawn("/usr/bin/osascript", ["-e", script], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", (error) => console.warn("Notification failed:", error.message));
  child.unref();
}

export class PiScheduleRunner {
  private readonly runtime: ModelRuntime;

  private constructor(runtime: ModelRuntime) {
    this.runtime = runtime;
  }

  static async create(): Promise<PiScheduleRunner> {
    const settings = SettingsManager.create(RED_ROOT, PI_AGENT_DIR, {
      projectTrusted: true,
    });
    const selection = scheduledModelSelection(settings);
    const runtime = await ModelRuntime.create({
      authPath: join(PI_AGENT_DIR, "auth.json"),
      modelsPath: join(PI_AGENT_DIR, "models.json"),
      refreshOnCreate: false,
    });
    if (!runtime.getModel(selection.provider, selection.modelId)) {
      throw new Error(
        `Configured model ${selection.provider}/${selection.modelId} is not available. ` +
        "Choose another model with /model or configure it in ~/.pi/agent/models.json.",
      );
    }
    return new PiScheduleRunner(runtime);
  }

  async run(schedule: Schedule, occurrenceId: string): Promise<void> {
    const sessionDir = join(SCHEDULE_SESSION_DIR, schedule.id);
    mkdirSync(sessionDir, { recursive: true });
    const manager = SessionManager.continueRecent(RED_ROOT, sessionDir);
    const settingsManager = SettingsManager.create(RED_ROOT, PI_AGENT_DIR, {
      projectTrusted: true,
    });
    const selection = scheduledModelSelection(settingsManager);
    const loader = new DefaultResourceLoader({
      cwd: RED_ROOT,
      agentDir: PI_AGENT_DIR,
      settingsManager,
      noExtensions: true,
      // Admission already enforced permission_required. Once an occurrence is
      // queued, its instruction and all nested tools are authorized as one unit.
      // The interactive permission gateway must never be loaded headlessly.
      additionalExtensionPaths: scheduledExtensionPaths(),
    });
    await loader.reload({ resolveProjectTrust: async () => true });

    const model = this.runtime.getModel(selection.provider, selection.modelId);
    if (!model) {
      throw new Error(
        `Configured model ${selection.provider}/${selection.modelId} is unavailable. ` +
        "Restart the gateway after changing custom model configuration.",
      );
    }

    const { session } = await createAgentSession({
      cwd: RED_ROOT,
      agentDir: PI_AGENT_DIR,
      modelRuntime: this.runtime,
      model,
      thinkingLevel: selection.thinkingLevel,
      sessionManager: manager,
      settingsManager,
      resourceLoader: loader,
      excludeTools: EXCLUDED_TOOLS,
    });

    const scheduledFor = schedule.last_run_at as number;
    const prompt = `<red_scheduled_occurrence id="${occurrenceId}" scheduled_for="${new Date(scheduledFor).toISOString()}">
This entire scheduled occurrence, including any nested tool calls, is authorized by Red.
Complete it synchronously in this session. Do not detach it into another background agent or task.

${schedule.instruction}
</red_scheduled_occurrence>`;

    let status: "succeeded" | "failed" = "succeeded";
    let result = "Scheduled instruction completed without a text response.";
    let caught: unknown;
    try {
      await session.prompt(prompt);
      result = session.getLastAssistantText()?.trim() || result;
    } catch (error) {
      status = "failed";
      result = error instanceof Error ? error.message : String(error);
      caught = error;
    } finally {
      const completion: CompletionRecord = {
        scheduleId: schedule.id,
        occurrenceId,
        scheduledFor,
        status,
        result: result.slice(0, 20_000),
        timestamp: Date.now(),
      };
      manager.appendCustomMessageEntry(
        "red-schedule-completion",
        `Scheduled occurrence ${occurrenceId} ${status}.`,
        false,
        completion,
      );
      session.dispose();
      desktopNotification(schedule, status);
    }
    if (caught) throw caught;
  }

  recordWithoutRun(
    schedule: Schedule,
    status: "failed" | "missed" | "denied",
    occurrenceId: string,
    reason: string,
  ): void {
    const sessionDir = join(SCHEDULE_SESSION_DIR, schedule.id);
    mkdirSync(sessionDir, { recursive: true });
    const manager = SessionManager.continueRecent(RED_ROOT, sessionDir);
    const record: CompletionRecord = {
      scheduleId: schedule.id,
      occurrenceId,
      scheduledFor: schedule.last_run_at ?? Date.now(),
      status,
      result: reason,
      timestamp: Date.now(),
    };
    manager.appendCustomMessageEntry(
      "red-schedule-completion",
      `Scheduled occurrence ${occurrenceId} ${status}.`,
      false,
      record,
    );
    desktopNotification(schedule, status);
  }
}
