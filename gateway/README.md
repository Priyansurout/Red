# Red gateway

Start Red with the installed `red` command rather than invoking `pi` directly.
The launcher changes to the Red project, disables ambient/global skill and
extension discovery, and explicitly loads only resources owned by Red. The
terminal application hosting it does not define Red's capabilities.

The gateway owns Red's durable local scheduler. It runs independently from the
Pi terminal UI, polls one SQLite `schedules` table every 15 seconds, and runs at
most one scheduled Pi session at a time. Interactive Red and gateway execution
remain independent; FIFO ordering applies only between scheduled occurrences.

## Runtime ownership

```text
Pi extension ── private Unix socket ──> red-gateway
                                          │
                         ┌────────────────┼────────────────┐
                         ▼                ▼                ▼
                   red.sqlite       Pi JSONL history   headless Pi SDK
```

- `data/red.sqlite` holds current schedule state and is never used as a timer.
- `data/sessions/<schedule-id>/` holds the detailed Pi conversation history.
- The platform service manager keeps the gateway alive while the machine is
  awake and restarts it: `launchd` on macOS, `systemd --user` on Linux.
- If the machine is asleep or powered off, nothing runs. Startup recovery marks
  a one-time occurrence missed after its two-minute grace period.
- `permission_required = false` (the default) pre-approves the entire future
  occurrence and all nested tools. The headless runner does not load Red's
  interactive permission gateway.
- `permission_required = true` asks once in an open Red UI when due. Approval
  authorizes the whole occurrence; denial prevents it from running.
- Interactive bash, writes, MCP, and external-service calls outside scheduled
  occurrences remain approval-gated.
- The headless runner reads Pi's user-level default provider, model, and thinking
  level, so scheduled and interactive Red use the same selection. Custom models
  in `~/.pi/agent/models.json`, including OpenAI-compatible APIs, are supported.
- Completion reports are delivered at least once. Red batches ready results in
  one hidden follow-up, records occurrence IDs in the interactive session, and
  acknowledges them only after that message is persisted. An aborted queued
  follow-up is retried from the durable inbox.

## Red commands and tools

- `/schedules` lists every schedule with `pre-approved` or `approval required`,
  its next run, and its last execution status.
- `/schedule-history <id>` reads durable history directly without a model turn.
- The `schedule_list` and `schedule_history` model tools expose the same state.
- Creating or confirming a pre-approved schedule never runs its instruction
  immediately; execution begins only when the occurrence becomes due.

## Commands

From `Red/gateway`:

```bash
npm test
./red-gateway-control.sh status
./red-gateway-control.sh restart
```

`./red-gateway-control.sh install` generates a machine-specific service
definition: a LaunchAgent at
`~/Library/LaunchAgents/io.github.priyansurout.red-gateway.plist` on macOS, or a
user unit at `~/.config/systemd/user/red-gateway.service` on Linux. It resolves
the checkout and Node binary dynamically, so Red does not depend on one user's
home directory or Homebrew prefix. Runtime data and logs are ignored by Git
under `Red/data/`.

On Linux, run `sudo loginctl enable-linger "$USER"` once so the user service
manager — and therefore the scheduler — survives logout and starts at boot.

For the complete fresh-machine walkthrough, see [`../docs/SETUP.md`](../docs/SETUP.md).
