#!/usr/bin/env bash
# Automated security sweep. Phase P2 of an audit engagement.
#
#   bash tools/audit/skills/static-analysis/scripts/audit-scan.sh [--out DIR] [--quick]
#
# Every tool either runs or is recorded as UNAVAILABLE with its install command.
# An unrun tool is a coverage gap, never a pass. Every hit is a LEAD, never a
# finding — triage per the static-analysis skill before anything reaches a report.
set -uo pipefail   # deliberately not -e: a failing tool must not abort the sweep

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

OUT="docs/audit/scan"
QUICK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --quick) QUICK=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
mkdir -p "$OUT"

SUMMARY="$OUT/SUMMARY.md"
: > "$SUMMARY"
{
  echo "# Automated Scan"
  echo
  echo "Commit \`$(git rev-parse HEAD 2>/dev/null || echo unknown)\` · $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo
  echo "| Tool | Status | Hits | Output |"
  echo "|---|---|---|---|"
} >> "$SUMMARY"

row() { printf '| %s | %s | %s | %s |\n' "$1" "$2" "$3" "$4" >> "$SUMMARY"; }

have() { command -v "$1" >/dev/null 2>&1; }

skip() { # tool, install-hint
  row "$1" "**UNAVAILABLE**" "—" "install: \`$2\`"
  echo "SKIP $1 — not installed ($2)"
}

# ── Rust / Anchor ────────────────────────────────────────────────────────────
if have cargo; then
  if cargo clippy --version >/dev/null 2>&1; then
    ( cd packages/anchor && cargo clippy --all-targets --no-deps --message-format=short \
        -- -W clippy::arithmetic_side_effects -W clippy::integer_division \
           -W clippy::unwrap_used -W clippy::expect_used -W clippy::panic \
           -W clippy::indexing_slicing -W clippy::cast_possible_truncation \
      ) > "$OUT/clippy.txt" 2>&1
    n=$(grep -cE ':[0-9]+:[0-9]+: (warning|error)' "$OUT/clippy.txt" 2>/dev/null || echo 0)
    row "cargo clippy" "ran" "$n" "\`scan/clippy.txt\`"
  else
    skip "cargo clippy" "rustup component add clippy"
  fi

  if have cargo-audit; then
    ( cd packages/anchor && cargo audit --json ) > "$OUT/cargo-audit.json" 2>"$OUT/cargo-audit.err"
    n=$(jq '[.vulnerabilities.list[]?] | length' "$OUT/cargo-audit.json" 2>/dev/null || echo "?")
    row "cargo-audit" "ran" "$n" "\`scan/cargo-audit.json\`"
  else
    skip "cargo-audit" "cargo install cargo-audit"
  fi

  if have cargo-deny; then
    ( cd packages/anchor && cargo deny check ) > "$OUT/cargo-deny.txt" 2>&1
    n=$(grep -cE '^(error|warning)' "$OUT/cargo-deny.txt" 2>/dev/null || echo 0)
    row "cargo-deny" "ran" "$n" "\`scan/cargo-deny.txt\`"
  else
    skip "cargo-deny" "cargo install cargo-deny  # licences, bans, unmaintained crates"
  fi
else
  skip "cargo toolchain" "https://rustup.rs"
fi

# ── JavaScript / TypeScript ──────────────────────────────────────────────────
if have pnpm; then
  pnpm audit --json > "$OUT/pnpm-audit.json" 2>"$OUT/pnpm-audit.err"
  n=$(jq -s '[.[] | select(.type=="auditAdvisory")] | length' "$OUT/pnpm-audit.json" 2>/dev/null || echo "?")
  row "pnpm audit" "ran" "$n" "\`scan/pnpm-audit.json\`"

  if [ "$QUICK" -eq 0 ]; then
    pnpm -r exec tsc --noEmit > "$OUT/tsc.txt" 2>&1
    n=$(grep -c 'error TS' "$OUT/tsc.txt" 2>/dev/null || echo 0)
    row "tsc --noEmit" "ran" "$n" "\`scan/tsc.txt\`"
  fi
else
  skip "pnpm" "corepack enable && corepack prepare pnpm@9 --activate"
fi

if have osv-scanner; then
  osv-scanner --lockfile=pnpm-lock.yaml --format json > "$OUT/osv.json" 2>&1
  n=$(jq '[.results[]?.packages[]?.vulnerabilities[]?] | length' "$OUT/osv.json" 2>/dev/null || echo "?")
  row "osv-scanner" "ran" "$n" "\`scan/osv.json\`"
else
  skip "osv-scanner" "brew install osv-scanner  # covers Cargo.lock and pnpm-lock together"
fi

# ── Secrets ──────────────────────────────────────────────────────────────────
if have gitleaks; then
  gitleaks detect --no-banner --redact --report-format json \
    --report-path "$OUT/gitleaks.json" > "$OUT/gitleaks.txt" 2>&1
  n=$(jq 'length' "$OUT/gitleaks.json" 2>/dev/null || echo "?")
  row "gitleaks" "ran" "$n" "\`scan/gitleaks.json\`"
else
  skip "gitleaks" "brew install gitleaks  # scans full git history, not just HEAD"
fi

