import { mkdirSync } from "node:fs";

import { ScheduleDatabase } from "./database.ts";
import { DATABASE_PATH, DATA_DIR, LOG_DIR, SOCKET_PATH } from "./paths.ts";
import { PiScheduleRunner } from "./pi-runner.ts";
import { Scheduler } from "./scheduler.ts";
import { createGatewayServer, listenOnPrivateSocket } from "./server.ts";
import { GatewayService } from "./service.ts";

mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(DATA_DIR, { recursive: true });

const database = new ScheduleDatabase(DATABASE_PATH);
const piRunner = await PiScheduleRunner.create();
const scheduler = new Scheduler(database, {
  run: (schedule, occurrenceId) => piRunner.run(schedule, occurrenceId),
  onTerminalWithoutRun: (schedule, status, occurrenceId, reason) =>
    piRunner.recordWithoutRun(schedule, status, occurrenceId, reason),
  onError: (error) => console.error("Scheduler scan failed; it will retry:", error),
});
const service = new GatewayService(database, scheduler);
const server = createGatewayServer(service);

await listenOnPrivateSocket(server);
scheduler.start();
console.log(`Red gateway listening on ${SOCKET_PATH}`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Red gateway received ${signal}; shutting down.`);
  scheduler.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  database.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
