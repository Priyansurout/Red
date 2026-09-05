#!/usr/bin/env bash

set -euo pipefail

gateway_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
red_root="$(cd "$gateway_dir/.." && pwd -P)"
label="io.github.priyansurout.red-gateway"
legacy_label="com.priyansu.red-gateway"
platform="$(uname -s)"
node_binary="$(command -v node || true)"
socket_path="$red_root/data/red-gateway.sock"

if [[ -z "$node_binary" || ! -x "$node_binary" ]]; then
  printf '%s\n' "Node.js is required. Run $red_root/scripts/setup.sh first." >&2
  exit 1
fi

# macOS state
domain="gui/$(id -u)"
service="$domain/$label"
target_plist="$HOME/Library/LaunchAgents/$label.plist"
legacy_plist="$HOME/Library/LaunchAgents/$legacy_label.plist"

# Linux state
unit_name="red-gateway.service"
systemd_user_dir="$HOME/.config/systemd/user"
target_unit="$systemd_user_dir/$unit_name"

disable_definition() {
  local installed_path="$1"
  local disabled_path="$installed_path.disabled"
  if [[ -e "$disabled_path" ]]; then
    disabled_path="$disabled_path.$(date +%Y%m%d%H%M%S)"
  fi
  mv "$installed_path" "$disabled_path"
  echo "Preserved disabled service definition at $disabled_path"
}

wait_for_gateway() {
  local attempt
  for attempt in $(seq 1 50); do
    if curl --silent --fail --unix-socket "$socket_path" \
      http://localhost/health >/dev/null 2>&1; then
      echo "Gateway health check passed."
      return 0
    fi
    sleep 0.1
  done
  printf '%s\n' "Gateway did not become healthy within 5 seconds." >&2
  printf '%s\n' "Inspect $red_root/data/logs/red-gateway.error.log" >&2
  return 1
}

# ---------------------------------------------------------------- macOS

render_plist() {
  local output_path="$1"
  local node_dir="${node_binary%/*}"
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

wait_for_unload() {
  local attempt
  for attempt in $(seq 1 50); do
    if ! launchctl print "$service" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  printf '%s\n' "Existing gateway did not unload within 5 seconds." >&2
  return 1
}

darwin_main() {
  case "${1:-status}" in
    install)
      mkdir -p "$HOME/Library/LaunchAgents" "$red_root/data/logs"
      launchctl bootout "$domain/$legacy_label" 2>/dev/null || true
      if [[ -f "$legacy_plist" ]]; then
        disable_definition "$legacy_plist"
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
    status) launchctl print "$service" ;;
    stop)
      launchctl bootout "$service"
      echo "Stopped $label; the plist remains installed."
      ;;
    uninstall)
      launchctl bootout "$service" 2>/dev/null || true
      if [[ -f "$target_plist" ]]; then
        disable_definition "$target_plist"
      fi
      echo "Uninstalled $label"
      ;;
    render)
      output_path="${2:-$red_root/data/$label.plist}"
      mkdir -p "$(dirname "$output_path")"
      render_plist "$output_path"
      echo "Rendered $output_path"
      ;;
    *) usage ;;
  esac
}

# ---------------------------------------------------------------- Linux

render_unit() {
  local output_path="$1"
  local node_dir="${node_binary%/*}"
  local unit_path="$node_dir:/usr/local/bin:/usr/bin:/bin"
  local temporary_path
  temporary_path="$(mktemp "${TMPDIR:-/tmp}/red-gateway-unit.XXXXXX")"

  cat > "$temporary_path" <<UNIT
[Unit]
Description=Red gateway scheduler
After=network.target

[Service]
Type=simple
ExecStart=$node_binary $red_root/gateway/red-gateway.ts
WorkingDirectory=$red_root
Environment=PATH=$unit_path
Restart=always
RestartSec=5
StandardOutput=append:$red_root/data/logs/red-gateway.log
StandardError=append:$red_root/data/logs/red-gateway.error.log

[Install]
WantedBy=default.target
UNIT

  mv "$temporary_path" "$output_path"
}

linux_main() {
  case "${1:-status}" in
    install)
      mkdir -p "$systemd_user_dir" "$red_root/data/logs"
      systemctl --user stop "$unit_name" 2>/dev/null || true
      render_unit "$target_unit"
      systemctl --user daemon-reload
      systemctl --user enable --now "$unit_name"
      wait_for_gateway
      # Without lingering the user manager stops at logout, taking the
      # always-on scheduler with it.
      if ! loginctl show-user "$(id -un)" --property=Linger 2>/dev/null | grep -q "Linger=yes"; then
        echo "Note: enable lingering so the gateway survives logout and starts at boot:"
        echo "  sudo loginctl enable-linger $(id -un)"
      fi
      echo "Installed and started $unit_name"
      ;;
    restart)
      systemctl --user restart "$unit_name"
      wait_for_gateway
      echo "Restarted $unit_name"
      ;;
    status) systemctl --user status "$unit_name" ;;
    stop)
      systemctl --user stop "$unit_name"
      echo "Stopped $unit_name; the unit remains installed."
      ;;
    uninstall)
      systemctl --user disable --now "$unit_name" 2>/dev/null || true
      if [[ -f "$target_unit" ]]; then
        disable_definition "$target_unit"
      fi
      systemctl --user daemon-reload
      echo "Uninstalled $unit_name"
      ;;
    render)
      output_path="${2:-$red_root/data/$unit_name}"
      mkdir -p "$(dirname "$output_path")"
      render_unit "$output_path"
      echo "Rendered $output_path"
      ;;
    *) usage ;;
  esac
}

usage() {
  echo "Usage: $0 {install|restart|status|stop|uninstall|render [path]}" >&2
  exit 2
}

case "$platform" in
  Darwin) darwin_main "$@" ;;
  Linux) linux_main "$@" ;;
  *)
    printf '%s\n' "Unsupported platform: $platform (macOS launchd and Linux systemd only)." >&2
    exit 1
    ;;
esac
