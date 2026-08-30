import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function timeExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "time",
    label: "Time",
    description: "Get the current date, time, and timezone from this machine.",
    parameters: Type.Object({}),

    async execute() {
      const now = new Date();
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

      const localTime = new Intl.DateTimeFormat("en-IN", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone: timezone,
      }).format(now);

      return {
        content: [
          {
            type: "text",
            text: [
              `Local time: ${localTime}`,
              `Timezone: ${timezone}`,
              `UTC: ${now.toISOString()}`,
            ].join("\n"),
          },
        ],
        details: {},
      };
    },
  });
}
