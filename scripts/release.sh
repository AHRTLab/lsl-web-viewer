#!/usr/bin/env bash
# Prepare a release: rebuild the page into lsl_web_viewer/static/ (the copy pip installs), run the
# tests, and print the tagging steps. Nothing is committed, tagged or pushed for you.
#
#   ./scripts/release.sh            # build + test
#   ./scripts/release.sh --no-test  # build only
set -euo pipefail

cd "$(dirname "$0")/.."
PY="${PYTHON:-.venv/bin/python}"
VERSION="$(sed -nE 's/^version = "(.+)"/\1/p' pyproject.toml | head -1)"
INIT_VERSION="$(sed -nE 's/^__version__ = "(.+)"/\1/p' lsl_web_viewer/__init__.py)"
if [ "$VERSION" != "$INIT_VERSION" ]; then
  echo "version mismatch: pyproject.toml has $VERSION, lsl_web_viewer/__init__.py has $INIT_VERSION" >&2
  exit 1
fi

echo "==> Building the page into lsl_web_viewer/static/ (v${VERSION})"
npm --prefix web ci
npm --prefix web run build

if [ "${1:-}" != "--no-test" ]; then
  echo "==> Tests"
  "$PY" -m pytest -q
  npm --prefix web test
  npm --prefix web run build:demo
  (cd web && npx playwright test)
fi

echo
echo "==> Ready. If lsl_web_viewer/static/ changed, commit it, then tag and push:"
echo "      git add lsl_web_viewer/static && git commit -m \"Build page for v${VERSION}\""
echo "      git tag -a v${VERSION} -m \"lsl-web-viewer ${VERSION}\""
echo "      git push origin main v${VERSION}"
echo "    Install line for other projects:"
echo "      lsl-web-viewer @ git+https://github.com/AHRTLab/lsl-web-viewer@v${VERSION}"
