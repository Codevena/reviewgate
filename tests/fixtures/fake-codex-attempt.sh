#!/usr/bin/env bash
# Attempt-aware fake codex for retry/quota tests.
# Behavior driven by env vars set by the test:
#   RG_FAKE_COUNTER : file to append one line per invocation (spawn count)
#   RG_FAKE_A1      : ok|garbage|exit7|quota         (attempt 1: last.1.md)
#   RG_FAKE_A2      : ok|garbage|exit7|quota|none     (attempt 2: last.2.md)
# A run is "attempt 1" if --output-last-message ends in last.1.md, else attempt 2.
set -u
LAST_MSG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --output-last-message) LAST_MSG="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "${RG_FAKE_COUNTER:-}" ] && printf 'x\n' >> "$RG_FAKE_COUNTER"

mode="${RG_FAKE_A1:?RG_FAKE_A1 must be set}"
case "$LAST_MSG" in
  *last.2.md) mode="${RG_FAKE_A2:?RG_FAKE_A2 must be set}" ;;
esac

emit_usage() { printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5,"cached_input_tokens":0}}'; }

case "$mode" in
  ok)
    [ -n "$LAST_MSG" ] && printf '%s' '{"verdict":"PASS","findings":[]}' > "$LAST_MSG"
    emit_usage; exit 0 ;;
  garbage)
    [ -n "$LAST_MSG" ] && printf '%s' 'not json {{{' > "$LAST_MSG"
    emit_usage; exit 0 ;;
  none)
    # exit 0 but write NOTHING to last-message — proves the stale-output guard (no last.N.md → unparseable → error)
    emit_usage; exit 0 ;;
  quota)
    printf '%s\n' '{"type":"item.completed","text":"You have hit your usage limit for this period."}'
    emit_usage; exit 0 ;;
  exit7)
    echo "simulated codex failure" >&2
    exit 7 ;;
  *) echo "unknown mode: $mode" >&2; exit 99 ;;
esac
