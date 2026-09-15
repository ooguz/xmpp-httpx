#!/bin/sh
# Installs (or, with --uninstall, removes) the httpx Dillo plugin for the
# current user. Run it from the unpacked package directory; it needs only
# the files next to it.
#
# What it writes:
#   ~/.local/share/httpx-dpi/httpx.js    the plugin, one bundled file
#   ~/.dillo/dpi/httpx/httpx.dpi         the launcher dpid execs (finds node
#                                        at run time; see the file)
#   ~/.dillo/dpidrc                      `proto.httpx=httpx/httpx.dpi` routes
#                                        the scheme; created from the system
#                                        file when you have none
#   ~/.dillo/httpx.json                  the account, from the example, if
#                                        missing; edit it or use dpi:/httpx/
# Then `dpidc register` (when dpid is running) so it re-reads dpidrc. The
# plugin starts on the first httpx:// request.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
DILLO_DIR=${DILLO_DIR:-$HOME/.dillo}
LIB_DIR=${HTTPX_DPI_LIB_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/httpx-dpi}
RC="$DILLO_DIR/dpidrc"
PLUGIN_DIR="$DILLO_DIR/dpi/httpx"
LINE="proto.httpx=httpx/httpx.dpi"

if [ "${1:-}" = "--uninstall" ]; then
  rm -rf "$PLUGIN_DIR" "$LIB_DIR"
  if [ -f "$RC" ]; then
    grep -v "^proto.httpx=" "$RC" > "$RC.tmp" || true   # grep exits 1 when nothing is left
    mv "$RC.tmp" "$RC"
  fi
  command -v dpidc >/dev/null 2>&1 && dpidc register >/dev/null 2>&1 || true
  echo "removed $PLUGIN_DIR, $LIB_DIR and the proto.httpx line from $RC"
  echo "kept $DILLO_DIR/httpx.json (your account); delete it yourself if you want"
  exit 0
fi

for needed in "$HERE/httpx.dpi" "$HERE/lib/httpx.js" "$HERE/httpx.json.example"; do
  if [ ! -f "$needed" ]; then
    echo "install.sh: $needed is missing; run this from the unpacked package" >&2
    exit 1
  fi
done

if ! command -v node >/dev/null 2>&1 && ! ls "$HOME"/.nvm/versions/node/*/bin/node >/dev/null 2>&1; then
  echo "install.sh: warning: no node found on PATH or under ~/.nvm; the plugin needs Node.js 20+" >&2
fi

mkdir -p "$LIB_DIR" "$PLUGIN_DIR"
cp "$HERE/lib/httpx.js" "$LIB_DIR/httpx.js"
cp "$HERE/httpx.dpi" "$PLUGIN_DIR/httpx.dpi"
chmod 755 "$PLUGIN_DIR/httpx.dpi"

if [ ! -f "$RC" ]; then
  SYS_RC=""
  for candidate in /etc/dillo/dpidrc /usr/local/etc/dillo/dpidrc; do
    [ -f "$candidate" ] && SYS_RC=$candidate && break
  done
  if [ -z "$SYS_RC" ]; then
    echo "install.sh: no $RC and no system dpidrc found; is Dillo installed?" >&2
    exit 1
  fi
  mkdir -p "$DILLO_DIR"
  cp "$SYS_RC" "$RC"
fi
if ! grep -q "^proto.httpx=" "$RC"; then
  printf '\n%s\n' "$LINE" >> "$RC"
fi

if [ ! -f "$DILLO_DIR/httpx.json" ]; then
  cp "$HERE/httpx.json.example" "$DILLO_DIR/httpx.json"
  chmod 600 "$DILLO_DIR/httpx.json"
  echo "wrote $DILLO_DIR/httpx.json with the demo account; edit it, or open dpi:/httpx/ in Dillo"
fi

# A running dpid keeps its old service list until told otherwise.
if command -v dpidc >/dev/null 2>&1; then
  dpidc register >/dev/null 2>&1 || true
fi

echo "installed $PLUGIN_DIR/httpx.dpi and $LIB_DIR/httpx.js"
echo "routed httpx:// via $RC"
echo "open httpx://… or dpi:/httpx/ in Dillo"
