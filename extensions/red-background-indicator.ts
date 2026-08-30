import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const REQUEST_CHANNEL = "pi-background-tasks:request:v1";
const RESPONSE_CHANNEL = "pi-background-tasks:response:v1";
const TERMINAL_CHANNEL = "pi-background-tasks:terminal:v1";
const REQUEST_SCHEMA = "pi-background-tasks.extension-request.v1";
const RESPONSE_SCHEMA = "pi-background-tasks.extension-response.v1";
const TERMINAL_SCHEMA = "pi-background-tasks.extension-terminal.v1";
const REFRESH_INTERVAL_MS = 500;
const FINISHED_DISPLAY_MS = 2_000;
const GREEN = "\x1b[38;2;70;200;110m";
const RED = "\x1b[38;2;235;90;90m";
const YELLOW = "\x1b[38;2;235;190;70m";
const RESET = "\x1b[0m";

type FinishedState = "DONE" | "FAILED" | "STOPPED";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runningTaskCount(response: unknown): number | undefined {
  if (!isRecord(response) || response.schema_version !== RESPONSE_SCHEMA) {
    return undefined;
  }
  if (response.operation !== "status" || response.ok !== true) {
    return undefined;
  }

  const result = response.result;
  if (!isRecord(result) || !Array.isArray(result.tasks)) {
    return undefined;
  }

  return result.tasks.filter(
    (task) => isRecord(task) && task.status === "running",
  ).length;
}

export default function redBackgroundIndicator(pi: ExtensionAPI) {
  let currentCtx: ExtensionContext | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let finishedTimer: ReturnType<typeof setTimeout> | undefined;
  let requestCounter = 0;
  let pendingRequestId: string | undefined;
  let runningCount = 0;
  let finishedState: FinishedState | undefined;
  let displayedText: string | undefined;

  function colorForFinished(state: FinishedState): string {
    if (state === "FAILED") return RED;
    if (state === "STOPPED") return YELLOW;
    return GREEN;
  }

  function render(): void {
    if (!currentCtx?.hasUI) return;

    let plainText: string | undefined;
    let color = GREEN;
    if (finishedState) {
      const running =
        runningCount > 0
          ? `${String(runningCount)} ${runningCount === 1 ? "TASK" : "TASKS"} RUNNING · `
          : "";
      plainText = `BG: ${running}${finishedState}`;
      color = colorForFinished(finishedState);
    } else if (runningCount > 0) {
      plainText = `BG: ${String(runningCount)} ${runningCount === 1 ? "TASK" : "TASKS"} RUNNING`;
    }

    if (plainText === displayedText) return;
    displayedText = plainText;

    if (!plainText) {
      currentCtx.ui.setStatus("00-red-background-count", undefined);
      currentCtx.ui.setWorkingMessage();
      return;
    }

    currentCtx.ui.setStatus(
      "00-red-background-count",
      `${color}${plainText}${RESET}`,
    );
    if (runningCount > 0) {
      currentCtx.ui.setWorkingMessage(
        `Working · ${String(runningCount)} background task${runningCount === 1 ? "" : "s"} running`,
      );
    } else {
      currentCtx.ui.setWorkingMessage();
    }
  }

  function showFinished(state: FinishedState): void {
    if (finishedTimer) clearTimeout(finishedTimer);
    finishedState = state;
    runningCount = Math.max(0, runningCount - 1);
    render();

    finishedTimer = setTimeout(() => {
      finishedTimer = undefined;
      finishedState = undefined;
      render();
      refresh();
    }, FINISHED_DISPLAY_MS);
  }

  function refresh(): void {
    if (!currentCtx?.hasUI || pendingRequestId) return;

    requestCounter += 1;
    pendingRequestId = `red-bg-status-${String(Date.now())}-${String(requestCounter)}`;
    pi.events.emit(REQUEST_CHANNEL, {
      schema_version: REQUEST_SCHEMA,
      request_id: pendingRequestId,
      operation: "status",
      payload: {},
    });
  }

  pi.events.on(RESPONSE_CHANNEL, (response) => {
    if (!isRecord(response) || response.request_id !== pendingRequestId) return;
    pendingRequestId = undefined;

    const count = runningTaskCount(response);
    if (count !== undefined) {
      runningCount = count;
      render();
    }
  });

  pi.events.on(TERMINAL_CHANNEL, (event) => {
    pendingRequestId = undefined;
    if (
      isRecord(event) &&
      event.schema_version === TERMINAL_SCHEMA &&
      isRecord(event.task)
    ) {
      const status = event.task.status;
      if (status === "completed") showFinished("DONE");
      else if (status === "failed") showFinished("FAILED");
      else if (status === "killed") showFinished("STOPPED");
    }
    refresh();
  });

  pi.on("session_start", (_event, ctx) => {
    currentCtx = ctx;
    runningCount = 0;
    finishedState = undefined;
    displayedText = undefined;
    pendingRequestId = undefined;

    if (refreshTimer) clearInterval(refreshTimer);
    if (finishedTimer) {
      clearTimeout(finishedTimer);
      finishedTimer = undefined;
    }
    refresh();
    refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
    if (finishedTimer) {
      clearTimeout(finishedTimer);
      finishedTimer = undefined;
    }
    ctx.ui.setStatus("00-red-background-count", undefined);
    ctx.ui.setWorkingMessage();
    currentCtx = undefined;
    pendingRequestId = undefined;
    runningCount = 0;
    finishedState = undefined;
    displayedText = undefined;
  });
}
