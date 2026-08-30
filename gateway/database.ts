import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { NewSchedule, RunStatus, Schedule, ScheduleStatus } from "./types.ts";

type DbRow = Omit<Schedule, "permission_required"> & {
  permission_required: number;
};

function scheduleFromRow(row: DbRow | undefined): Schedule | undefined {
  return row ? { ...row, permission_required: row.permission_required === 1 } : undefined;
}
export class ScheduleDatabase {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL");
    this.raw.exec("PRAGMA busy_timeout = 5000");
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id                  TEXT PRIMARY KEY,
        instruction         TEXT NOT NULL,
        timezone            TEXT NOT NULL,
        cron                TEXT NULL,
        next_run_at         INTEGER NULL,
        status              TEXT NOT NULL CHECK (status IN ('active','paused','cancelled','completed','expired')),
        permission_required INTEGER NOT NULL CHECK (permission_required IN (0,1)),
        source_message_ref  TEXT NOT NULL,
        last_run_at         INTEGER NULL,
        last_run_status     TEXT NULL CHECK (last_run_status IS NULL OR last_run_status IN ('awaiting_approval','queued','running','succeeded','failed','missed','denied')),
        last_run_reason     TEXT NULL,
        last_reported_at    INTEGER NULL,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS schedules_due_idx
        ON schedules(status, next_run_at);
    `);
  }

  close(): void {
    this.raw.close();
  }

  transaction<T>(operation: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  applicationTables(): string[] {
    return (this.raw.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string }>).map((row) => row.name);
  }

  create(input: NewSchedule, now: number): { schedule: Schedule; created: boolean } {
    return this.transaction(() => {
      const existing = this.get(input.id);
      if (existing) {
        const same =
          existing.instruction === input.instruction &&
          existing.timezone === input.timezone &&
          existing.cron === input.cron &&
          existing.permission_required === input.permissionRequired &&
          existing.source_message_ref === input.sourceMessageRef;
        if (!same) throw new Error("That Pi tool call already created a different schedule.");
        return { schedule: existing, created: false };
      }

      this.raw.prepare(`
        INSERT INTO schedules (
          id, instruction, timezone, cron, next_run_at, status,
          permission_required, source_message_ref, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
      `).run(
        input.id,
        input.instruction,
        input.timezone,
        input.cron,
        input.nextRunAt,
        input.permissionRequired ? 1 : 0,
        input.sourceMessageRef,
        now,
        now,
      );
      return { schedule: this.get(input.id) as Schedule, created: true };
    });
  }

  get(id: string): Schedule | undefined {
    return scheduleFromRow(
      this.raw.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as DbRow | undefined,
    );
  }

  list(): Schedule[] {
    return (this.raw.prepare(
      "SELECT * FROM schedules ORDER BY created_at DESC, id DESC",
    ).all() as DbRow[]).map((row) => scheduleFromRow(row) as Schedule);
  }

  due(now: number): Schedule[] {
    return (this.raw.prepare(`
      SELECT * FROM schedules
      WHERE status = 'active'
        AND next_run_at IS NOT NULL
        AND next_run_at <= ?
        AND (last_run_status IS NULL OR last_run_status NOT IN ('awaiting_approval','queued','running'))
      ORDER BY next_run_at, created_at, id
    `).all(now) as DbRow[]).map((row) => scheduleFromRow(row) as Schedule);
  }

  awaitingApproval(): Schedule[] {
    return (this.raw.prepare(`
      SELECT * FROM schedules
      WHERE last_run_status = 'awaiting_approval'
      ORDER BY last_run_at, created_at, id
    `).all() as DbRow[]).map((row) => scheduleFromRow(row) as Schedule);
  }

  nextQueued(): Schedule | undefined {
    return scheduleFromRow(this.raw.prepare(`
      SELECT * FROM schedules
      WHERE last_run_status = 'queued'
      ORDER BY last_run_at, created_at, id
      LIMIT 1
    `).get() as DbRow | undefined);
  }

  countAt(nextRunAt: number, exceptId?: string): number {
    const row = exceptId
      ? this.raw.prepare(`
          SELECT COUNT(*) AS count FROM schedules
          WHERE status = 'active' AND next_run_at = ? AND id != ?
        `).get(nextRunAt, exceptId)
      : this.raw.prepare(`
          SELECT COUNT(*) AS count FROM schedules
          WHERE status = 'active' AND next_run_at = ?
        `).get(nextRunAt);
    return Number((row as { count: number }).count);
  }

  setControlStatus(id: string, status: ScheduleStatus, now: number, reason: string | null = null): Schedule {
    this.raw.prepare(`
      UPDATE schedules
      SET status = ?, last_run_reason = COALESCE(?, last_run_reason), updated_at = ?
      WHERE id = ?
    `).run(status, reason, now, id);
    const schedule = this.get(id);
    if (!schedule) throw new Error(`Schedule not found: ${id}`);
    return schedule;
  }

  updateOccurrence(
    id: string,
    values: {
      nextRunAt?: number | null;
      status?: ScheduleStatus;
      lastRunAt?: number | null;
      lastRunStatus?: RunStatus | null;
      lastRunReason?: string | null;
    },
    now: number,
  ): Schedule {
    const current = this.get(id);
    if (!current) throw new Error(`Schedule not found: ${id}`);
    const next = {
      nextRunAt: values.nextRunAt === undefined ? current.next_run_at : values.nextRunAt,
      status: values.status === undefined ? current.status : values.status,
      lastRunAt: values.lastRunAt === undefined ? current.last_run_at : values.lastRunAt,
      lastRunStatus:
        values.lastRunStatus === undefined ? current.last_run_status : values.lastRunStatus,
      lastRunReason:
        values.lastRunReason === undefined ? current.last_run_reason : values.lastRunReason,
    };
    this.raw.prepare(`
      UPDATE schedules SET
        next_run_at = ?, status = ?, last_run_at = ?, last_run_status = ?,
        last_run_reason = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.nextRunAt,
      next.status,
      next.lastRunAt,
      next.lastRunStatus,
      next.lastRunReason,
      now,
      id,
    );
    return this.get(id) as Schedule;
  }

  markReported(id: string, timestamp: number, now: number): void {
    this.raw.prepare(`
      UPDATE schedules
      SET last_reported_at = MAX(COALESCE(last_reported_at, 0), ?), updated_at = ?
      WHERE id = ?
    `).run(timestamp, now, id);
  }
}
