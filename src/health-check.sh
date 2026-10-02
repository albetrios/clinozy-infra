#!/usr/bin/env bash
# Phased local health check — the same shape as the sibling repos' `pnpm health`.
#
# Runs EVERY phase, CONTINUES through failures, and prints one PASS/FAIL table at the end,
# so a single run shows every problem rather than the first.
#
#   pnpm health        # run all phases read-only
#   pnpm health:fix    # auto-repair lint + format first
set -uo pipefail

cd "$(dirname "$0")/.."

FIX=0
for arg in "$@"; do
  case "$arg" in
    --fix) FIX=1 ;;
    *)
      echo "unknown argument: $arg (supported: --fix)" >&2
      exit 2
      ;;
  esac
done

if [ -t 1 ] && command -v tput >/dev/null 2>&1; then
  GREEN=$(tput setaf 2); RED=$(tput setaf 1); BOLD=$(tput bold); RESET=$(tput sgr0)
else
  GREEN=""; RED=""; BOLD=""; RESET=""
fi

FAILS=0
SUMMARY=""

# phase "<label>" <script-name> — runs `pnpm --reporter=silent <script-name>`, never aborts.
phase() {
  label="$1"
  shift
  printf '%s▶ %s%s\n' "$BOLD" "$label" "$RESET"
  if pnpm --reporter=silent "$@"; then
    SUMMARY="${SUMMARY}${GREEN}PASS${RESET}  ${label}\n"
  else
    SUMMARY="${SUMMARY}${RED}FAIL${RESET}  ${label}\n"
    FAILS=$((FAILS + 1))
  fi
}

if [ "$FIX" -eq 1 ]; then
  echo "── auto-fix pass (lint + format) ──"
  pnpm --reporter=silent lint:fix || true
  echo ""
fi

echo "── health check ──"
phase "Lint + format (Biome)" lint
phase "Typecheck"             typecheck
phase "Unit tests"            test
phase "Project identity"      validate:identity

echo ""
echo "${BOLD}Health summary${RESET}"
printf "%b" "$SUMMARY"
if [ "$FAILS" -gt 0 ]; then
  echo "${RED}✗ ${FAILS} phase(s) failed.${RESET}"
  exit 1
fi
echo "${GREEN}✓ all phases passed.${RESET}"
