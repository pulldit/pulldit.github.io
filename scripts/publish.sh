#!/usr/bin/env bash
# One-shot publisher for Pulldit. Run AFTER the 'pulldit' organization exists.
# It creates the public repo, pushes main + tags, enables GitHub Pages (Actions
# source), and creates the v1.0.0 release. Idempotent-ish: safe to re-run.
set -euo pipefail

OWNER="pulldit"
REPO="pulldit.github.io"
SLUG="$OWNER/$REPO"

echo "==> Checking that the '$OWNER' organization exists and is reachable..."
if ! gh api "orgs/$OWNER" >/dev/null 2>&1; then
  cat <<EOF
ERROR: organization '$OWNER' not found (or no access).
Create it first (1 click, free):
  https://github.com/account/organizations/new?plan=free
Use exactly the name: $OWNER
Then re-run this script.
EOF
  exit 1
fi

echo "==> Creating public repo $SLUG and pushing 'main'..."
if gh repo view "$SLUG" >/dev/null 2>&1; then
  echo "    repo already exists; wiring remote + pushing"
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$SLUG.git"
  git push -u origin main
else
  gh repo create "$SLUG" --public --source=. --remote=origin --push \
    --description "Static, browser-only Reddit media downloader. No backend, strict CSP, switchable proxy modes."
fi

echo "==> Pushing tags..."
git push origin --tags

echo "==> Enabling GitHub Pages (build from GitHub Actions)..."
gh api -X POST "repos/$SLUG/pages" -f build_type=workflow >/dev/null 2>&1 \
  || gh api -X PUT "repos/$SLUG/pages" -f build_type=workflow >/dev/null 2>&1 \
  || echo "    (Pages may already be enabled, or will be enabled by the deploy workflow)"

echo "==> Creating the v1.0.0 release..."
if ! gh release view v1.0.0 --repo "$SLUG" >/dev/null 2>&1; then
  gh release create v1.0.0 --repo "$SLUG" --title "Pulldit v1.0.0" \
    --notes "First public release — static, browser-only Reddit media downloader.

- Switchable proxy modes: direct / your own Cloudflare Worker / public proxy
- Strict CSP, locally vendored libs, host allowlisting, server-free
- 65 unit tests, CI + CodeQL + dependency scanning, auto-deploy to Pages

See README for details. Not affiliated with Reddit, Inc."
else
  echo "    release v1.0.0 already exists"
fi

echo ""
echo "==> Done. Live shortly at: https://$OWNER.github.io/"
echo "    Actions:  https://github.com/$SLUG/actions"
