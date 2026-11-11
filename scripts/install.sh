#!/usr/bin/env bash
# Install or update Qyra on any x86_64 Linux distribution.
#
#   curl -fsSL https://raw.githubusercontent.com/zParik/Qyra/main/scripts/install.sh | bash
#
# Run it again at any time to update. It updates Qyra the way it is installed:
#   - from the .deb, .rpm or Arch (qyra-bin) package: updates that package
#     (asks for your password, as the package manager does);
#   - otherwise: puts the latest AppImage in ~/.local/bin/qyra with a menu
#     entry and icon, for your user only, no root needed.
#
# Options:
#   --default     also make Qyra the default app for PDFs
#   --appimage    use the per-user AppImage even if a system package is installed
#   --force       reinstall even if this version is already installed
#   --uninstall   remove the AppImage install this script made
set -euo pipefail

REPO="zParik/Qyra"
API="https://api.github.com/repos/$REPO/releases/latest"
RAW="https://raw.githubusercontent.com/$REPO/main"
ICON_URL="$RAW/src-tauri/icons/128x128.png"

BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
APP_DIR="$DATA_DIR/applications"
ICON_DIR="$DATA_DIR/icons/hicolor/128x128/apps"
BIN="$BIN_DIR/qyra"
DESKTOP="$APP_DIR/qyra.desktop"
ICON="$ICON_DIR/qyra.png"
# The version the AppImage install holds, so a re-run knows whether to update.
VERSION_FILE="$DATA_DIR/qyra/installed-version"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

refresh_menus() {
  command -v update-desktop-database >/dev/null && update-desktop-database -q "$APP_DIR" || true
  command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$DATA_DIR/icons/hicolor" 2>/dev/null || true
}

make_default=0 force=0 want_appimage=0 uninstall=0
for arg in "$@"; do
  case "$arg" in
    --default) make_default=1 ;;
    --force) force=1 ;;
    --appimage) want_appimage=1 ;;
    --uninstall) uninstall=1 ;;
    *) die "unknown option '$arg' (use --default, --appimage, --force or --uninstall)" ;;
  esac
done

# ── What is installed already ────────────────────────────────────────────
pkg_kind="" pkg_ver=""
if command -v pacman >/dev/null && pacman -Qq qyra-bin >/dev/null 2>&1; then
  pkg_kind="pacman"; pkg_ver="$(pacman -Q qyra-bin | awk '{print $2}' | sed 's/-[0-9]*$//')"
elif command -v dpkg-query >/dev/null && dpkg-query -W -f='${Status}' qyra 2>/dev/null | grep -q "install ok installed"; then
  pkg_kind="deb"; pkg_ver="$(dpkg-query -W -f='${Version}' qyra)"
elif command -v rpm >/dev/null && rpm -q qyra >/dev/null 2>&1; then
  pkg_kind="rpm"; pkg_ver="$(rpm -q --qf '%{VERSION}' qyra)"
fi
appimage_ver=""
[ -x "$BIN" ] && appimage_ver="$(cat "$VERSION_FILE" 2>/dev/null || echo unknown)"

if [ "$uninstall" = 1 ]; then
  rm -f "$BIN" "$DESKTOP" "$ICON" "$VERSION_FILE"
  refresh_menus
  say "Removed the AppImage install. Your settings and recent files are kept in ~/.local/share/com.parik.qyra."
  case "$pkg_kind" in
    pacman) warn "Qyra is also installed as a package; remove it with: sudo pacman -R qyra-bin" ;;
    deb) warn "Qyra is also installed as a package; remove it with: sudo apt remove qyra" ;;
    rpm) warn "Qyra is also installed as a package; remove it with your package manager (for example: sudo dnf remove qyra)" ;;
  esac
  exit 0
fi

[ "$(uname -s)" = "Linux" ] || die "this installer is for Linux. On Windows, run in PowerShell: irm https://raw.githubusercontent.com/$REPO/main/scripts/install.ps1 | iex"
[ "$(uname -m)" = "x86_64" ] || die "Qyra is built for x86_64 only; this machine is $(uname -m)."
command -v curl >/dev/null || die "curl is required."

say "Looking up the latest Qyra release"
release="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API")" || die "could not reach GitHub."
tag="$(printf '%s\n' "$release" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
version="${tag#v}"
[ -n "$version" ] || die "could not read the latest version from GitHub."

