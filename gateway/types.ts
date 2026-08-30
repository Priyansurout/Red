export const SCHEDULE_STATUSES = [
  "active",
  "paused",
  "cancelled",
  "completed",
  "expired",
] as const;

export const RUN_STATUSES = [
  "awaiting_approval",
  "queued",
  "running",
  "succeeded",
  "failed",
  "missed",
  "denied",
] as const;

export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface Schedule {
  id: string;
  instruction: string;
  timezone: string;
  cron: string | null;
  next_run_at: number | null;
  status: ScheduleStatus;
  permission_required: boolean;
  source_message_ref: string;
  last_run_at: number | null;
  last_run_status: RunStatus | null;
  last_run_reason: string | null;
  last_reported_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface NewSchedule {
  id: string;
  instruction: string;
  timezone: string;
  cron: string | null;
  nextRunAt: number;
  permissionRequired: boolean;
  sourceMessageRef: string;
}

export interface CompletionRecord {
  scheduleId: string;
  occurrenceId: string;
  scheduledFor: number;
  status: "succeeded" | "failed" | "missed" | "denied";
  result: string;
  timestamp: number;
}

export interface CompletionAcknowledgement {
  scheduleId: string;
  occurrenceId: string;
  timestamp: number;
}
