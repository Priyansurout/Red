import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ScheduleDatabase } from "../../gateway/database.ts";
import { validateProvenance } from "../../gateway/provenance.ts";
import { nextCronRun, parseRunAt, validateCron, validateTimezone } from "../../gateway/schedule-time.ts";
import { Scheduler } from "../../gateway/scheduler.ts";
import { GatewayService } from "../../gateway/service.ts";

test("validates future ISO timestamps with explicit offsets", () => {
  const now = Date.parse("2026-08-29T10:00:00Z");
  assert.equal(parseRunAt("2026-08-29T15:31:00+05:30", now), Date.parse("2026-08-29T10:01:00Z"));
  assert.throws(() => parseRunAt("2026-08-29T15:31:00", now), /explicit UTC offset/);
  assert.throws(() => parseRunAt("2026-08-29T09:59:00Z", now), /future/);
});

test("accepts only strict five-field, minute-granularity cron", () => {
  const now = Date.parse("2026-08-29T10:00:20Z");
  assert.equal(validateCron("*/5 * * * *", "UTC", now), Date.parse("2026-08-29T10:05:00Z"));
  assert.throws(() => validateCron("0 */5 * * * *", "UTC", now), /exactly five fields/);
  assert.throws(() => validateCron("0 9 1 * 1", "UTC", now), /Cannot use both/);
  assert.throws(() => validateTimezone("Mars/Olympus"), /Invalid IANA timezone/);
  assert.equal(
    nextCronRun("30 9 * * *", "Asia/Kolkata", Date.parse("2026-08-29T03:00:00Z")),
    Date.parse("2026-08-29T04:00:00Z"),
  );
});

test("validates a real persisted Pi user-message reference and derives an idempotent ID", () => {
  const root = mkdtempSync(join(tmpdir(), "red-provenance-"));
  const cwd = "/tmp/Red-test";
  const sessionId = "session-real";
  const entryId = "entry-user";
  try {
    const directory = join(root, "nested");
    mkdirSync(directory);
    const file = join(directory, "session.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "session", id: sessionId, cwd }),
        JSON.stringify({ type: "message", id: entryId, parentId: null, message: { role: "user", content: [] } }),
        JSON.stringify({
          type: "message",
          id: "assistant-tool",
          parentId: entryId,
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "tool-call-1", name: "schedule_create" }],
          },
        }),
        "",
      ].join("\n"),
    );
    const input = {
      sourceSessionId: sessionId,
      sourceSessionFile: file,
      sourceEntryId: entryId,
      toolCallId: "tool-call-1",
    };
    const first = validateProvenance(input, { sessionRoot: root, cwd });
    const second = validateProvenance(input, { sessionRoot: root, cwd });
    const withScheduleFieldsInput = {
      ...input,
      instruction: "future work",
      permissionRequired: false,
    };
    const withScheduleFields = validateProvenance(
      withScheduleFieldsInput,
      { sessionRoot: root, cwd },
    );
    assert.deepEqual(first, second);
    assert.deepEqual(first, withScheduleFields);
    assert.match(first.scheduleId, /^sch_[a-f0-9]{16}$/);
    assert.equal(first.sourceMessageRef, `${sessionId}:${entryId}`);
    assert.throws(
      () => validateProvenance({ ...input, sourceEntryId: "missing" }, { sessionRoot: root, cwd }),
      /not a real Pi user message/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("schedule creation accepts explicit false and true permission modes", () => {
  const root = mkdtempSync(join(tmpdir(), "red-permission-provenance-"));
  const cwd = "/tmp/Red-permission-test";
  const sessionId = "session-permission";
  const entryId = "entry-user";
  const now = Date.parse("2026-08-29T10:00:00Z");
  const file = join(root, "session.jsonl");
  const db = new ScheduleDatabase(join(root, "test.sqlite"));
  const scheduler = new Scheduler(db, { now: () => now, run: async () => undefined });
  try {
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "session", id: sessionId, cwd }),
        JSON.stringify({
          type: "message",
          id: entryId,
          parentId: null,
          message: { role: "user", content: [] },
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-false",
          parentId: entryId,
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "tool-call-false", name: "schedule_create" }],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-true",
          parentId: entryId,
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "tool-call-true", name: "schedule_create" }],
          },
        }),
        "",
      ].join("\n"),
    );
    const service = new GatewayService(
      db,
      scheduler,
      () => now,
      join(root, "history"),
      { sessionRoot: root, cwd },
    );
    const common = {
      instruction: "future permission test",
      timezone: "UTC",
      sourceSessionId: sessionId,
      sourceSessionFile: file,
      sourceEntryId: entryId,
    };

    const preApproved = service.create({
      ...common,
      toolCallId: "tool-call-false",
      runAt: "2026-08-29T10:01:00Z",
      permissionRequired: false,
    }).schedule;
    const approvalRequired = service.create({
      ...common,
      toolCallId: "tool-call-true",
      runAt: "2026-08-29T10:02:00Z",
      permissionRequired: true,
    }).schedule;

    assert.equal(preApproved.permission_required, false);
    assert.equal(approvalRequired.permission_required, true);
    assert.notEqual(preApproved.id, approvalRequired.id);
  } finally {
    scheduler.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
