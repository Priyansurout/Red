import { request } from "node:http";

import { SOCKET_PATH } from "./paths.ts";

export interface GatewayResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}
export function gatewayRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  timeoutMs = 2500,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        socketPath: SOCKET_PATH,
        path,
        method,
        headers: payload
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
          : undefined,
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as GatewayResponse<T>;
            if (!parsed.ok) return reject(new Error(parsed.error ?? "Red gateway request failed."));
            resolve(parsed.data as T);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Red gateway request timed out.")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
