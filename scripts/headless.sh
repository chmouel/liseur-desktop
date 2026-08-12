#!/usr/bin/env bash
# Runs a command against a nested, hidden compositor, so the end-to-end tests
# do not take over the screen and the keyboard of whoever is sitting here.
#
#   scripts/headless.sh pnpm test:e2e
#
# Falls through to running the command unchanged when there is no Wayland
# session to nest inside — CI has its own arrangements, and macOS has none.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 64
fi

if [ "$(uname -s)" != Linux ] || [ -z "${WAYLAND_DISPLAY:-}" ] || ! command -v sway >/dev/null 2>&1; then
  exec "$@"
fi

work=$(mktemp -d -t liseur-headless.XXXXXX)
sway_pid=""
cleanup() {
  [ -n "$sway_pid" ] && kill "$sway_pid" 2>/dev/null
  rm -rf "$work"
  return 0
}
trap cleanup EXIT

# Which socket the compositor gets is up to whichever names happen to be free,
# and stale socket files from earlier runs make it impossible to guess from
# outside. So it is asked rather than guessed: sway sets WAYLAND_DISPLAY for
# anything it starts, and the first thing it starts writes it down.
cat >"$work/sway.conf" <<EOF
output HEADLESS-1 mode 1600x1000
exec printenv WAYLAND_DISPLAY > $work/display
EOF

# DISPLAY, WAYLAND_DISPLAY and SWAYSOCK all still name the real session. The
# nested compositor must inherit none of them: it is starting its own.
env -u DISPLAY -u WAYLAND_DISPLAY -u SWAYSOCK \
  WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 \
  sway -c "$work/sway.conf" >"$work/sway.log" 2>&1 &
sway_pid=$!

for _ in $(seq 1 100); do
  [ -s "$work/display" ] && break
  kill -0 "$sway_pid" 2>/dev/null || break
  sleep 0.1
done

if [ ! -s "$work/display" ]; then
  echo "could not start a nested compositor; its output was:" >&2
  cat "$work/sway.log" >&2
  exit 1
fi
display=$(cat "$work/display")

# SWAYSOCK is unset rather than repointed: nothing here needs to send the
# compositor commands, and leaving the real session's socket in the
# environment is how a stray swaymsg ends up rearranging somebody's desktop.
env -u DISPLAY -u SWAYSOCK WAYLAND_DISPLAY="$display" "$@"
