#!/usr/bin/env bash
# Install Qyra for the current user on any x86_64 Linux distribution.
#
#   curl -fsSL https://raw.githubusercontent.com/zParik/Qyra/main/scripts/install.sh | bash
#
# Downloads the latest release's AppImage into ~/.local/bin/qyra, adds a menu
# entry and icon, and registers Qyra as an app that opens PDFs. Run it again to
# update. Nothing is installed system-wide and no root is needed.
#
# Options:
#   --default     also make Qyra the default app for PDFs
#   --uninstall   remove everything this script installed
set -euo pipefail

REPO="zParik/Qyra"
API="https://api.github.com/repos/$REPO/releases/latest"
ICON_URL="https://raw.githubusercontent.com/$REPO/main/src-tauri/icons/128x128.png"

BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
APP_DIR="$DATA_DIR/applications"
ICON_DIR="$DATA_DIR/icons/hicolor/128x128/apps"
BIN="$BIN_DIR/qyra"
DESKTOP="$APP_DIR/qyra.desktop"
ICON="$ICON_DIR/qyra.png"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

refresh_menus() {
  command -v update-desktop-database >/dev/null && update-desktop-database -q "$APP_DIR" || true
  command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$DATA_DIR/icons/hicolor" 2>/dev/null || true
}

make_default=0
case "${1:-}" in
  --default) make_default=1 ;;
  --uninstall)
    rm -f "$BIN" "$DESKTOP" "$ICON"
    refresh_menus
    say "Qyra removed. Your settings and recent files are kept in ~/.local/share/com.parik.qyra."
    exit 0
    ;;
  "") ;;
  *) die "unknown option '$1' (use --default or --uninstall)" ;;
esac

[ "$(uname -s)" = "Linux" ] || die "this installer is for Linux. Windows installers are on https://github.com/$REPO/releases/latest"
[ "$(uname -m)" = "x86_64" ] || die "Qyra is built for x86_64 only; this machine is $(uname -m)."
command -v curl >/dev/null || die "curl is required."

say "Looking up the latest Qyra release"
release="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API")" || die "could not reach GitHub."

# Pull the AppImage's URL and sha256 out of the JSON without needing jq. Each
# asset lists its "digest" before its "browser_download_url".
read -r url digest < <(printf '%s\n' "$release" | awk '
  /"digest":/ { d = $0; sub(/.*"sha256:/, "", d); sub(/".*/, "", d) }
  /"browser_download_url":.*\.AppImage"/ {
    u = $0; sub(/.*"browser_download_url": *"/, "", u); sub(/".*/, "", u)
    print u, (d == "" ? "-" : d); exit
  }
  /"name":/ { d = "" }
') || true
[ "${digest:-}" = "-" ] && digest=""
tag="$(printf '%s\n' "$release" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
[ -n "${url:-}" ] || die "the latest release has no AppImage."

mkdir -p "$BIN_DIR" "$APP_DIR" "$ICON_DIR"
tmp="$(mktemp "$BIN_DIR/.qyra.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

say "Downloading Qyra $tag"
curl -fL --progress-bar -o "$tmp" "$url" || die "download failed."

if [ -n "$digest" ]; then
  echo "$digest  $tmp" | sha256sum -c --quiet - || die "the download's checksum does not match the release; nothing was installed."
else
  warn "The release lists no checksum for the AppImage; skipping verification."
fi

chmod 755 "$tmp"
mv -f "$tmp" "$BIN"
trap - EXIT

curl -fsSL -o "$ICON" "$ICON_URL" || warn "Could not download the icon; the menu entry will show a generic one."

cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=Qyra
Comment=Free, offline PDF app for Linux and Windows
Exec="$BIN" %f
Icon=qyra
Terminal=false
Categories=Office;Viewer;
MimeType=application/pdf;
StartupWMClass=qyra
EOF
refresh_menus

if [ "$make_default" = 1 ]; then
  if command -v xdg-mime >/dev/null; then
    xdg-mime default qyra.desktop application/pdf
    say "Qyra now opens PDFs by default."
  else
    warn "xdg-mime is missing, so the default PDF app was not changed."
  fi
fi

say "Installed Qyra $tag to $BIN"

# AppImages need FUSE 2 to mount themselves.
if ! { ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; } && [ ! -e /usr/lib/libfuse.so.2 ] && [ ! -e /usr/lib/x86_64-linux-gnu/libfuse.so.2 ]; then
  warn "FUSE 2 was not found, and the AppImage needs it to start. Install it with:"
  if command -v pacman >/dev/null; then warn "  sudo pacman -S fuse2"
  elif command -v apt-get >/dev/null; then warn "  sudo apt install libfuse2   (libfuse2t64 on Ubuntu 24.04)"
  elif command -v dnf >/dev/null; then warn "  sudo dnf install fuse-libs"
  elif command -v zypper >/dev/null; then warn "  sudo zypper install libfuse2"
  else warn "  your distribution's FUSE 2 package (libfuse.so.2)"
  fi
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH. Qyra is in your app menu; to run 'qyra' from a terminal, add $BIN_DIR to PATH." ;;
esac

say "Open it from your app menu, or run: qyra file.pdf"
