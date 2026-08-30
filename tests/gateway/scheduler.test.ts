import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { ScheduleDatabase } from "../../gateway/database.ts";
import { scheduledExtensionPaths } from "../../gateway/pi-runner.ts";
import { requiresInteractiveApproval } from "../../extensions/red-permissions.ts";
import { Scheduler, MISFIRE_GRACE_MS } from "../../gateway/scheduler.ts";
import { createGatewayServer } from "../../gateway/server.ts";
import { GatewayService } from "../../gateway/service.ts";
import type { Schedule } from "../../gateway/types.ts";

function fixture(run?: (schedule: Schedule, occurrenceId: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "red-scheduler-"));
  const db = new ScheduleDatabase(join(directory, "test.sqlite"));
  let now = Date.parse("2026-08-29T10:00:00.000Z");
  const errors: unknown[] = [];
  const scheduler = new Scheduler(db, {
    now: () => now,
    run: run ?? (async () => undefined),
    onError: (error) => errors.push(error),
  });
  return {
    directory,
    db,
    scheduler,
    errors,
    now: () => now,
    setNow(value: number) { now = value; },
    close() {
      scheduler.stop();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function add(
  db: ScheduleDatabase,
  id: string,
  due: number,
  now: number,
  options: { cron?: string; permission?: boolean } = {},
) {
  return db.create(
    {
      id,
      instruction: `instruction ${id}`,
      timezone: "UTC",
      cron: options.cron ?? null,
      nextRunAt: due,
      permissionRequired: options.permission ?? false,
      sourceMessageRef: `session:${id}`,
    },
    now,
  ).schedule;
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("uses exactly one application table and never deletes terminal rows", () => {
  const f = fixture();
  try {
    assert.deepEqual(f.db.applicationTables(), ["schedules"]);
    add(f.db, "sch_keep", f.now() + 1000, f.now());
    f.db.setControlStatus("sch_keep", "cancelled", f.now());
    assert.equal(f.db.get("sch_keep")?.status, "cancelled");
    assert.equal(f.db.list().length, 1);
  } finally {
    f.close();
  }
});

test("runs a due one-time schedule and preserves the row as completed", async () => {
  const calls: string[] = [];
  const f = fixture(async (_schedule, occurrenceId) => { calls.push(occurrenceId); });
  try {
    const due = f.now() - 30_000;
    add(f.db, "sch_once", due, f.now());
    await f.scheduler.tick();
    await settle();
    assert.deepEqual(calls, [`schedule:sch_once:${due}`]);
    assert.equal(f.db.get("sch_once")?.status, "completed");
    assert.equal(f.db.get("sch_once")?.last_run_status, "succeeded");
    assert.equal(f.db.get("sch_once")?.next_run_at, null);
  } finally {
    f.close();
  }
});

test("marks an offline one-time occurrence missed after grace", async () => {
  const f = fixture();
  try {
    add(f.db, "sch_missed", f.now() - MISFIRE_GRACE_MS - 1, f.now());
    await f.scheduler.tick();
    assert.equal(f.db.get("sch_missed")?.status, "expired");
    assert.equal(f.db.get("sch_missed")?.last_run_status, "missed");
    assert.equal(f.db.get("sch_missed")?.last_run_reason, "gateway_unavailable_past_grace");
  } finally {
    f.close();
  }
});

test("waits for approval, then misses after the grace deadline", async () => {
  const f = fixture();
  try {
    const due = f.now();
    add(f.db, "sch_approval", due, f.now(), { permission: true });
    await f.scheduler.tick();
    assert.equal(f.db.get("sch_approval")?.last_run_status, "awaiting_approval");
    f.setNow(due + MISFIRE_GRACE_MS + 1);
    await f.scheduler.tick();
    assert.equal(f.db.get("sch_approval")?.status, "expired");
    assert.equal(f.db.get("sch_approval")?.last_run_status, "missed");
    assert.equal(f.db.get("sch_approval")?.last_run_reason, "approval_not_received_within_grace");
  } finally {
    f.close();
  }
});

test("approval queues the occurrence within grace", async () => {
  const calls: string[] = [];
  const f = fixture(async (_schedule, occurrenceId) => { calls.push(occurrenceId); });
  try {
    const due = f.now();
    add(f.db, "sch_approved", due, f.now(), { permission: true });
    await f.scheduler.tick();
    f.scheduler.approve("sch_approved");
    await settle();
    assert.deepEqual(calls, [`schedule:sch_approved:${due}`]);
    assert.equal(f.db.get("sch_approved")?.last_run_status, "succeeded");
  } finally {
    f.close();
  }
});

test("headless scheduled sessions omit the interactive permission gateway", () => {
  const paths = scheduledExtensionPaths("/red");

  assert.equal(paths.some((path) => path.endsWith("red-permissions.ts")), false);
  assert.equal(paths.some((path) => path.endsWith("pi-web-access/index.ts")), true);
  assert.equal(paths.some((path) => path.endsWith("pi-mcp-adapter/index.ts")), true);
});

test("ordinary interactive protected and external tools remain approval-gated", () => {
  assert.equal(requiresInteractiveApproval("read"), false);
  assert.equal(requiresInteractiveApproval("bash"), true);
  assert.equal(requiresInteractiveApproval("write"), true);
  assert.equal(requiresInteractiveApproval("mcp"), true);
  assert.equal(requiresInteractiveApproval("web_search"), true);
  assert.equal(requiresInteractiveApproval("fetch_content"), true);
});

test("denial cancels a one-time occurrence without deleting it", async () => {
  const f = fixture();
  try {
    add(f.db, "sch_denied", f.now(), f.now(), { permission: true });
    await f.scheduler.tick();
    f.scheduler.deny("sch_denied");
    assert.equal(f.db.get("sch_denied")?.status, "cancelled");
    assert.equal(f.db.get("sch_denied")?.last_run_status, "denied");
    assert.equal(f.db.get("sch_denied")?.last_run_reason, "user_denied");
    assert.equal(f.db.list().length, 1);
  } finally {
    f.close();
  }
});

test("pause, resume, and cancel mutate the same durable row", () => {
  const f = fixture();
  try {
    add(f.db, "sch_control", f.now() + 60_000, f.now());
    const service = new GatewayService(f.db, f.scheduler, f.now);
    assert.equal(service.pause("sch_control").status, "paused");
    assert.equal(service.resume("sch_control").status, "active");
    assert.equal(service.cancel("sch_control").status, "cancelled");
    assert.equal(f.db.list().length, 1);
  } finally {
    f.close();
  }
});

test("same-time schedules execute FIFO with one global worker", async () => {
  const starts: string[] = [];
  const releases: Array<() => void> = [];
  const f = fixture((schedule) => new Promise<void>((resolve) => {
    starts.push(schedule.id);
    releases.push(resolve);
  }));
  try {
    const due = f.now();
    add(f.db, "sch_a", due, f.now());
    add(f.db, "sch_b", due, f.now());
    await f.scheduler.tick();
    assert.deepEqual(starts, ["sch_a"]);
    assert.equal(f.db.get("sch_b")?.last_run_status, "queued");
    releases.shift()?.();
    await settle();
    assert.deepEqual(starts, ["sch_a", "sch_b"]);
    releases.shift()?.();
    await settle();
  } finally {
    f.close();
  }
});

test("a long-running scheduled worker does not block list or history gateway requests", async () => {
  let release: (() => void) | undefined;
  let markStarted: (() => void) | undefined;
  const actuallyStarted = new Promise<void>((resolve) => { markStarted = resolve; });
  const f = fixture(() => new Promise<void>((resolve) => {
    release = resolve;
    markStarted?.();
  }));
  const service = new GatewayService(f.db, f.scheduler, f.now, join(f.directory, "sessions"));
  const server = createGatewayServer(service);
  try {
    add(f.db, "sch_nonblocking", f.now(), f.now());
    await f.scheduler.tick();
    await actuallyStarted;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const { port } = server.address() as AddressInfo;
    const [listResponse, historyResponse] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/schedules`, { signal: AbortSignal.timeout(500) }),
      fetch(`http://127.0.0.1:${port}/schedules/sch_nonblocking/history`, {
        signal: AbortSignal.timeout(500),
      }),
    ]);

    assert.equal(listResponse.status, 200);
    assert.equal(historyResponse.status, 200);
    assert.equal((await listResponse.json() as { ok: boolean }).ok, true);
    assert.equal((await historyResponse.json() as { ok: boolean }).ok, true);
    assert.equal(f.db.get("sch_nonblocking")?.last_run_status, "running");
  } finally {
    release?.();
    await settle();
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    f.close();
  }
});

