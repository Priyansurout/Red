import type { ScheduleDatabase } from "./database.ts";
import { readCompletionHistory } from "./history.ts";
import { SCHEDULE_SESSION_DIR } from "./paths.ts";
import {
  validateProvenance,
  type ProvenanceInput,
  type ProvenanceValidationOptions,
} from "./provenance.ts";
import { parseRunAt, validateCron, validateTimezone, nextCronRun } from "./schedule-time.ts";
import type { Scheduler } from "./scheduler.ts";
import type { CompletionAcknowledgement, CompletionRecord, Schedule } from "./types.ts";

export interface CreateScheduleInput extends ProvenanceInput {
  instruction: string;
  runAt?: string;
  cron?: string;
  timezone?: string;
  permissionRequired?: boolean;
}

export class GatewayService {
  private readonly db: ScheduleDatabase;
  private readonly scheduler: Scheduler;
  private readonly now: () => number;
  private readonly completionHistoryRoot: string;
  private readonly provenanceOptions: ProvenanceValidationOptions;

  constructor(
    db: ScheduleDatabase,
    scheduler: Scheduler,
    now: () => number = Date.now,
    completionHistoryRoot: string = SCHEDULE_SESSION_DIR,
    provenanceOptions: ProvenanceValidationOptions = {},
  ) {
    this.db = db;
    this.scheduler = scheduler;
    this.now = now;
    this.completionHistoryRoot = completionHistoryRoot;
    this.provenanceOptions = provenanceOptions;
  }

  health(): { status: "ok"; now: string; schedules: number } {
    return { status: "ok", now: new Date(this.now()).toISOString(), schedules: this.db.list().length };
  }

  list(): Schedule[] {
    return this.db.list();
  }

  create(input: CreateScheduleInput): {
    schedule: Schedule;
    created: boolean;
    warning: string | null;
  } {
    if (typeof input.instruction !== "string" || !input.instruction.trim()) {
      throw new Error("instruction is required.");
    }
    if (input.instruction.length > 20_000) throw new Error("instruction is too long.");
    if ((input.runAt ? 1 : 0) + (input.cron ? 1 : 0) !== 1) {
      throw new Error("Provide exactly one of runAt or cron.");
    }
    if (input.permissionRequired !== undefined && typeof input.permissionRequired !== "boolean") {
      throw new Error("permissionRequired must be true or false.");
    }

    const now = this.now();
    const timezone = validateTimezone(input.timezone ?? "Asia/Kolkata");
    const cron = input.cron?.trim() || null;
    const nextRunAt = cron
      ? validateCron(cron, timezone, now)
      : parseRunAt(input.runAt as string, now);
    const provenance = validateProvenance(
      {
        sourceSessionId: input.sourceSessionId,
        sourceSessionFile: input.sourceSessionFile,
        sourceEntryId: input.sourceEntryId,
        toolCallId: input.toolCallId,
      },
      this.provenanceOptions,
    );
    const warning = this.db.countAt(nextRunAt) > 0
      ? "Another active schedule has the same next run time. Red will run them FIFO, one at a time."
      : null;
    const result = this.db.create(
      {
        id: provenance.scheduleId,
        instruction: input.instruction.trim(),
        timezone,
        cron,
        nextRunAt,
        permissionRequired: input.permissionRequired ?? false,
        sourceMessageRef: provenance.sourceMessageRef,
      },
      now,
    );
    void this.scheduler.tick();
    return { ...result, warning };
  }

  pause(id: string): Schedule {
    const schedule = this.requireSchedule(id);
    if (schedule.status !== "active") throw new Error(`Only an active schedule can be paused.`);
    return this.db.setControlStatus(id, "paused", this.now());
  }

  resume(id: string): Schedule {
    const now = this.now();
    const schedule = this.requireSchedule(id);
    if (schedule.status !== "paused") throw new Error("Only a paused schedule can be resumed.");
    if (schedule.cron) {
      const resumed = this.db.updateOccurrence(
        id,
        { status: "active", nextRunAt: nextCronRun(schedule.cron, schedule.timezone, now) },
        now,
      );
      void this.scheduler.tick();
      return resumed;
    }
    if (schedule.next_run_at === null || now > schedule.next_run_at + 120_000) {
      return this.db.updateOccurrence(
        id,
        {
          status: "expired",
          nextRunAt: null,
          lastRunStatus: "missed",
          lastRunReason: "paused_one_time_schedule_expired",
        },
        now,
      );
    }
    const resumed = this.db.setControlStatus(id, "active", now);
    void this.scheduler.tick();
    return resumed;
  }

  cancel(id: string): Schedule {
    const schedule = this.requireSchedule(id);
    if (!["active", "paused"].includes(schedule.status)) {
      throw new Error("Only an active or paused schedule can be cancelled.");
    }
    return this.db.setControlStatus(id, "cancelled", this.now());
  }

  approve(id: string): Schedule {
    return this.scheduler.approve(id);
  }

  deny(id: string): Schedule {
    return this.scheduler.deny(id);
  }

  history(id: string): { schedule: Schedule; completions: CompletionRecord[] } {
    const schedule = this.requireSchedule(id);
    return {
      schedule,
      completions: readCompletionHistory(this.completionHistoryRoot, id),
    };
  }

  inbox(): {
    approvals: Array<{
      scheduleId: string;
      instruction: string;
      scheduledFor: number;
      deadline: number;
    }>;
    completions: CompletionRecord[];
  } {
    const approvals = this.db.awaitingApproval().flatMap((schedule) =>
      schedule.last_run_at === null
        ? []
        : [{
            scheduleId: schedule.id,
            instruction: schedule.instruction,
            scheduledFor: schedule.last_run_at,
            deadline: schedule.last_run_at + 120_000,
          }],
    );
    const completions = this.db.list().flatMap((schedule) =>
      readCompletionHistory(this.completionHistoryRoot, schedule.id).filter(
        (record) => record.timestamp > (schedule.last_reported_at ?? 0),
      ),
    );
    return {
      approvals,
      completions: completions.sort(
        (a, b) => a.timestamp - b.timestamp || a.occurrenceId.localeCompare(b.occurrenceId),
      ),
    };
  }

  acknowledge(items: CompletionAcknowledgement[]): void {
    if (!Array.isArray(items) || items.length > 1000) throw new Error("Invalid acknowledgement list.");
    const durableBySchedule = new Map<string, Set<string>>();
    const validated = items.map((item) => {
      if (
        !item ||
        typeof item.scheduleId !== "string" ||
        typeof item.occurrenceId !== "string" ||
        !Number.isFinite(item.timestamp) ||
        !this.db.get(item.scheduleId)
      ) throw new Error("Invalid completion acknowledgement.");

      let durable = durableBySchedule.get(item.scheduleId);
      if (!durable) {
        durable = new Set(
          readCompletionHistory(this.completionHistoryRoot, item.scheduleId).map(
            (record) => `${record.occurrenceId}\u0000${record.timestamp}`,
          ),
        );
        durableBySchedule.set(item.scheduleId, durable);
      }
      if (!durable.has(`${item.occurrenceId}\u0000${item.timestamp}`)) {
        throw new Error("Completion acknowledgement does not match durable history.");
      }
      return item;
    });

    const now = this.now();
    this.db.transaction(() => {
      for (const item of validated) {
        this.db.markReported(item.scheduleId, item.timestamp, now);
      }
    });
  }

  private requireSchedule(id: string): Schedule {
    const schedule = this.db.get(id);
    if (!schedule) throw new Error(`Schedule not found: ${id}`);
    return schedule;
  }
}
