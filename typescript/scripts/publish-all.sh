#!/bin/bash
set -e

# Publish to all registries: Verdaccio (local), npm (public), GitHub Packages.
# Builds once, publishes to each registry by temporarily swapping the
# @corpus-relica scope (npm --registry flag doesn't override scoped packages).
#
# Auth is expected in ~/.npmrc for each registry.
#
# Usage: ./scripts/publish-all.sh [--skip-local] [--skip-npm] [--skip-ghpkg]

SKIP_LOCAL=false
SKIP_NPM=false
SKIP_GHPKG=false

for arg in "$@"; do
  case $arg in
    --skip-local) SKIP_LOCAL=true ;;
    --skip-npm)   SKIP_NPM=true ;;
    --skip-ghpkg) SKIP_GHPKG=true ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

VERSION=$(node -p "require('./package.json').version")
PKG=$(node -p "require('./package.json').name")

echo "============================================="
echo "Publishing $PKG@$VERSION"
echo "============================================="
echo ""

# Save original registry scope and restore on exit
ORIGINAL=$(npm config get @corpus-relica:registry 2>/dev/null || echo "")
restore() {
  if [ -n "$ORIGINAL" ]; then
    npm config set @corpus-relica:registry "$ORIGINAL"
  fi
}
trap restore EXIT

# Build once
echo "Building..."
yarn clean && yarn build
echo ""

# 1. Verdaccio (local)
if [ "$SKIP_LOCAL" = false ]; then
  echo "--- Publishing to Verdaccio (localhost:4873) ---"
  npm config set @corpus-relica:registry http://localhost:4873
  npm publish --ignore-scripts 2>&1 && echo "  Done" || echo "  Skipped (already published or Verdaccio not running)"
  echo ""
fi

# 2. npm (public)
if [ "$SKIP_NPM" = false ]; then
  echo "--- Publishing to npm (registry.npmjs.org) ---"
  npm config set @corpus-relica:registry https://registry.npmjs.org
  npm publish --ignore-scripts 2>&1 && echo "  Done" || echo "  Failed (check npm auth)"
  echo ""
fi

# 3. GitHub Packages
if [ "$SKIP_GHPKG" = false ]; then
  echo "--- Publishing to GitHub Packages ---"
  npm config set @corpus-relica:registry https://npm.pkg.github.com
  npm publish --ignore-scripts 2>&1 && echo "  Done" || echo "  Failed (check ~/.npmrc auth for npm.pkg.github.com)"
  echo ""
fi

echo "============================================="
echo "$PKG@$VERSION publish complete"
echo "============================================="
