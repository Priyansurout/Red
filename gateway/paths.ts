import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GATEWAY_DIR = dirname(fileURLToPath(import.meta.url));

export const RED_ROOT = resolve(GATEWAY_DIR, "..");
export const DATA_DIR = join(RED_ROOT, "data");
export const DATABASE_PATH = join(DATA_DIR, "red.sqlite");
export const SOCKET_PATH = join(DATA_DIR, "red-gateway.sock");
export const LOG_DIR = join(DATA_DIR, "logs");
export const SCHEDULE_SESSION_DIR = join(DATA_DIR, "sessions");
export const PI_AGENT_DIR = join(homedir(), ".pi", "agent");
export const PI_SESSION_ROOT = join(PI_AGENT_DIR, "sessions");
