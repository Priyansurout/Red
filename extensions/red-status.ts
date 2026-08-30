import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export default function redStatusExtension(pi: ExtensionAPI) {
  pi.registerCommand("red-status", {
    description: "Show Red's current implementation status",

    handler: async (_args, ctx) => {
      const model = ctx.model?.id ?? "unknown";
      const usage = ctx.getContextUsage();
      const context = usage
        ? `${usage.tokens === null ? "unknown" : compactTokens(usage.tokens)}/${compactTokens(usage.contextWindow)}`
        : "unknown";
      ctx.ui.notify(
        `stage: bootstrap | model: ${model} | context: ${context}`,
        "info",
      );
    },
  });
}
