import { CronExpressionParser } from "cron-parser";

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function validateTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    throw new Error(`Invalid IANA timezone: ${timezone}`);
  }
}
export function parseRunAt(runAt: string, now: number): number {
  if (!ISO_WITH_OFFSET.test(runAt)) {
    throw new Error("runAt must be ISO 8601 and include Z or an explicit UTC offset.");
  }
  const value = Date.parse(runAt);
  if (!Number.isFinite(value)) throw new Error("runAt is not a valid date.");
  if (value <= now) throw new Error("runAt must be in the future.");
  return value;
}

function strictExpression(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error("cron must contain exactly five fields: minute hour day month weekday.");
  }
  return `0 ${fields.join(" ")}`;
}

export function nextCronRun(cron: string, timezone: string, after: number): number {
  validateTimezone(timezone);
  const expression = CronExpressionParser.parse(strictExpression(cron), {
    currentDate: new Date(after),
    tz: timezone,
    strict: true,
  });
  return expression.next().getTime();
}

export function validateCron(cron: string, timezone: string, now: number): number {
  return nextCronRun(cron, timezone, now);
}