test("startup marks an interrupted running occurrence failed without retry", () => {
  const f = fixture();
  try {
    add(f.db, "sch_restart", f.now(), f.now());
    f.db.updateOccurrence(
      "sch_restart",
      { nextRunAt: null, lastRunAt: f.now(), lastRunStatus: "running" },
      f.now(),
    );
    f.scheduler.recoverInterruptedRuns();
    assert.equal(f.db.get("sch_restart")?.status, "completed");
    assert.equal(f.db.get("sch_restart")?.last_run_status, "failed");
    assert.equal(f.db.get("sch_restart")?.last_run_reason, "gateway_restarted_during_execution");
  } finally {
    f.close();
  }
});

test("a scan error is retried and does not cancel the schedule", async () => {
  const f = fixture();
  try {
    add(f.db, "sch_retry", f.now(), f.now());
    const original = f.db.due.bind(f.db);
    let failed = false;
    f.db.due = (() => {
      if (!failed) {
        failed = true;
        throw new Error("temporary database error");
      }
      return original(f.now());
    }) as typeof f.db.due;
    await f.scheduler.tick();
    assert.equal(f.errors.length, 1);
    assert.equal(f.db.get("sch_retry")?.status, "active");
    await f.scheduler.tick();
    await settle();
    assert.equal(f.db.get("sch_retry")?.last_run_status, "succeeded");
  } finally {
    f.close();
  }
});

test("recurring schedules advance and remain active", async () => {
  const f = fixture();
  try {
    const due = f.now();
    add(f.db, "sch_cron", due, f.now(), { cron: "* * * * *" });
    await f.scheduler.tick();
    await settle();
    const row = f.db.get("sch_cron");
    assert.equal(row?.status, "active");
    assert.equal(row?.next_run_at, due + 60_000);
  } finally {
    f.close();
  }
});
