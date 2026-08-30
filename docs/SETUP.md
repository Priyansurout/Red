# Local setup guide

This guide installs Red on a Mac from a fresh clone and explains every persistent change made to the machine.

## 1. Install prerequisites

Red needs macOS, Git, and Node.js 22.19.0 or newer. Check them first:

```bash
git --version
node --version
npm --version
```

If Node is missing, install a current Node 22 or Node 24 release using your preferred version manager or Homebrew. The setup script does not modify an existing Node installation.

You also need one model available through a Pi-supported provider or an OpenAI-compatible endpoint. Red is provider-independent and does not store API keys in the repository.

## 2. Clone and install Red

```bash
git clone https://github.com/Priyansurout/Red.git
cd Red
./scripts/setup.sh
```

The setup script performs four actions:

1. Checks macOS and the Node version.
2. Installs Pi 0.84.2 globally only when the `pi` command is missing.
3. Runs `npm ci` for the gateway and Red's project-local Pi extensions.
4. Creates `~/.local/bin/red` as a symbolic link to this checkout.

It does not edit your shell profile or start the scheduler automatically.

If another file already owns `~/.local/bin/red`, setup stops instead of overwriting it. To choose a different command directory:

```bash
RED_INSTALL_BIN_DIR="$HOME/bin" ./scripts/setup.sh
```

## 3. Put the command on PATH

Check whether the command is already visible:

```bash
command -v red
```

If it prints nothing, add this line to `~/.zshrc`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Open a new terminal or run `source ~/.zshrc`.

## 4. Choose a provider and model

Start the base Pi application once:

```bash
pi
```

Enter `/login`, choose any built-in provider, and finish its authentication flow. Pi supports providers such as OpenAI, Anthropic, Google, OpenRouter, xAI, Groq, Cerebras, Mistral, and others.

Then enter `/model` and select the model Red should use. This becomes Pi's user-level default, so interactive Red and scheduled Red use the same provider and model.

Exit Pi and verify authentication without printing the credential, replacing `PROVIDER` with the selected provider ID:

```bash
pi auth check --provider PROVIDER
```

Pi stores the credential outside the repository at `~/.pi/agent/auth.json`. Do not copy that file into Red or commit it.

### Custom OpenAI-compatible API

Pi can call local or hosted services that implement OpenAI Chat Completions, including Ollama, LM Studio, vLLM, and many inference gateways.

Start from Red's example configuration:

```bash
mkdir -p "$HOME/.pi/agent"
if [[ -e "$HOME/.pi/agent/models.json" ]]; then
  echo "models.json already exists; merge the example provider instead."
else
  install -m 600 examples/models.openai-compatible.json "$HOME/.pi/agent/models.json"
fi
```

If `~/.pi/agent/models.json` already exists, do not overwrite it. Instead, merge the `my-openai-compatible` provider from the example into its existing `providers` object.

Edit the copied file and replace:

- `https://api.example.com/v1` with the endpoint's base URL.
- `your-model-id` with the model ID expected by that API.
- Context/output limits with values supported by that model.

For a hosted endpoint, store its API key in macOS Keychain. This command prompts securely because `-w` is last:

```bash
security add-generic-password -a red -s red-openai-compatible -U -w
```

The example retrieves that key at request time. This works for both terminal Red and the `launchd` scheduler without placing the secret in Git or relying on shell environment variables. For a keyless local service, replace the example's `apiKey` value with `"local"`.

Check that Pi sees the custom model:

```bash
pi --list-models my-openai-compatible
```

Then run `pi`, enter `/model`, select `my-openai-compatible/your-model-id`, and exit. If the service uses the newer OpenAI Responses protocol instead of Chat Completions, change `api` from `openai-completions` to `openai-responses`.

## 5. Install the scheduler service

```bash
./gateway/red-gateway-control.sh install
./gateway/red-gateway-control.sh status
```

The install command generates a machine-specific LaunchAgent at:

```text
~/Library/LaunchAgents/io.github.priyansurout.red-gateway.plist
```

The generated file contains the current clone path and the current Node binary path. `launchd` starts the gateway immediately, restarts it after failures, and starts it again after login.

The scheduler only runs while the Mac is awake. A one-time occurrence more than two minutes late is marked missed instead of being executed unexpectedly.

## 6. Start Red and verify it

```bash
red
```

The startup header should show `RED`, the Pi version, the configured model, and the clone directory. In Red, run:

```text
/red-status
/schedules
```

From another terminal, run the automated tests:

```bash
cd /path/to/Red
npm --prefix gateway test
```

To test scheduling harmlessly, ask Red:

```text
Create a one-time pre-approved schedule for 45 seconds from now. When due, report exactly: RED_SCHEDULE_OK. Do not run it now.
```

The due scan runs every 15 seconds, so execution can begin a few seconds after the requested time.

## Configuration

### Model

Red does not pin a project model. Pi stores the selected default provider, model, and thinking level in `~/.pi/agent/settings.json`. The scheduled runner reads that same selection before every occurrence.

Change models at any time with `/model`. Built-in model changes take effect for the next scheduled occurrence. Restart the gateway after adding or changing entries in `~/.pi/agent/models.json` so its custom model catalog reloads:

```bash
./gateway/red-gateway-control.sh restart
```

### MCP servers

The MCP adapter is installed locally with Red's dependencies. Add your MCP configuration using the adapter's normal Pi configuration flow. Keep credentials outside the repository and use environment variables or a private user-level configuration.

### Personal preferences

Red writes remembered preferences to `memory/PREFERENCES.md`. That file is ignored by Git and remains local to this checkout.

## Runtime files

Red creates the following local state, all ignored by Git:

```text
data/red.sqlite             current schedule state
data/sessions/              headless scheduled Pi histories
data/logs/                  gateway stdout and stderr
.pi/tasks/                  background task records and output
memory/PREFERENCES.md       personal preference memory
~/.pi/agent/                Pi credentials, models, and interactive sessions
```

## Service operations

```bash
./gateway/red-gateway-control.sh status
./gateway/red-gateway-control.sh restart
./gateway/red-gateway-control.sh stop
./gateway/red-gateway-control.sh uninstall
```

`uninstall` stops the service and preserves its plist with a `.disabled` suffix (and a timestamp if needed). It does not delete schedules, histories, credentials, or preferences.

## Updating

Pull source changes, reinstall pinned dependencies, run tests, and restart the service:

```bash
git pull
npm ci --prefix gateway
npm ci --prefix .pi/npm
npm --prefix gateway test
./gateway/red-gateway-control.sh install
```

Using `install` again regenerates the LaunchAgent, which is required if the repository or Node binary moved.

## Troubleshooting

### `red: command not found`

Add `~/.local/bin` to `PATH`, or run Red directly with `./bin/red` from the repository.

### Red cannot find an extension

Restore project dependencies:

```bash
npm ci --prefix .pi/npm
```

### Gateway is not running

```bash
./gateway/red-gateway-control.sh status
tail -n 100 data/logs/red-gateway.error.log
```

Then regenerate and restart it:

```bash
./gateway/red-gateway-control.sh install
```

### Gateway says the model is unavailable

Open Pi, authenticate a provider with `/login`, and select a model with `/model`. Then check the selected provider without printing its credential:

```bash
pi auth check --provider PROVIDER
pi --list-models MODEL_NAME
```

If it is a custom model, verify `~/.pi/agent/models.json` and restart the gateway.

### Moving the clone

The `red` command resolves the checkout through its symbolic link, but the LaunchAgent stores an absolute path. After moving the repository, run:

```bash
./gateway/red-gateway-control.sh install
```
