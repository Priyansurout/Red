import type { CompletionAcknowledgement, CompletionRecord } from "../gateway/types.ts";

export const SCHEDULE_RESULTS_CUSTOM_TYPE = "red-schedule-results";

export interface ScheduleResultMessageDetails {
  occurrenceIds: string[];
  acknowledgements: CompletionAcknowledgement[];
}

interface SessionEntryLike {
  type?: string;
  customType?: string;
  details?: unknown;
  message?: {
    customType?: string;
    details?: unknown;
  };
}

function detailsFromEntry(value: unknown): ScheduleResultMessageDetails | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as SessionEntryLike;
  const customType = entry.customType ?? entry.message?.customType;
  if (customType !== SCHEDULE_RESULTS_CUSTOM_TYPE) return undefined;

  const details = (entry.details ?? entry.message?.details) as
    | Partial<ScheduleResultMessageDetails>
    | undefined;
  if (!details || !Array.isArray(details.occurrenceIds)) return undefined;

  return {
    occurrenceIds: details.occurrenceIds.filter(
      (occurrenceId): occurrenceId is string => typeof occurrenceId === "string",
    ),
    acknowledgements: Array.isArray(details.acknowledgements)
      ? details.acknowledgements.filter(
          (item): item is CompletionAcknowledgement =>
            !!item &&
            typeof item.scheduleId === "string" &&
            typeof item.occurrenceId === "string" &&
            typeof item.timestamp === "number" &&
            Number.isFinite(item.timestamp),
        )
      : [],
  };
}

export function persistedScheduleResultIds(entries: readonly unknown[]): Set<string> {
  const occurrenceIds = new Set<string>();
  for (const entry of entries) {
    const details = detailsFromEntry(entry);
    if (!details) continue;
    for (const occurrenceId of details.occurrenceIds) occurrenceIds.add(occurrenceId);
  }
  return occurrenceIds;
}

export function completionAcknowledgement(
  record: CompletionRecord,
): CompletionAcknowledgement {
  return {
    scheduleId: record.scheduleId,
    occurrenceId: record.occurrenceId,
    timestamp: record.timestamp,
  };
}

export class CompletionDeliveryTracker {
  private readonly queuedOccurrenceIds = new Set<string>();
  private readonly acknowledgedOccurrenceIds = new Set<string>();

  isQueued(occurrenceId: string): boolean {
    return this.queuedOccurrenceIds.has(occurrenceId);
  }

  syncInbox(records: CompletionRecord[]): void {
    const current = new Set(records.map((record) => record.occurrenceId));
    for (const occurrenceId of this.queuedOccurrenceIds) {
      if (!current.has(occurrenceId)) this.queuedOccurrenceIds.delete(occurrenceId);
    }
    for (const occurrenceId of this.acknowledgedOccurrenceIds) {
      if (!current.has(occurrenceId)) this.acknowledgedOccurrenceIds.delete(occurrenceId);
    }
  }

  markQueued(records: CompletionRecord[]): void {
    for (const record of records) this.queuedOccurrenceIds.add(record.occurrenceId);
  }

  markUnqueued(records: CompletionRecord[]): void {
    for (const record of records) this.queuedOccurrenceIds.delete(record.occurrenceId);
  }

  markAcknowledged(items: CompletionAcknowledgement[]): void {
    for (const item of items) {
      this.queuedOccurrenceIds.delete(item.occurrenceId);
      this.acknowledgedOccurrenceIds.add(item.occurrenceId);
    }
  }

  pendingForDelivery(
    records: CompletionRecord[],
    persistedOccurrenceIds: Set<string>,
  ): CompletionRecord[] {
    return records.filter(
      (record) =>
        !persistedOccurrenceIds.has(record.occurrenceId) &&
        !this.acknowledgedOccurrenceIds.has(record.occurrenceId) &&
        !this.queuedOccurrenceIds.has(record.occurrenceId),
    );
  }

  persistedAcknowledgements(
    records: CompletionRecord[],
    persistedOccurrenceIds: Set<string>,
  ): CompletionAcknowledgement[] {
    return records
      .filter(
        (record) =>
          persistedOccurrenceIds.has(record.occurrenceId) &&
          !this.acknowledgedOccurrenceIds.has(record.occurrenceId),
      )
      .map(completionAcknowledgement);
  }

  clearUnpersisted(persistedOccurrenceIds: Set<string>): void {
    for (const occurrenceId of this.queuedOccurrenceIds) {
      if (!persistedOccurrenceIds.has(occurrenceId)) {
        this.queuedOccurrenceIds.delete(occurrenceId);
      }
    }
  }
}
