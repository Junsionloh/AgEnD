#!/usr/bin/env bash
# Usage: make-bundle.sh <repo-dir> <out-dir>
# Builds the Windows Runtime bundle the way tests/runtime-bundle-closed.test.ts does: a portable compile of the bundle's modules, then scripts/build-runtime.mjs.
# The bundle is <out-dir>/bundle.
set -euo pipefail
repo=$(cd "$1" && pwd); out=$(mkdir -p "$2" && cd "$2" && pwd)
rm -rf "$out/compiled" "$out/bundle"
cd "$repo"
npx tsx -e 'import { compilePortableRuntime } from "./tests/support/runtime-portable-compile.ts"; compilePortableRuntime(process.argv[1] + "/compiled");' "$out"
cp -r src/general-knowledge "$out/compiled/general-knowledge"
node scripts/build-runtime.mjs "$out/bundle" "$out/compiled" | tail -1
