#!/bin/zsh

set -euo pipefail

script_path="${0:A}"
red_root="${script_path:h:h}"
pi_package="@earendil-works/pi-coding-agent@0.84.2"
minimum_node="22.19.0"
install_bin_dir="${RED_INSTALL_BIN_DIR:-$HOME/.local/bin}"

fail() {
  print -u2 "Setup failed: $1"
  exit 1
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  fail "the always-on scheduler currently requires macOS launchd."
fi

command -v node >/dev/null 2>&1 || fail "Node.js $minimum_node or newer is required."
command -v npm >/dev/null 2>&1 || fail "npm is required."

node -e '
const current = process.versions.node.split(".").map(Number);
const minimum = process.argv[1].split(".").map(Number);
for (let index = 0; index < 3; index += 1) {
  if (current[index] > minimum[index]) process.exit(0);
  if (current[index] < minimum[index]) process.exit(1);
}
' "$minimum_node" || fail "Node.js $minimum_node or newer is required; found $(node --version)."

if ! command -v pi >/dev/null 2>&1; then
  echo "Installing Pi $pi_package..."
  npm install --global "$pi_package"
fi

pi_version="$(pi --version)"
if [[ "$pi_version" != 0.84.* ]]; then
  echo "Warning: Red is tested with Pi 0.84.x; found $pi_version."
fi

echo "Installing Red's pinned dependencies..."
npm ci --prefix "$red_root/gateway"
npm ci --prefix "$red_root/.pi/npm"

chmod +x "$red_root/bin/red" "$red_root/gateway/red-gateway-control.sh"
mkdir -p "$install_bin_dir"

red_command="$install_bin_dir/red"
if [[ -e "$red_command" || -L "$red_command" ]]; then
  if [[ "${red_command:A}" != "${red_root}/bin/red" ]]; then
    fail "$red_command already exists and does not point to this checkout."
  fi
else
  ln -s "$red_root/bin/red" "$red_command"
fi

echo
echo "Red's code and dependencies are installed."
echo "Command: $red_command"

if [[ ":$PATH:" != *":$install_bin_dir:"* ]]; then
  echo "Add this line to ~/.zshrc, then open a new terminal:"
  echo "  export PATH=\"$install_bin_dir:\$PATH\""
fi

if pi auth check --provider openrouter >/dev/null 2>&1; then
  echo "OpenRouter authentication is ready."
  echo "Install the scheduler with:"
  echo "  $red_root/gateway/red-gateway-control.sh install"
else
  echo "Next, run 'pi', enter '/login openrouter', and finish authentication."
  echo "Then install the scheduler with:"
  echo "  $red_root/gateway/red-gateway-control.sh install"
fi
