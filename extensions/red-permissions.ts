import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ALLOWED_LOCAL_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "time",
  "preference_remember",
  "bg_run",
  "bg_run_pi_attested",
  "bg_delegate",
  "bg_status",
  "bg_logs",
  "bg_result",
  "bg_kill",
  "schedule_create",
  "schedule_list",
  "schedule_pause",
  "schedule_resume",
  "schedule_cancel",
  "schedule_history",
]);

export function requiresInteractiveApproval(toolName: string): boolean {
  return !ALLOWED_LOCAL_TOOLS.has(toolName);
}

function actionLabel(toolName: string): string {
  if (toolName === "bash") return "bash command";
  if (toolName === "write" || toolName === "edit") return "file modification";
  if (toolName.startsWith("fusion_")) {
    return "background agent or multi-model action";
  }
  if (toolName === "mcp" || toolName.startsWith("mcp_")) {
    return "MCP or external-service action";
  }
  return "external or unclassified tool action";
}

function actionPreview(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "bash" && typeof input.command === "string") {
    return input.command.slice(0, 1000);
  }

  if (
    (toolName === "write" || toolName === "edit") &&
    typeof input.path === "string"
  ) {
    return input.path;
  }

  const safeFields = [
    "action",
    "method",
    "path",
    "query",
    "claim",
    "name",
    "prompt",
    "objective",
    "taskId",
    "provider",
    "model",
    "server",
    "serverName",
    "tool",
    "toolName",
    "url",
  ];
  const preview = Object.fromEntries(
    safeFields
      .filter((field) => typeof input[field] === "string")
      .map((field) => [field, String(input[field]).slice(0, 300)]),
  );

  return Object.keys(preview).length > 0
    ? JSON.stringify(preview, null, 2)
    : "No safe argument preview is available.";
}

export default function redPermissionsExtension(pi: ExtensionAPI) {
  pi.registerCommand("red-tools", {
    description: "Show the tools currently available to Red",
    handler: async (_args, ctx) => {
      const tools = pi.getActiveTools();
      ctx.ui.notify(
        tools.length > 0 ? `Active tools: ${tools.join(", ")}` : "Active tools: none",
        "info",
      );
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!requiresInteractiveApproval(event.toolName)) {
      return undefined;
    }

    const label = actionLabel(event.toolName);

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Blocked ${label}: no interactive permission UI is available.`,
      };
    }

    const allowed = await ctx.ui.confirm(
      `Allow ${label}?`,
      `Tool: ${event.toolName}\n\n${actionPreview(
        event.toolName,
        event.input as Record<string, unknown>,
      )}`,
    );

    if (!allowed) {
      return {
        block: true,
        reason: `User denied ${label}.`,
      };
    }

    return undefined;
  });
}
