import type { ScheduleDatabase } from "./database.ts";
import { nextCronRun } from "./schedule-time.ts";
import type { Schedule } from "./types.ts";

export const POLL_INTERVAL_MS = 15_000;
export const MISFIRE_GRACE_MS = 120_000;

export type ScheduleRunner = (schedule: Schedule, occurrenceId: string) => Promise<void>;

export interface SchedulerOptions {
  now?: () => number;
  run: ScheduleRunner;
  onError?: (error: unknown) => void;
  onTerminalWithoutRun?: (
    schedule: Schedule,
    status: "failed" | "missed" | "denied",
    occurrenceId: string,
    reason: string,
  ) => void;
}

export class Scheduler {
  private readonly db: ScheduleDatabase;
  private readonly now: () => number;
  private readonly runSchedule: ScheduleRunner;
  private readonly onError: (error: unknown) => void;
  private readonly onTerminalWithoutRun: NonNullable<SchedulerOptions["onTerminalWithoutRun"]>;
  private timer: NodeJS.Timeout | undefined;
  private workerBusy = false;
  private ticking = false;

  constructor(db: ScheduleDatabase, options: SchedulerOptions) {
    this.db = db;
    this.now = options.now ?? Date.now;
    this.runSchedule = options.run;
    this.onError = options.onError ?? ((error) => console.error(error));
    this.onTerminalWithoutRun = options.onTerminalWithoutRun ?? (() => undefined);
  }

  start(): void {
    this.recoverInterruptedRuns();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  recoverInterruptedRuns(): void {
    const now = this.now();
    for (const schedule of this.db.list().filter((row) => row.last_run_status === "running")) {
      const updated = this.db.updateOccurrence(
        schedule.id,
        {
          status:
            schedule.cron === null && schedule.status === "active"
              ? "completed"
              : schedule.status,
          lastRunStatus: "failed",
          lastRunReason: "gateway_restarted_during_execution",
        },
        now,
      );
      this.recordWithoutRun(
        updated,
        "failed",
        `schedule:${schedule.id}:${schedule.last_run_at ?? now}`,
        "gateway_restarted_during_execution",
      );
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      this.expireApprovalRequests(now);
      for (const schedule of this.db.due(now)) this.admitDue(schedule, now);
      this.kickWorker();
    } catch (error) {
      // A polling or database failure is operational. It must never mutate a
      // schedule to cancelled; the next 15-second scan retries it.
      this.onError(error);
    } finally {
      this.ticking = false;
    }
  }

  private expireApprovalRequests(now: number): void {
    for (const schedule of this.db.awaitingApproval()) {
      const occurrence = schedule.last_run_at;
      if (occurrence === null || now <= occurrence + MISFIRE_GRACE_MS) continue;
      this.finishWithoutRun(schedule, "missed", "approval_not_received_within_grace", now);
    }
  }

  private admitDue(schedule: Schedule, now: number): void {
    const due = schedule.next_run_at;
    if (due === null) return;

    if (now > due + MISFIRE_GRACE_MS) {
      this.finishWithoutRun(schedule, "missed", "gateway_unavailable_past_grace", now);
      return;
    }

    if (schedule.permission_required) {
      this.db.updateOccurrence(
        schedule.id,
        {
          lastRunAt: due,
          lastRunStatus: "awaiting_approval",
          lastRunReason: null,
        },
        now,
      );
      return;
    }

    this.queue(schedule, due, now);
  }

  private nextAfterOccurrence(schedule: Schedule, occurrence: number): number | null {
    return schedule.cron
      ? nextCronRun(schedule.cron, schedule.timezone, occurrence)
      : null;
  }

  private nextAfterNow(schedule: Schedule, now: number): number | null {
    return schedule.cron
      ? nextCronRun(schedule.cron, schedule.timezone, now)
      : null;
  }

  private queue(schedule: Schedule, occurrence: number, now: number): void {
    this.db.updateOccurrence(
      schedule.id,
      {
        nextRunAt: this.nextAfterOccurrence(schedule, occurrence),
        lastRunAt: occurrence,
        lastRunStatus: "queued",
        lastRunReason: null,
      },
      now,
    );
  }

  private recordWithoutRun(
    schedule: Schedule,
    status: "failed" | "missed" | "denied",
    occurrenceId: string,
    reason: string,
  ): void {
    try {
      this.onTerminalWithoutRun(schedule, status, occurrenceId, reason);
    } catch (error) {
      this.onError(error);
    }
  }

  private finishWithoutRun(
    schedule: Schedule,
    result: "missed" | "denied",
    reason: string,
    now: number,
  ): void {
    const occurrence = schedule.last_run_at ?? schedule.next_run_at;
    if (occurrence === null) return;
    const recurring = schedule.cron !== null;
    const updated = this.db.updateOccurrence(
      schedule.id,
      {
        nextRunAt: recurring ? this.nextAfterNow(schedule, now) : null,
        status: recurring ? schedule.status : result === "denied" ? "cancelled" : "expired",
        lastRunAt: occurrence,
        lastRunStatus: result,
        lastRunReason: reason,
      },
      now,
    );
    this.recordWithoutRun(
      updated,
      result,
      `schedule:${schedule.id}:${occurrence}`,
      reason,
    );
  }

  approve(id: string): Schedule {
    const now = this.now();
    const schedule = this.requireAwaiting(id);
    const occurrence = schedule.last_run_at as number;
    if (now > occurrence + MISFIRE_GRACE_MS) {
      this.finishWithoutRun(schedule, "missed", "approval_not_received_within_grace", now);
      throw new Error("Approval arrived after the two-minute grace period.");
    }
    this.queue(schedule, occurrence, now);
    this.kickWorker();
    return this.db.get(id) as Schedule;
  }

  deny(id: string): Schedule {
    const now = this.now();
    const schedule = this.requireAwaiting(id);
    this.finishWithoutRun(schedule, "denied", "user_denied", now);
    return this.db.get(id) as Schedule;
  }

  private requireAwaiting(id: string): Schedule {
    const schedule = this.db.get(id);
    if (!schedule) throw new Error(`Schedule not found: ${id}`);
    if (schedule.last_run_status !== "awaiting_approval") {
      throw new Error(`Schedule ${id} is not awaiting approval.`);
    }
    return schedule;
  }

  private kickWorker(): void {
    if (this.workerBusy) return;
    const schedule = this.db.nextQueued();
    if (!schedule || schedule.last_run_at === null) return;

    this.workerBusy = true;
    const occurrence = schedule.last_run_at;
    const occurrenceId = `schedule:${schedule.id}:${occurrence}`;
    this.db.updateOccurrence(
      schedule.id,
      { lastRunStatus: "running", lastRunReason: null },
      this.now(),
    );

    void this.runSchedule(this.db.get(schedule.id) as Schedule, occurrenceId)
      .then(() => this.finishWorker(schedule.id, "succeeded", null))
      .catch((error) =>
        this.finishWorker(
          schedule.id,
          "failed",
          error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
        ),
      )
      .finally(() => {
        this.workerBusy = false;
        this.kickWorker();
      });
  }

  private finishWorker(
    id: string,
    result: "succeeded" | "failed",
    reason: string | null,
  ): void {
    const schedule = this.db.get(id);
    if (!schedule) return;
    this.db.updateOccurrence(
      id,
      {
        status:
          schedule.cron === null && schedule.status === "active"
            ? "completed"
            : schedule.status,
        lastRunStatus: result,
        lastRunReason: reason,
      },
      this.now(),
    );
  }
}
