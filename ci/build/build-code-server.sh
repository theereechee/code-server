#!/usr/bin/env bash
set -euo pipefail

# Builds code-server into out and the frontend into dist.

# MINIFY controls whether parcel minifies dist.
MINIFY=${MINIFY-true}

main() {
  cd "$(dirname "${0}")/../.."

  tsc

  # If out/node/entry.js does not already have the shebang,
  # we make sure to add it and make it executable.
  if ! grep -q -m1 "^#!/usr/bin/env node" out/node/entry.js; then
    sed -i.bak "1s;^;#!/usr/bin/env node\n;" out/node/entry.js && rm out/node/entry.js.bak
    chmod +x out/node/entry.js
  fi

  if ! [ -f ./lib/coder-cloud-agent ]; then
    OS="$(uname | tr '[:upper:]' '[:lower:]')"
    set +e
    curl -fsSL "https://storage.googleapis.com/coder-cloud-releases/agent/latest/$OS/cloud-agent" -o ./lib/coder-cloud-agent
    chmod +x ./lib/coder-cloud-agent
    set -e
  fi

  parcel build \
    --public-url "." \
    --out-dir dist \
    $([[ $MINIFY ]] || echo --no-minify) \
    src/browser/register.ts \
    src/browser/serviceWorker.ts \
    src/browser/pages/login.ts \
    src/browser/pages/vscode.ts
}

main "$@"
