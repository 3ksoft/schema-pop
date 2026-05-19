#!/usr/bin/env sh
set -e

echo "→ Building for GitHub Pages (base=/schema-pop/)..."
cd packages/web
bun vite build --base=/schema-pop/

echo "→ Pushing to gh-pages branch..."
cd dist
git init -b gh-pages
git add -A
git commit -m "deploy: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push -f git@github.com:3ksoft/schema-pop.git gh-pages
cd ..
rm -rf dist/.git

echo "✓ Done! https://3ksoft.github.io/schema-pop/"
