#!/usr/bin/env bash
# Link the audit skills and agents into .claude/ so Claude Code can load them.
#
#   bash tools/audit/install.sh            # symlink (default)
#   bash tools/audit/install.sh --copy     # copy instead, if symlinks are a problem
#   bash tools/audit/install.sh --uninstall
#
# The canonical files live here, under version control. `.claude/` is git-ignored
# by repo policy, and it is also the only path Claude Code discovers skills and
# agents from — so what lands there is local wiring, never a second source of
# truth. Re-run after pulling if new skills or agents appear.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

MODE=link
[ "${1:-}" = "--copy" ] && MODE=copy
[ "${1:-}" = "--uninstall" ] && MODE=uninstall

mkdir -p .claude/skills .claude/agents

link_one() { # src (repo-relative), dest
  local src="$1" dest="$2"
  rm -rf "$dest"
  case "$MODE" in
    link)
      # Relative, so the link survives the repo being moved or cloned elsewhere.
      # Depth is the number of path COMPONENTS in the destination's directory
      # (.claude/skills -> 2), not the number of slashes (1).
      local up; up="$(dirname "$dest")"
      local depth; depth="$(awk -F/ '{print NF}' <<<"$up")"
      local prefix=""; local i
      for ((i = 0; i < depth; i++)); do prefix="../$prefix"; done
      ln -sfn "${prefix}${src}" "$dest"
      ;;
    copy) cp -R "$src" "$dest" ;;
  esac
}

if [ "$MODE" = uninstall ]; then
  for s in tools/audit/skills/*/; do rm -rf ".claude/skills/$(basename "$s")"; done
  for a in tools/audit/agents/*.md; do rm -f ".claude/agents/$(basename "$a")"; done
  echo "audit tooling unlinked from .claude/"
  exit 0
fi

n=0
for s in tools/audit/skills/*/; do
  name="$(basename "$s")"
  link_one "tools/audit/skills/$name" ".claude/skills/$name"
  n=$((n + 1))
done
for a in tools/audit/agents/*.md; do
  name="$(basename "$a")"
  link_one "tools/audit/agents/$name" ".claude/agents/$name"
  n=$((n + 1))
done

echo "audit tooling installed into .claude/ ($MODE): $n entries"
echo "restart Claude Code, or run /skills, to pick them up"
