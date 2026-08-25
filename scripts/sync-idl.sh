#!/usr/bin/env bash
# Regenerate the frontend's IDL copy from the built Anchor IDL.
#
#   pnpm idl:sync      (after `anchor build`)
#
# The browser builds instructions from packages/web/src/idl/covantic.ts. A copy
# that has drifted from the program serialises the wrong arguments, which fails
# at the validator rather than at compile time — so this is generated, never
# hand-edited.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

SRC="packages/anchor/target/idl/covantic.json"
DEST="packages/web/src/idl/covantic.ts"

[ -f "$SRC" ] || { echo "no built IDL at $SRC — run 'anchor build' first" >&2; exit 1; }

EXPECTED="$(grep -oE 'declare_id!\("[^"]+"\)' packages/anchor/programs/covantic/src/lib.rs | sed 's/.*("//;s/").*//')"
ACTUAL="$(jq -r .address "$SRC")"
if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "program id mismatch: lib.rs says $EXPECTED, built IDL says $ACTUAL" >&2
  echo "refusing to sync — a wrong address here points the frontend at another program" >&2
  exit 1
fi

{
  printf 'import type { Idl } from "@coral-xyz/anchor";\n\n'
  printf '/**\n * Anchor IDL for the Covantic insurance program.\n'
  printf ' * Discriminators are sha256("global|account|event:name")[0..8].\n'
  printf ' * Address matches the on-chain program ID on devnet.\n *\n'
  printf ' * Generated from `%s`. Regenerate with\n' "$SRC"
  printf ' * `pnpm idl:sync` after any change to the program'"'"'s instructions, accounts or\n'
  printf ' * events — a stale copy here builds wrong instructions from the browser.\n */\n'
  printf 'export const COVANTIC_IDL = '
  # Command substitution strips the trailing newline on purpose: TypeScript
  # forbids a line terminator before `as`, so `}` and `as unknown` must share
  # a line or the file will not parse.
  printf '%s' "$(jq --indent 2 . "$SRC")"
  printf ' as unknown as Idl;\n\nexport type Covantic = typeof COVANTIC_IDL;\n'
} > "$DEST"

echo "synced $DEST from $SRC (program $ACTUAL)"
