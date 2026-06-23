#!/bin/sh
# Reviewgate installer.  Usage:
#   curl -sSL https://raw.githubusercontent.com/Codevena/reviewgate/master/install.sh | sh
#
# Downloads the matching prebuilt binary from GitHub Releases, verifies its
# SHA-256, and symlinks it onto your PATH. No sudo, no build step, no Bun needed.
#
# Env overrides:
#   REVIEWGATE_VERSION       pin a tag (default: newest release, incl. pre-releases)
#   REVIEWGATE_INSTALL_DIR   where the binary tree lives  (default: $HOME/.reviewgate)
#   REVIEWGATE_BIN_DIR       where the `reviewgate` symlink goes (default: $HOME/.local/bin)
set -eu

REPO="Codevena/reviewgate"
INSTALL_DIR="${REVIEWGATE_INSTALL_DIR:-$HOME/.reviewgate}"
BIN_DIR="${REVIEWGATE_BIN_DIR:-$HOME/.local/bin}"

info() { printf '\033[36m›\033[0m %s\n' "$1"; }
err()  { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || err "curl is required"
command -v tar  >/dev/null 2>&1 || err "tar is required"

# --- platform -------------------------------------------------------------
os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) os=darwin ;;
  Linux)  os=linux ;;
  *) err "unsupported OS '$os' — macOS and Linux only (Windows: use WSL2)" ;;
esac
case "$arch" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64)  arch=x64 ;;
  *) err "unsupported architecture '$arch'" ;;
esac
platform="${os}-${arch}"

# --- resolve version ------------------------------------------------------
if [ -n "${REVIEWGATE_VERSION:-}" ]; then
  tag="$REVIEWGATE_VERSION"
else
  info "resolving the latest release…"
  # /releases lists pre-releases too (the project is in alpha); newest is first.
  tag=$(curl -fsSL "https://api.github.com/repos/$REPO/releases" \
        | grep -m1 '"tag_name"' \
        | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
  [ -n "$tag" ] || err "could not resolve the latest release tag (GitHub API rate limit? set REVIEWGATE_VERSION)"
fi

asset="reviewgate-${tag}-${platform}.tar.gz"
base="https://github.com/$REPO/releases/download/$tag"
info "installing reviewgate $tag ($platform)"

# --- download (binary + checksums) ----------------------------------------
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
info "downloading ${asset}…"
curl -fSL --progress-bar "$base/$asset" -o "$tmp/$asset" || err "download failed: $base/$asset"
curl -fsSL "$base/SHA256SUMS.txt" -o "$tmp/SHA256SUMS.txt" || err "could not fetch SHA256SUMS.txt"

# --- verify SHA-256 -------------------------------------------------------
info "verifying checksum…"
want=$(awk -v f="$asset" '$2==f {print $1}' "$tmp/SHA256SUMS.txt")
[ -n "$want" ] || err "no checksum listed for $asset"
if command -v sha256sum >/dev/null 2>&1; then
  got=$(sha256sum "$tmp/$asset" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  got=$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')
else
  err "need 'sha256sum' or 'shasum' to verify the download"
fi
[ "$want" = "$got" ] || err "CHECKSUM MISMATCH for $asset — refusing to install (expected $want, got $got)"

# --- install --------------------------------------------------------------
dest="$INSTALL_DIR/$tag"
info "installing to $dest"
rm -rf "$dest"
mkdir -p "$dest"
# The tarball has one top-level dir (binary + sibling grammars/ the binary loads
# at runtime); strip it so the tree lands directly in $dest.
tar -xzf "$tmp/$asset" -C "$dest" --strip-components=1
[ -x "$dest/reviewgate" ] || err "extracted tree is missing the reviewgate binary"

mkdir -p "$BIN_DIR"
ln -sf "$dest/reviewgate" "$BIN_DIR/reviewgate"

# --- done -----------------------------------------------------------------
ver=$("$BIN_DIR/reviewgate" --version 2>/dev/null || echo "?")
printf '\n\033[32m✓ reviewgate %s installed\033[0m → %s/reviewgate\n' "$ver" "$BIN_DIR"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf '\n\033[33m⚠ %s is not on your PATH.\033[0m Add it (then restart your shell):\n    export PATH="%s:$PATH"\n' "$BIN_DIR" "$BIN_DIR" ;;
esac
printf '\nNext:\n  reviewgate doctor   # which reviewers are ready + what to fix\n  reviewgate init     # arm a repo (installs the Claude Code hooks)\n'
