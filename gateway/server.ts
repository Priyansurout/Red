import { chmodSync, existsSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { SOCKET_PATH } from "./paths.ts";
import type { GatewayService } from "./service.ts";

const MAX_BODY_BYTES = 64 * 1024;

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}
async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body exceeds 64 KiB.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export function createGatewayServer(service: GatewayService): Server {
  return createServer(async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const path = new URL(request.url ?? "/", "http://red.local").pathname;
      if (method === "GET" && path === "/health") return send(response, 200, { ok: true, data: service.health() });
      if (method === "GET" && path === "/schedules") return send(response, 200, { ok: true, data: service.list() });
      if (method === "POST" && path === "/schedules") {
        return send(response, 200, { ok: true, data: service.create(await readBody(request) as never) });
      }
      if (method === "GET" && path === "/inbox") return send(response, 200, { ok: true, data: service.inbox() });
      if (method === "POST" && path === "/inbox/ack") {
        const body = await readBody(request);
        service.acknowledge(body.items as never);
        return send(response, 200, { ok: true, data: { acknowledged: true } });
      }

      const control = path.match(/^\/schedules\/([^/]+)\/(pause|resume|cancel)$/);
      if (method === "POST" && control) {
        const id = decodeURIComponent(control[1]);
        const action = control[2] as "pause" | "resume" | "cancel";
        return send(response, 200, { ok: true, data: service[action](id) });
      }
      const history = path.match(/^\/schedules\/([^/]+)\/history$/);
      if (method === "GET" && history) {
        return send(response, 200, { ok: true, data: service.history(decodeURIComponent(history[1])) });
      }
      const decision = path.match(/^\/schedules\/([^/]+)\/(approve|deny)$/);
      if (method === "POST" && decision) {
        const id = decodeURIComponent(decision[1]);
        return send(
          response,
          200,
          { ok: true, data: decision[2] === "approve" ? service.approve(id) : service.deny(id) },
        );
      }
      return send(response, 404, { ok: false, error: "Not found." });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return send(response, 400, { ok: false, error: message });
    }
  });
}

export async function listenOnPrivateSocket(server: Server): Promise<void> {
  if (existsSync(SOCKET_PATH)) rmSync(SOCKET_PATH);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(SOCKET_PATH, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(SOCKET_PATH, 0o600);
}
