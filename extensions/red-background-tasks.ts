import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import backgroundTasksExtension from "../.pi/npm/node_modules/pi-background-tasks/extensions/background-tasks.ts";

const BACKGROUND_STATUS_KEY = "background-tasks";
const COMPLETION_MESSAGE_TYPE = "background-task-notification";
const START_MESSAGE_TYPE = "background-task-started";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStartNotification(message: string): boolean {
  return (
    message.startsWith("Started ") &&
    message.includes("\nOutput: ") &&
    message.includes("\nCommand: ")
  );
}

function quietUi(
  ui: ExtensionUIContext,
  onTaskStarted: (message: string) => void,
): ExtensionUIContext {
  return new Proxy(ui, {
    get(target, property, receiver) {
      if (property === "setStatus") {
        return (key: string, text: string | undefined): void => {
          if (key !== BACKGROUND_STATUS_KEY) target.setStatus(key, text);
        };
      }

      if (property === "notify") {
        return (
          message: string,
          type?: "info" | "warning" | "error",
        ): void => {
          if (isStartNotification(message)) {
            onTaskStarted(message);
            return;
          }
          target.notify(message, type);
        };
      }

      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function quietContext<T extends ExtensionContext>(
  ctx: T,
  onTaskStarted: (message: string) => void,
): T {
  const ui = quietUi(ctx.ui, onTaskStarted);
  return new Proxy(ctx, {
    get(target, property, receiver) {
      if (property === "ui") return ui;
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function redBgRunTool(tool: ToolDefinition): ToolDefinition {
  if (tool.name !== "bg_run") return tool;

  const originalPrepare = tool.prepareArguments;
  return {
    ...tool,
    description:
      "Start a named long-running shell command in the background and return immediately. Red tracks it in the bottom status bar, delivers its terminal result back to the model, and starts a follow-up turn so the model can report to the user.",
    promptSnippet:
      "Start and control a named long-running command with automatic completion reporting",
    promptGuidelines: [
      "Use bg_run for commands expected to run for a long time, such as test suites, dev servers, watchers, or builds.",
      "Set isAgent true only for an LLM or agent process; use false for scripts, tests, servers, sleeps, and ordinary shell commands.",
      "Give every task a concise 2-6 word name for the bottom status bar.",
      "After starting a task, continue independent useful work or yield. Do not poll merely to wait for completion.",
      "When the completion notification arrives, use bg_logs if output is needed, then report the result to the user.",
      "Use bg_status, bg_logs, or bg_kill whenever the user asks to inspect or stop a running task.",
    ],
    prepareArguments(args: unknown) {
      const prepared = originalPrepare ? originalPrepare(args) : args;
      if (!isRecord(prepared)) return prepared;
      return {
        ...prepared,
        notifyOnCompletion: true,
        triggerOnCompletion: true,
      };
    },
  } as ToolDefinition;
}

/**
 * Keep pi-background-tasks as Red's task engine while letting Red own its UI.
 * This wrapper avoids patching node_modules, so package updates remain safe.
 */
export default function redBackgroundTasks(pi: ExtensionAPI): void {
  function rememberTaskStart(message: string): void {
    pi.sendMessage(
      {
        customType: START_MESSAGE_TYPE,
        content: `<background-task-started>\n${message}\nThe task is running. Use bg_status, bg_logs, or bg_kill to inspect or control it.\n</background-task-started>`,
        display: false,
      },
      { triggerTurn: false },
    );
  }

  const wrappedPi = new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "sendMessage") {
        return (message: unknown, options?: unknown): void => {
          if (isRecord(message) && message.customType === COMPLETION_MESSAGE_TYPE) {
            const originalOptions = isRecord(options) ? options : {};
            target.sendMessage(
              {
                ...(message as Record<string, unknown>),
                display: false,
              } as never,
              {
                ...originalOptions,
                deliverAs: "followUp",
                triggerTurn: true,
              } as never,
            );
            return;
          }
          target.sendMessage(message as never, options as never);
        };
      }

      if (property === "on") {
        return (eventName: string, handler: Function): void => {
          (target.on as Function)(eventName, (event: unknown, ctx: ExtensionContext) =>
            handler(event, quietContext(ctx, rememberTaskStart)),
          );
        };
      }

      if (property === "registerCommand") {
        return (
          name: string,
          options: {
            handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
          } & Record<string, unknown>,
        ): void => {
          target.registerCommand(name, {
            ...options,
            handler: (args, ctx) =>
              options.handler(args, quietContext(ctx, rememberTaskStart)),
          });
        };
      }

      if (property === "registerShortcut") {
        return (
          shortcut: Parameters<ExtensionAPI["registerShortcut"]>[0],
          options: {
            handler: (ctx: ExtensionContext) => Promise<void> | void;
          } & Record<string, unknown>,
        ): void => {
          target.registerShortcut(shortcut, {
            ...options,
            handler: (ctx) =>
              options.handler(quietContext(ctx, rememberTaskStart)),
          });
        };
      }

      if (property === "registerTool") {
        return (tool: ToolDefinition): void => {
          const customized = redBgRunTool(tool);
          target.registerTool({
            ...customized,
            execute: (toolCallId, params, signal, onUpdate, ctx) =>
              customized.execute(
                toolCallId,
                params,
                signal,
                onUpdate,
                quietContext(ctx, rememberTaskStart),
              ),
          });
        };
      }

      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  backgroundTasksExtension(wrappedPi);
}
