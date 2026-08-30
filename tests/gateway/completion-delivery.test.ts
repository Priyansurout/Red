import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CompletionDeliveryTracker,
  SCHEDULE_RESULTS_CUSTOM_TYPE,
  completionAcknowledgement,
  persistedScheduleResultIds,
} from "../../extensions/schedule-completion-delivery.ts";
import { ScheduleDatabase } from "../../gateway/database.ts";
import { GatewayService } from "../../gateway/service.ts";
import { Scheduler } from "../../gateway/scheduler.ts";
import type { CompletionRecord } from "../../gateway/types.ts";

function completion(id: string, timestamp: number = 1000): CompletionRecord {
  return {
    scheduleId: `sch_${id}`,
    occurrenceId: `schedule:sch_${id}:500`,
    scheduledFor: 500,
    status: "succeeded",
    result: `result ${id}`,
    timestamp,
  };
}

function persistedEntry(records: CompletionRecord[]): Record<string, unknown> {
  return {
    type: "custom_message",
    customType: SCHEDULE_RESULTS_CUSTOM_TYPE,
    details: {
      occurrenceIds: records.map((record) => record.occurrenceId),
      acknowledgements: records.map(completionAcknowledgement),
    },
  };
}

test("a completion queued during an active turn is not acknowledged before persistence", () => {
  const tracker = new CompletionDeliveryTracker();
  const record = completion("queued");

  tracker.markQueued([record]);

  assert.equal(tracker.isQueued(record.occurrenceId), true);
  assert.deepEqual(tracker.persistedAcknowledgements([record], new Set()), []);
  assert.deepEqual(tracker.pendingForDelivery([record], new Set()), []);
});

test("an aborted turn clears an unpersisted marker and retries the occurrence", () => {
  const tracker = new CompletionDeliveryTracker();
  const record = completion("aborted");
  tracker.markQueued([record]);

  tracker.clearUnpersisted(new Set());

  assert.equal(tracker.isQueued(record.occurrenceId), false);
  assert.deepEqual(tracker.pendingForDelivery([record], new Set()), [record]);
});

test("a persisted batch is acknowledged once and is never queued again", () => {
  const tracker = new CompletionDeliveryTracker();
  const records = [completion("one", 1001), completion("two", 1002)];
  tracker.markQueued(records);
  const persisted = persistedScheduleResultIds([persistedEntry(records)]);

  const first = tracker.persistedAcknowledgements(records, persisted);
  tracker.markAcknowledged(first);

  assert.deepEqual(first, records.map(completionAcknowledgement));
  assert.deepEqual(tracker.persistedAcknowledgements(records, persisted), []);
  assert.deepEqual(tracker.pendingForDelivery(records, persisted), []);
});

test("gateway acknowledgements must match durable occurrence history", () => {
  const directory = mkdtempSync(join(tmpdir(), "red-completion-ack-"));
  const historyRoot = join(directory, "sessions");
  const db = new ScheduleDatabase(join(directory, "test.sqlite"));
  const now = 2000;
  const record = completion("durable", 1500);
  const scheduler = new Scheduler(db, { now: () => now, run: async () => undefined });
  try {
    db.create(
      {
        id: record.scheduleId,
        instruction: "durable completion",
        timezone: "UTC",
        cron: null,
        nextRunAt: 3000,
        permissionRequired: false,
        sourceMessageRef: "session:entry",
      },
      now,
    );
    mkdirSync(join(historyRoot, record.scheduleId), { recursive: true });
    writeFileSync(
      join(historyRoot, record.scheduleId, "history.jsonl"),
      `${JSON.stringify({
        type: "custom_message",
        customType: "red-schedule-completion",
        details: record,
      })}\n`,
    );
    const service = new GatewayService(db, scheduler, () => now, historyRoot);

    assert.throws(
      () => service.acknowledge([{ ...completionAcknowledgement(record), occurrenceId: "wrong" }]),
      /does not match durable history/,
    );
    assert.equal(db.get(record.scheduleId)?.last_reported_at, null);

    service.acknowledge([completionAcknowledgement(record)]);
    assert.equal(db.get(record.scheduleId)?.last_reported_at, record.timestamp);
  } finally {
    scheduler.stop();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
