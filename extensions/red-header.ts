import { homedir } from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const PREFERRED_OUTER_WIDTH = 68;
const FULL_LAYOUT_MIN_WIDTH = 42;
const FIELD_LABEL_WIDTH = 12;
const LIGHT_RED = "\x1b[38;2;255;105;110m";
const BORDER_RED = "\x1b[38;2;205;75;80m";
const RESET = "\x1b[0m";

function lightRed(text: string): string {
  return `${LIGHT_RED}${text}${RESET}`;
}

function borderRed(text: string): string {
  return `${BORDER_RED}${text}${RESET}`;
}

function compactPath(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

function padLine(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, "…");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function centerLine(text: string, terminalWidth: number, lineWidth: number): string {
  return `${" ".repeat(Math.max(0, Math.floor((terminalWidth - lineWidth) / 2)))}${text}`;
}

function createHeader(
  theme: Theme,
  terminalWidth: number,
  model: string,
  cwd: string,
): string[] {
  if (terminalWidth < 8) return [theme.bold(lightRed("RED"))];

  const outerWidth = Math.min(PREFERRED_OUTER_WIDTH, terminalWidth);
  const frameInnerWidth = Math.max(1, outerWidth - 2);
  const contentPadding = outerWidth >= FULL_LAYOUT_MIN_WIDTH ? 2 : 1;
  const contentWidth = Math.max(1, frameInnerWidth - contentPadding * 2);
  const inset = " ".repeat(contentPadding);
  const frame = (text: string) =>
    centerLine(text, terminalWidth, outerWidth);
  const row = (text = "") =>
    frame(`${borderRed("│")}${inset}${padLine(text, contentWidth)}${inset}${borderRed("│")}`);
  const field = (label: string, value: string) => {
    const labelWidth = Math.min(FIELD_LABEL_WIDTH, Math.max(1, contentWidth - 1));
    const valueWidth = Math.max(0, contentWidth - labelWidth);
    const styledLabel = lightRed(label.padEnd(labelWidth));
    return `${styledLabel}${truncateToWidth(value, valueWidth, "…")}`;
  };
  const top = frame(borderRed(`╭${"─".repeat(frameInnerWidth)}╮`));
  const bottom = frame(borderRed(`╰${"─".repeat(frameInnerWidth)}╯`));
  const title = theme.bold(lightRed("RED"));
  const version = theme.fg("dim", `Pi v${VERSION}`);
  const titleGap = " ".repeat(
    Math.max(1, contentWidth - visibleWidth(title) - visibleWidth(version)),
  );

  if (outerWidth < FULL_LAYOUT_MIN_WIDTH) {
    return [
      top,
      row(title),
      row(field("Model:", model)),
      row(field("Directory:", compactPath(cwd))),
      bottom,
    ];
  }

  return [
    top,
    row(),
    row(`${title}${titleGap}${version}`),
    row(borderRed("─".repeat(contentWidth))),
    row(field("Model:", model)),
    row(field("Directory:", compactPath(cwd))),
    row(),
    bottom,
  ];
}

export default function redHeaderExtension(pi: ExtensionAPI) {
  let currentModel = "unknown";
  let currentCwd = process.cwd();

  const installHeader = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader((_tui, theme) => ({
      render(width: number): string[] {
        return createHeader(theme, width, currentModel, currentCwd);
      },
      invalidate() {},
    }));
    ctx.ui.setTitle(`Red — ${compactPath(currentCwd)}`);
  };

  pi.on("session_start", (_event, ctx) => {
    currentModel = ctx.model?.id ?? "unknown";
    currentCwd = ctx.cwd;
    installHeader(ctx);
  });

  pi.on("model_select", (event, ctx) => {
    currentModel = event.model.id;
    installHeader(ctx);
  });
}
