# Red

Red is a local-first AI agent built on [Pi](https://github.com/earendil-works/pi-mono). It combines an interactive terminal agent with background commands, persistent preferences, web and MCP tools, and a durable macOS scheduler.

Red is currently a macOS-focused bootstrap project. The interactive agent can be adapted to other platforms, but the always-on scheduling service uses `launchd`.

## What Red can do

- Run interactive coding and general-purpose work in the terminal.
- Start long commands in the background and report their completion.
- Create one-time and recurring schedules that survive terminal restarts.
- Run scheduled occurrences through one global FIFO worker while interactive Red stays responsive.
- Require one execution-time approval when requested, or fully pre-approve a future occurrence by default.
- Persist personal preferences locally without committing them to Git.

## Quick setup

Requirements:

- macOS
- Node.js 22.19.0 or newer and npm
- Any model/provider supported by Pi, or an OpenAI-compatible API

Clone and install:

```bash
git clone https://github.com/Priyansurout/Red.git
cd Red
./scripts/setup.sh
```

Authenticate any built-in Pi provider without placing an API key in this repository:

```bash
pi
```

Inside Pi, enter `/login`, choose a provider, and complete its sign-in flow. Then enter `/model` and select the model Red should use. Pi stores provider credentials and the default model outside this repository under `~/.pi/agent/`.

Red is not tied to OpenRouter or GLM. To use Ollama, LM Studio, vLLM, a hosted proxy, or another OpenAI-compatible endpoint, follow the [custom model guide](docs/SETUP.md#custom-openai-compatible-api).

Install and start Red's scheduler:

```bash
./gateway/red-gateway-control.sh install
```

If `~/.local/bin` is already on your `PATH`, launch Red with:

```bash
red
```

Otherwise, add this to `~/.zshrc`, open a new terminal, and run `red`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

See [docs/SETUP.md](docs/SETUP.md) for verification, configuration, upgrades, troubleshooting, and removal.

## How it works

```text
You
 |
 v
red command --> interactive Pi --> Red extensions
                                  |          |
                                  |          +--> background task files
                                  |
                                  +--> Unix socket --> always-on gateway
                                                          |
                                                          +--> SQLite schedule state
                                                          |
                                                          +--> one FIFO worker
                                                                  |
                                                                  v
                                                          headless Pi session
                                                                  |
                                                                  v
                                                          JSONL result history
```

The gateway scans for due schedules every 15 seconds. The interactive scheduler extension checks its durable result inbox every 2 seconds so a separate gateway process can safely deliver completions into the active Pi session. Completion messages are acknowledged only after Pi persists them.

## Useful commands

```bash
# Run the automated scheduler suite
npm --prefix gateway test

# Inspect or restart the scheduler service
./gateway/red-gateway-control.sh status
./gateway/red-gateway-control.sh restart

# Stop or remove the scheduler service
./gateway/red-gateway-control.sh stop
./gateway/red-gateway-control.sh uninstall
```

Inside Red:

- `/schedules` lists schedules and their last status.
- `/schedule-history <id>` reads durable schedule history directly.
- `/red-status` shows the current Red stage, model, and context.

## Local data and security

Credentials, custom model configuration, preferences, task output, schedule state, logs, and session histories stay local and are excluded from Git. In particular, never commit `~/.pi/agent/auth.json`, `.pi/tasks/`, `data/`, or `memory/PREFERENCES.md`.

Interactive protected tools remain approval-gated. A default scheduled occurrence is pre-approved only for its future due-time execution; creating the schedule never runs it immediately.
