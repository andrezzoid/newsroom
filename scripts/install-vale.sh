#!/bin/sh
# Installs the Vale that scripts/gates.sh needs into the directory given as $1,
# or ~/.local/bin. CI runs it, and so can a cloud session's setup. It does
# nothing when that directory already holds this version.
set -eu

# gates.sh needs Vale 3.24 or later; bump both lines together.
VALE_VERSION=3.24.0
VALE_SHA256=867534ddb678abca7f214bc4706ead0922bd5252ffe8035fc227013f66c8b214

dir=${1:-"$HOME/.local/bin"}
if [ -x "$dir/vale" ] && "$dir/vale" --version | grep -q "$VALE_VERSION"; then
  exit 0
fi

if [ "$(uname -s)-$(uname -m)" != Linux-x86_64 ]; then
  echo "install-vale.sh: this script only installs on Linux x86_64. Install Vale $VALE_VERSION or later yourself, for example with brew install vale." >&2
  exit 1
fi

tarball="vale_${VALE_VERSION}_Linux_64-bit.tar.gz"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/$tarball" \
  "https://github.com/errata-ai/vale/releases/download/v$VALE_VERSION/$tarball"
echo "$VALE_SHA256  $tmp/$tarball" | sha256sum -c -
mkdir -p "$dir"
tar -xzf "$tmp/$tarball" -C "$dir" vale
