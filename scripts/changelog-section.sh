#!/usr/bin/env bash
set -euo pipefail

version="${1:?usage: changelog-section.sh <version>}"
version="${version#v}"
file="${CHANGELOG_FILE:-CHANGELOG.md}"

section="$(awk -v ver="$version" '
  /^## \[/ {
    if (inblock) exit
    if ($0 ~ "^## \\[" ver "\\]") { inblock=1; print; next }
  }
  inblock { print }
' "$file")"

if [ -z "$section" ]; then
  echo "changelog-section: no section for version '$version' in $file" >&2
  exit 1
fi

printf '%s\n' "$section"
