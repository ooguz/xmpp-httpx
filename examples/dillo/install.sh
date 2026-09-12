#!/bin/sh
# Installs (or, with --uninstall, removes) the httpx dpi for the current user.
#
# What Dillo needs, and what this writes:
#   ~/.dillo/dpi/httpx/httpx.dpi     the plugin program dpid execs — a two-line
#                                    launcher with the absolute node path baked
#                                    in, because dpid's PATH is whatever Dillo's
#                                    was (an nvm node is not on it)
#   ~/.dillo/dpidrc                  `proto.httpx=httpx/httpx.dpi` routes the
#                                    scheme here; created from the system file
#                                    when the user has none
#   ~/.dillo/httpx.json              the account — copied from the example if
#                                    missing, for you to edit
# Then `dpidc register` (if dpid is running) so it re-reads dpidrc; the plugin
# starts on the first httpx:// request.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
DILLO_DIR=${DILLO_DIR:-$HOME/.dillo}
RC="$DILLO_DIR/dpidrc"
PLUGIN_DIR="$DILLO_DIR/dpi/httpx"
LAUNCHER="$PLUGIN_DIR/httpx.dpi"
LINE="proto.httpx=httpx/httpx.dpi"

if [ "${1:-}" = "--uninstall" ]; then
  rm -rf "$PLUGIN_DIR"
  if [ -f "$RC" ]; then
    grep -v "^proto.httpx=" "$RC" > "$RC.tmp" || true   # grep exits 1 when nothing is left
    mv "$RC.tmp" "$RC"
  fi
  command -v dpidc >/dev/null 2>&1 && dpidc register >/dev/null 2>&1 || true
  echo "removed $PLUGIN_DIR and the proto.httpx line from $RC"
  exit 0
fi

NODE=$(command -v node || true)
if [ -z "$NODE" ]; then
  echo "install.sh: node is not on PATH" >&2
  exit 1
fi
if [ ! -f "$HERE/dist/main.js" ]; then
  echo "install.sh: build first — npm install && npm run build (in $HERE)" >&2
  exit 1
fi

mkdir -p "$PLUGIN_DIR"
cat > "$LAUNCHER" <<EOF
#!/bin/sh
exec "$NODE" "$HERE/dist/main.js"
EOF
chmod 755 "$LAUNCHER"

if [ ! -f "$RC" ]; then
  SYS_RC=""
  for candidate in /etc/dillo/dpidrc /usr/local/etc/dillo/dpidrc; do
    [ -f "$candidate" ] && SYS_RC=$candidate && break
  done
  if [ -z "$SYS_RC" ]; then
    echo "install.sh: no $RC and no system dpidrc found; is Dillo installed?" >&2
    exit 1
  fi
  cp "$SYS_RC" "$RC"
fi
if ! grep -q "^proto.httpx=" "$RC"; then
  printf '\n%s\n' "$LINE" >> "$RC"
fi

if [ ! -f "$DILLO_DIR/httpx.json" ]; then
  cp "$HERE/httpx.json.example" "$DILLO_DIR/httpx.json"
  chmod 600 "$DILLO_DIR/httpx.json"
  echo "wrote $DILLO_DIR/httpx.json — edit it with your account"
fi

# A running dpid keeps its old service list until told otherwise.
if command -v dpidc >/dev/null 2>&1; then
  dpidc register >/dev/null 2>&1 || true
fi

echo "installed $LAUNCHER"
echo "routed httpx:// via $RC"
echo "open httpx://… in Dillo"
