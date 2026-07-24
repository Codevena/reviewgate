#!/usr/bin/env bash
# Fake `agy` for the silent-stall discriminator-probe tests. Behavior is driven
# by env (all survive scrubReviewerEnv — RG_* keys don't look like secrets):
#   RG_PROBE_COUNT  (required) — invocation counter file; 0-based index per call.
#   RG_ARGS_OUT     (optional) — argv dump target; written as "$RG_ARGS_OUT.$n".
#   RG_PWD_OUT      (optional) — cwd dump target; written as "$RG_PWD_OUT.$n".
#   RG_REVIEW_MODE  silent (default) → hang with zero output until killed;
#                   sentinel        → print agy's print-timeout give-up sentinel.
#   RG_PROBE_MODE   ok (default)    → answer instantly;
#                   silent          → hang with zero output until killed;
#                   banner          → print a quota/usage banner (quota'd agy CAN
#                                     emit one on stdout and still exit 0 — F-043).
set -u
count_file="${RG_PROBE_COUNT}"
n=$(cat "$count_file" 2>/dev/null || echo 0)
echo $((n + 1)) > "$count_file"
[ -n "${RG_ARGS_OUT:-}" ] && printf '%s\n' "$@" > "$RG_ARGS_OUT.$n"
[ -n "${RG_PWD_OUT:-}" ] && pwd > "$RG_PWD_OUT.$n"
if [ "$n" = "0" ]; then
  case "${RG_REVIEW_MODE:-silent}" in
    sentinel) echo "Error: timed out waiting for response" ;;
    *) sleep 30 ;;
  esac
else
  case "${RG_PROBE_MODE:-ok}" in
    silent) sleep 30 ;;
    banner) echo "⚠ Individual quota reached. Resets in 25m38s." ;;
    *) echo "OK" ;;
  esac
fi
exit 0
