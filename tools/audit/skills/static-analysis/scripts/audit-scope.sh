#!/usr/bin/env bash
# Freeze the audit scope: commit hash, in-scope file inventory with SHA-256
# digests, and LOC counts. Phase P0 of an audit engagement.
#
#   bash tools/audit/skills/static-analysis/scripts/audit-scope.sh [--out DIR]
#
# Writes SCOPE.md to DIR (default docs/audit/) and prints a summary.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

OUT="docs/audit"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
mkdir -p "$OUT"

if command -v sha256sum >/dev/null 2>&1; then
  sha() { sha256sum "$1" | cut -d' ' -f1; }
else
  sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi

COMMIT="$(git rev-parse HEAD 2>/dev/null || echo 'not-a-git-repo')"
SHORT="${COMMIT:0:8}"
DIRTY=""
if ! git diff-index --quiet HEAD -- 2>/dev/null; then
  DIRTY=" (WORKING TREE DIRTY — scope is not reproducible; commit or stash first)"
fi

# In-scope roots. Extend deliberately; every addition widens the engagement.
ROOTS=(
  "packages/anchor/programs"
  "packages/api/src"
  "packages/shared"
  "packages/web/src"
  "packages/api/scripts"
  "scripts"
  "docker"
)

FILE="$OUT/SCOPE.md"
{
  echo "# Audit Scope"
  echo
  echo "| | |"
  echo "|---|---|"
  echo "| Commit | \`$COMMIT\`$DIRTY |"
  echo "| Frozen at | $(date -u '+%Y-%m-%dT%H:%M:%SZ') |"
  echo "| Branch | $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '-') |"
  echo
  echo "## In-scope files"
  echo
  echo "| File | SHA-256 | LOC |"
  echo "|---|---|---|"
} > "$FILE"

total_files=0
total_loc=0
for root in "${ROOTS[@]}"; do
  [ -d "$root" ] || continue
  while IFS= read -r f; do
    loc=$(wc -l < "$f" | tr -d ' ')
    printf '| `%s` | `%s` | %s |\n' "$f" "$(sha "$f")" "$loc" >> "$FILE"
    total_files=$((total_files + 1))
    total_loc=$((total_loc + loc))
  done < <(git ls-files "$root" 2>/dev/null \
             | grep -Ev '(^|/)(node_modules|dist|target|\.turbo)/' \
             | grep -E '\.(rs|ts|tsx|js|mjs|sql|sh|toml|ya?ml|json)$' \
             | grep -Ev '(\.d\.ts|package-lock\.json|pnpm-lock\.yaml)$' \
             | sort)
done

{
  echo
  echo "**$total_files files, $total_loc LOC in scope.**"
  echo
  echo "## Out of scope"
  echo
  echo '`node_modules/`, `dist/`, `target/`, generated IDL and types, lockfiles,'
  echo 'the `covantic-solana-sdk` repository, and third-party programs'
  echo '(SPL Token, Associated Token Account, Pyth).'
  echo
  echo "## Assumed trusted"
  echo
  echo 'The Solana runtime and validator set, the SPL Token program, the Pyth'
  echo 'guardian set, and the Postgres/Redis instances at their network boundary.'
} >> "$FILE"

echo "scope: $total_files files, $total_loc LOC @ $SHORT$DIRTY"
echo "wrote: $FILE"
