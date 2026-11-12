#!/usr/bin/env bash
# install-server.sh — install the headless AASC server from its release tarball (terminal-editions P4.2).
#
# Download BOTH files from the release page, then run this script on them:
#
#   ai-agent-session-center-<version>-node22-linux-x64.tgz
#   ai-agent-session-center-<version>-node22-linux-x64.tgz.sha256
#
#   bash install-server.sh ai-agent-session-center-<version>-node22-linux-x64.tgz
#
# It refuses unless the SHA-256 matches (the .sha256 file beside the tarball, or --sha256 <hex>), jq is
# installed, and `node` is the major the tarball's native modules were compiled for. Then it unpacks
# to ~/.local/share/aasc-server/<version>, points ~/.local/share/aasc-server/current at that version in
# one rename, and links ~/.local/bin/aasc-server to it. Older versions stay until you remove them, so
# going back is pointing `current` at one again. Nothing here needs root.

set -euo pipefail

INSTALL_ROOT="$HOME/.local/share/aasc-server"
BIN_DIR="$HOME/.local/bin"

die() {
  printf 'install-server: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: install-server.sh <tarball> [--sha256 <hex>]

  <tarball>         ai-agent-session-center-<version>-node<major>-linux-x64.tgz
  --sha256 <hex>    the expected SHA-256; without it, <tarball>.sha256 must sit beside the tarball
USAGE
}

# rename(2) over an existing symlink is atomic; `ln -sfn` unlinks first, and BSD mv has no -T.
atomic_rename() {
  node -e 'require("fs").renameSync(process.argv[1], process.argv[2])' "$1" "$2"
}

tarball=""
expected=""
while [ $# -gt 0 ]; do
  case "$1" in
    --sha256)
      [ $# -ge 2 ] || die "--sha256 needs a value"
      expected="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*) die "unknown option: $1" ;;
    *)
      [ -z "$tarball" ] || die "give one tarball"
      tarball="$1"
      shift
      ;;
  esac
done
if [ -z "$tarball" ]; then
  usage >&2
  exit 2
fi
[ -f "$tarball" ] || die "no such file: $tarball"

command -v node >/dev/null 2>&1 || die "node is not on PATH. Install Node 22 (NodeSource or nvm) first."
command -v jq >/dev/null 2>&1 || die "jq is not on PATH; the hook script needs it. Install it: sudo apt install jq"

# ── 1. The checksum ─────────────────────────────────────────────────────────
if [ -z "$expected" ]; then
  sumfile="$tarball.sha256"
  [ -f "$sumfile" ] || die "no checksum: put $(basename "$tarball").sha256 beside the tarball, or pass --sha256 <hex>"
  read -r expected _ <"$sumfile" || true
fi
expected="$(printf '%s' "$expected" | tr 'A-F' 'a-f')"
case "$expected" in
  '' | *[!0-9a-f]*) die "not a SHA-256: '$expected'" ;;
esac
[ "${#expected}" -eq 64 ] || die "not a SHA-256: '$expected'"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tarball" | cut -d ' ' -f 1)"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$tarball" | cut -d ' ' -f 1)"
else
  die "neither sha256sum nor shasum is installed"
fi
[ "$actual" = "$expected" ] || die "SHA-256 mismatch: expected $expected, got $actual. The download is damaged or not the release; nothing was installed."

# ── 2. Unpack beside the versions (one filesystem, so placing it is a rename) ──
mkdir -p "$INSTALL_ROOT"
staging="$(mktemp -d "$INSTALL_ROOT/.install.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
tar -xzf "$tarball" -C "$staging"
pkg="$staging/package"
[ -f "$pkg/package.json" ] || die "not a server tarball: it has no package/package.json"

name="$(jq -r '.name // empty' "$pkg/package.json")"
version="$(jq -r '.version // empty' "$pkg/package.json")"
range="$(jq -r '.engines.node // empty' "$pkg/package.json")"
bin="$(jq -r '.bin["aasc-server"] // empty' "$pkg/package.json")"
if [ "$name" != "ai-agent-session-center" ] || [ -z "$bin" ]; then
  die "not a server tarball: no aasc-server command in its package.json"
fi
# The version becomes a folder name and the command a path: nothing that could climb out.
printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$' || die "unexpected version: '$version'"
case "$bin" in
  /* | *..*) die "unexpected command path: '$bin'" ;;
esac
[ -d "$pkg/node_modules" ] || die "this is the npm package, which carries no compiled modules. Install it with: npm install -g $tarball"

# ── 3. Node: the major the native modules were compiled for, and the minimum ──
lower="$(printf '%s' "$range" | sed -n 's/^>=\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p')"
[ -n "$lower" ] || die "unexpected engines range: '$range'"
want="${lower%%.*}"
have="$(node -p 'process.versions.node.split(".")[0]')"
[ "$have" = "$want" ] || die "this tarball's native modules need Node $want; this node is $(node -v). Install Node $want (nvm install $want), or use: npm install -g ai-agent-session-center"
node -e '
  const [a, b] = process.argv.slice(1).map((v) => v.split(".").map(Number));
  process.exit((a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) < 0 ? 1 : 0);
' "$(node -p 'process.versions.node')" "$lower" || die "Node $(node -v) is older than $lower, which this tarball needs"

# Checked before anything is placed, so a refusal leaves no half-installed version.
if [ -e "$BIN_DIR/aasc-server" ] && [ ! -L "$BIN_DIR/aasc-server" ]; then
  die "$BIN_DIR/aasc-server exists and is not this installer's link; remove it and run this again"
fi

# ── 4. Place the version, then switch `current` and the command in one rename each ──
dest="$INSTALL_ROOT/$version"
if [ -e "$dest" ]; then
  # Reinstalling the same version: the old copy is removed with the staging folder.
  mv "$dest" "$staging/previous"
fi
mv "$pkg" "$dest"
chmod +x "$dest/$bin"

ln -s "$version" "$INSTALL_ROOT/.current.$$"
atomic_rename "$INSTALL_ROOT/.current.$$" "$INSTALL_ROOT/current"

mkdir -p "$BIN_DIR"
ln -s "$INSTALL_ROOT/current/$bin" "$BIN_DIR/.aasc-server.$$"
atomic_rename "$BIN_DIR/.aasc-server.$$" "$BIN_DIR/aasc-server"

printf 'Installed aasc-server %s in %s\n' "$version" "$dest"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    # shellcheck disable=SC2016 # $PATH is meant literally: it's a line for the user's profile.
    printf 'Add %s to your PATH (e.g. in ~/.profile): export PATH="%s:$PATH"\n' "$BIN_DIR" "$BIN_DIR"
    ;;
esac
cat <<'NEXT'
Next:
  aasc-server setup             the setup wizard, with the dashboard password
  aasc-server install-service   run it as a systemd user service
  aasc-server doctor            check the install
NEXT
