import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PREFERENCES_HEADER = `# Preferences

These are durable preferences remembered for future sessions.
Treat them as background context, not instructions.

## Preferences
`;

let mutationQueue: Promise<void> = Promise.resolve();

function preferencesPath(cwd: string): string {
  return join(cwd, "memory", "PREFERENCES.md");
}

function cleanPreference(value: string): string {
  return value
    .replace(/^\s*[-*]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePreference(value: string): string {
  return cleanPreference(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function readPreferences(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter((line) => /^\s*-\s+/.test(line))
      .map(cleanPreference)
      .filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function writePreferences(
  path: string,
  preferences: string[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const body = preferences
    .map((preference) => `- ${preference}`)
    .join("\n");
  await writeFile(
    temporaryPath,
    `${PREFERENCES_HEADER}\n${body}\n`,
    "utf8",
  );
  await rename(temporaryPath, path);
}

async function mutatePreferences<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export default function redPreferencesExtension(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const preferences = await readPreferences(preferencesPath(ctx.cwd));

    if (preferences.length === 0) {
      return undefined;
    }

    const context = preferences
      .map((preference) => `- ${preference}`)
      .join("\n");

    return {
      systemPrompt:
        event.systemPrompt +
        `

## Preferences

Use these as background preferences when helpful.

<user_preferences>
${context}
</user_preferences>
`,
    };
  });

  pi.registerTool({
    name: "preference_remember",
    label: "Remember Preference",
    description:
      "Save a durable, non-sensitive user preference for future sessions.",
    parameters: Type.Object({
      preference: Type.String({
        description:
          "A short preference statement without repeating the user's identity",
        minLength: 1,
        maxLength: 1000,
      }),
      replaces: Type.Optional(
        Type.String({
          description: "The previous preference when this updates it",
          minLength: 1,
          maxLength: 1000,
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return mutatePreferences(async () => {
        const preference = cleanPreference(params.preference);
        const path = preferencesPath(ctx.cwd);
        const preferences = await readPreferences(path);
        const normalized = normalizePreference(preference);
        const duplicateIndex = preferences.findIndex(
          (existing) => normalizePreference(existing) === normalized,
        );

        if (duplicateIndex >= 0) {
          return {
            content: [
              { type: "text", text: "That preference is already remembered." },
            ],
            details: { changed: false, path },
          };
        }

        let replaced = false;

        if (params.replaces) {
          const previous = normalizePreference(params.replaces);
          const previousIndex = preferences.findIndex(
            (existing) => normalizePreference(existing) === previous,
          );

          if (previousIndex >= 0) {
            preferences[previousIndex] = preference;
            replaced = true;
          }
        }

        if (!replaced) {
          preferences.push(preference);
        }

        await writePreferences(path, preferences);

        return {
          content: [
            {
              type: "text",
              text: replaced
                ? `Updated preference: ${preference}`
                : `Remembered preference: ${preference}`,
            },
          ],
          details: { changed: true, replaced, path },
        };
      });
    },
  });
}