# Tracked-secret check, always available. Real keys must never be tracked.
{
  echo "# Tracked files that should never contain live secrets"
  git ls-files \
    | grep -Ei '(^|/)(\.env($|\.)|keys/|.*\.pem$|.*id_rsa|.*keypair.*\.json$)' \
    | grep -Ev '\.(example|sample|template)$' || true
} > "$OUT/tracked-secrets.txt" 2>&1
n=$(grep -cvE '^#' "$OUT/tracked-secrets.txt" 2>/dev/null || echo 0)
row "tracked-secret paths" "ran" "$n" "\`scan/tracked-secrets.txt\`"

# ── Semgrep ──────────────────────────────────────────────────────────────────
if have semgrep; then
  semgrep --config=p/rust --config=p/typescript --config=p/secrets \
          --config=p/owasp-top-ten --json --quiet \
          --exclude=node_modules --exclude=dist --exclude=target \
    > "$OUT/semgrep.json" 2>"$OUT/semgrep.err"
  n=$(jq '[.results[]?] | length' "$OUT/semgrep.json" 2>/dev/null || echo "?")
  row "semgrep" "ran" "$n" "\`scan/semgrep.json\`"
else
  skip "semgrep" "brew install semgrep"
fi

# ── Containers ───────────────────────────────────────────────────────────────
if have hadolint; then
  find docker -name 'Dockerfile*' -exec hadolint {} + > "$OUT/hadolint.txt" 2>&1
  n=$(wc -l < "$OUT/hadolint.txt" | tr -d ' ')
  row "hadolint" "ran" "$n" "\`scan/hadolint.txt\`"
else
  skip "hadolint" "brew install hadolint"
fi

# ── Solana / protocol grep checklist (always runs; rg or grep) ────────────────
# rg is absent from PATH in non-interactive shells. The fallback MUST be -E:
# with BRE, every `|` alternation below matches literally and returns nothing,
# which reads as a clean scan. Verify rg runs, do not just check it exists.
if rg --version >/dev/null 2>&1; then
  GREP=(rg -n --no-heading)
else
  GREP=(grep -rnE --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=target)
fi
PROG="packages/anchor/programs"
SRC="packages/api/src packages/shared packages/web/src"

pat() { # id, description, path, pattern
  {
    echo "### $1 — $2"
    echo '```'
    "${GREP[@]}" -e "$4" $3 2>/dev/null | head -40
    echo '```'
    echo
  } >> "$OUT/grep-checklist.md"
}

: > "$OUT/grep-checklist.md"
echo "# Mechanical checklist (leads, not findings)" >> "$OUT/grep-checklist.md"
echo >> "$OUT/grep-checklist.md"

pat G01 "Raw AccountInfo/UncheckedAccount — each needs a written justification" "$PROG" 'UncheckedAccount|AccountInfo<'
pat G02 "Unchecked arithmetic in the program" "$PROG" '[^_a-z](\+|\-|\*)=|\bas u(8|16|32|64|128)\b'
pat G03 "init_if_needed — reinitialisation resets baselines" "$PROG" 'init_if_needed'
pat G04 "Panics in on-chain code" "$PROG" 'unwrap\(\)|expect\(|panic!|unreachable!'
pat G05 "Token accounts — confirm mint and owner constraints nearby" "$PROG" 'TokenAccount'
pat G06 "Seeds built from instruction arguments (attacker-chosen)" "$PROG" 'seeds *= *\['
pat G07 "Impurity in the four adjudicators (must be empty)" "packages/api/src/services/oracle/adjudicate.ts packages/api/src/services/exploit/adjudicate.ts packages/api/src/services/governance/adjudicate.ts packages/api/src/services/agent-error/adjudicate.ts" 'Date\.now\(\)|Math\.random\(\)|new Date\(|fetch\(|connection\.'
pat G08 "Confidence constants — the ceiling/auto-pay gap" "packages/api/src packages/shared" 'CONFIDENCE_CEILING|AUTO_PAY_CONFIDENCE'
pat G09 "Raw SQL / string-built queries" "$SRC" 'sql\.raw|execute\(`|query\(`'
pat G10 "Shell execution" "$SRC" 'exec\(|execSync|spawnSync|child_process'
pat G11 "Non-constant-time comparison of secrets" "$SRC" '(secret|token|hmac|signature|digest)[A-Za-z]* *===|=== *(secret|token|hmac|signature)'
pat G12 "Auth bypass shapes in route handlers" "$SRC" 'if *\(!?(process\.env|NODE_ENV)|SKIP_AUTH|DISABLE_AUTH|allowAnonymous'
pat G13 "Retired Enhanced-Tx host or hardcoded cluster (webhooks mgmt API is exempt)" "$SRC" 'api\.helius\.xyz/v0/(transactions|addresses|token|nft)|helius-rpc\.com'
pat G14 "Dangerous rendering in the frontend" "packages/web/src" 'dangerouslySetInnerHTML|innerHTML *='

n=$(grep -c '^###' "$OUT/grep-checklist.md")
row "grep checklist" "ran" "$n sections" "\`scan/grep-checklist.md\`"

{
  echo
  echo "## Reading this"
  echo
  echo "Hits are **leads**. Promote a lead to a finding only after reading the"
  echo "code and writing the exploit path; dismiss it with a reason recorded."
  echo "Tools marked UNAVAILABLE are coverage gaps and belong in the report's"
  echo "limitations section."
} >> "$SUMMARY"

echo
cat "$SUMMARY"