# "url sha256" of the first asset whose download URL matches the regex. Read
# without jq: each asset lists its "digest" before its "browser_download_url".
asset() {
  printf '%s\n' "$release" | awk -v re="$1" '
    /"digest":/ { d = $0; sub(/.*"sha256:/, "", d); sub(/".*/, "", d) }
    /"browser_download_url":/ {
      u = $0; sub(/.*"browser_download_url": *"/, "", u); sub(/".*/, "", u)
      if (u ~ re) { print u, (d == "" ? "-" : d); exit }
    }
    /"name":/ { d = "" }
  '
}

# Download the asset matching $1 to $2 and check it against the release.
fetch() {
  local url digest
  read -r url digest < <(asset "$1") || true
  [ -n "${url:-}" ] || die "the $tag release has no file matching $1."
  say "Downloading $(basename "$url")"
  curl -fL --progress-bar -o "$2" "$url" || die "download failed."
  if [ -n "${digest:-}" ] && [ "$digest" != "-" ]; then
    echo "$digest  $2" | sha256sum -c --quiet - || die "the download's checksum does not match the release; nothing was installed."
  else
    warn "The release lists no checksum for $(basename "$url"); skipping verification."
  fi
}

running_note() {
  if pgrep -x qyra >/dev/null 2>&1; then
    warn "Qyra is running. Close and reopen it to use $version."
  fi
}

# ── Update a system package in place ─────────────────────────────────────
if [ -n "$pkg_kind" ] && [ "$want_appimage" = 0 ]; then
  if [ "$pkg_ver" = "$version" ] && [ "$force" = 0 ]; then
    say "Qyra $version is already installed and up to date."
    exit 0
  fi
  say "Updating the installed Qyra package from $pkg_ver to $version"
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  case "$pkg_kind" in
    deb)
      fetch '_amd64[.]deb$' "$work/qyra.deb"
      if command -v apt-get >/dev/null; then sudo apt-get install -y "$work/qyra.deb"
      else sudo dpkg -i "$work/qyra.deb"; fi
      ;;
    rpm)
      fetch '[.]x86_64[.]rpm$' "$work/qyra.rpm"
      if command -v dnf >/dev/null; then sudo dnf install -y "$work/qyra.rpm"
      elif command -v zypper >/dev/null; then sudo zypper --non-interactive install --allow-unsigned-rpm "$work/qyra.rpm"
      else sudo rpm -Uvh "$work/qyra.rpm"; fi
      ;;
    pacman)
      command -v makepkg >/dev/null || die "makepkg is needed to update qyra-bin (sudo pacman -S --needed base-devel), or run with --appimage."
      curl -fsSL -o "$work/PKGBUILD" "$RAW/packaging/aur/PKGBUILD" || die "could not download the PKGBUILD."
      pkgbuild_ver="$(sed -n 's/^pkgver=//p' "$work/PKGBUILD")"
      [ "$pkgbuild_ver" = "$version" ] || die "the Arch package for $version is not published yet (the PKGBUILD is at $pkgbuild_ver). Try again later, or run with --appimage."
      (cd "$work" && makepkg -si --noconfirm)
      ;;
  esac
  say "Qyra is now $version."
  if [ -x "$BIN" ]; then
    warn "There is also a per-user AppImage copy at $BIN. Remove it with: bash install.sh --uninstall"
  fi
  running_note
  exit 0
fi

# ── Per-user AppImage ────────────────────────────────────────────────────
if [ "$appimage_ver" = "$version" ] && [ "$force" = 0 ]; then
  say "Qyra $version is already installed and up to date."
  exit 0
fi
if [ -n "$pkg_kind" ]; then
  warn "Qyra $pkg_ver is also installed as a system package; you will have two copies in your app menu."
fi

mkdir -p "$BIN_DIR" "$APP_DIR" "$ICON_DIR" "$(dirname "$VERSION_FILE")"
tmp="$(mktemp "$BIN_DIR/.qyra.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
fetch '[.]AppImage$' "$tmp"
chmod 755 "$tmp"
# Replacing the file is safe while Qyra runs: the running copy keeps the old one.
mv -f "$tmp" "$BIN"
trap - EXIT
echo "$version" > "$VERSION_FILE"

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

if [ -n "$appimage_ver" ]; then
  say "Updated Qyra from $appimage_ver to $version"
else
  say "Installed Qyra $version to $BIN"
fi

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

running_note
say "Open it from your app menu, or run: qyra file.pdf"
