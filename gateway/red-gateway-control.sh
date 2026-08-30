#!/bin/zsh

set -euo pipefail

script_path="${0:A}"
gateway_dir="${script_path:h}"
red_root="${gateway_dir:h}"
label="io.github.priyansurout.red-gateway"
legacy_label="com.priyansu.red-gateway"
domain="gui/$(id -u)"
service="$domain/$label"
target_plist="$HOME/Library/LaunchAgents/$label.plist"
legacy_plist="$HOME/Library/LaunchAgents/$legacy_label.plist"
node_binary="$(command -v node || true)"

if [[ -z "$node_binary" || ! -x "$node_binary" ]]; then
  print -u2 "Node.js is required. Run $red_root/scripts/setup.sh first."
  exit 1
fi

render_plist() {
  local output_path="$1"
  local node_dir="${node_binary:h}"
  local launch_path="$node_dir:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
  local temporary_path
  temporary_path="$(mktemp "${TMPDIR:-/tmp}/red-gateway-plist.XXXXXX")"

  "$node_binary" - "$temporary_path" "$node_binary" "$red_root" "$launch_path" "$label" <<'NODE'
const { writeFileSync } = require("node:fs");
const [outputPath, nodeBinary, redRoot, launchPath, label] = process.argv.slice(2);

writeFileSync(outputPath, JSON.stringify({
  Label: label,
  ProgramArguments: [nodeBinary, `${redRoot}/gateway/red-gateway.ts`],
  WorkingDirectory: redRoot,
  EnvironmentVariables: { PATH: launchPath },
  RunAtLoad: true,
  KeepAlive: true,
  ProcessType: "Background",
  ThrottleInterval: 5,
  StandardOutPath: `${redRoot}/data/logs/red-gateway.log`,
  StandardErrorPath: `${redRoot}/data/logs/red-gateway.error.log`,
}));
NODE

  /usr/bin/plutil -convert xml1 "$temporary_path"
  /bin/mv "$temporary_path" "$output_path"
}

disable_plist() {
  local installed_path="$1"
  local disabled_path="$installed_path.disabled"
  if [[ -e "$disabled_path" ]]; then
    disabled_path="$disabled_path.$(date +%Y%m%d%H%M%S)"
  fi
  /bin/mv "$installed_path" "$disabled_path"
  echo "Preserved disabled LaunchAgent at $disabled_path"
}

wait_for_gateway() {
  local socket_path="$red_root/data/red-gateway.sock"
  local attempt
  for attempt in {1..50}; do
    if /usr/bin/curl --silent --fail --unix-socket "$socket_path" \
      http://localhost/health >/dev/null 2>&1; then
      echo "Gateway health check passed."
      return 0
    fi
    /bin/sleep 0.1
  done
  print -u2 "Gateway did not become healthy within 5 seconds."
  print -u2 "Inspect $red_root/data/logs/red-gateway.error.log"
  return 1
}

wait_for_unload() {
  local attempt
  for attempt in {1..50}; do
    if ! launchctl print "$service" >/dev/null 2>&1; then
      return 0
    fi
    /bin/sleep 0.1
  done
  print -u2 "Existing gateway did not unload within 5 seconds."
  return 1
}

case "${1:-status}" in
  install)
    mkdir -p "$HOME/Library/LaunchAgents" "$red_root/data/logs"
    launchctl bootout "$domain/$legacy_label" 2>/dev/null || true
    if [[ -f "$legacy_plist" ]]; then
      disable_plist "$legacy_plist"
    fi
    launchctl bootout "$service" 2>/dev/null || true
    wait_for_unload
    render_plist "$target_plist"
    launchctl bootstrap "$domain" "$target_plist"
    wait_for_gateway
    echo "Installed and started $label"
    ;;
  restart)
    launchctl kickstart -k "$service"
    wait_for_gateway
    echo "Restarted $label"
    ;;
  status)
    launchctl print "$service"
    ;;
  stop)
    launchctl bootout "$service"
    echo "Stopped $label; the plist remains installed."
    ;;
  uninstall)
    launchctl bootout "$service" 2>/dev/null || true
    if [[ -f "$target_plist" ]]; then
      disable_plist "$target_plist"
    fi
    echo "Uninstalled $label"
    ;;
  render)
    output_path="${2:-$red_root/data/$label.plist}"
    mkdir -p "${output_path:h}"
    render_plist "$output_path"
    echo "Rendered $output_path"
    ;;
  *)
    echo "Usage: $0 {install|restart|status|stop|uninstall|render [path]}" >&2
    exit 2
    ;;
esac
