#!/usr/bin/env bash
# Release body: the version's CHANGELOG section, then how to install or update.
set -euo pipefail

version="${1:?usage: release-notes.sh <version>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bash "$here/changelog-section.sh" "$version"
cat <<'NOTES'

---

### Install or update

**Linux:** one command installs Qyra, and running it again updates it, whether
Qyra came from the `.deb`, the `.rpm`, the Arch `qyra-bin` package or the
AppImage. Every download's sha256 is checked against this release.

```bash
curl -fsSL https://raw.githubusercontent.com/zParik/Qyra/main/scripts/install.sh | bash
```

**Windows:** run the `.exe` or `.msi` below; it upgrades an existing install.
NOTES
