#!/usr/bin/env bash
# Deterministic replay of a real reviewgate@0.1.0-alpha.11 OpenRouter run.
# The gate, control plane, decision handling, re-review and audit verification
# execute live. Only provider responses are replayed from the recorded cassette.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CASSETTE="$ROOT/assets/demo/alpha11-openrouter.jsonl"
EXPECTED_VERSION="0.1.0-alpha.11"
EXPECTED_CASSETTE_SHA256="929845145547d20e8994cefff3e822847813601a202a8ce7426a2a55a199d860"
EXPECTED_BASELINE_SHA="9573b44f49a5b54134d37d6995dc92bc8e79bafc"
DELAY="${REVIEWGATE_DEMO_DELAY:-0}"
KEEP="${REVIEWGATE_DEMO_KEEP:-0}"

if [[ -t 1 ]]; then
  BOLD=$'\033[1m'
  DIM=$'\033[2m'
  RESET=$'\033[0m'
  ACID=$'\033[38;5;190m'
  RED=$'\033[38;5;196m'
  BLUE=$'\033[38;5;75m'
else
  BOLD="" DIM="" RESET="" ACID="" RED="" BLUE=""
fi

pause() {
  [[ "$DELAY" == "0" ]] || sleep "$DELAY"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

fail() {
  printf '%s\n' "${RED}Demo aborted:${RESET} $*" >&2
  exit 1
}

command -v reviewgate >/dev/null 2>&1 || fail "install reviewgate@$EXPECTED_VERSION first"
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
  fail "checksum tool missing; install sha256sum (Linux) or shasum (macOS)"
fi
[[ "$(reviewgate --version)" == "$EXPECTED_VERSION" ]] || fail "expected reviewgate@$EXPECTED_VERSION, found $(reviewgate --version)"
[[ -f "$CASSETTE" ]] || fail "missing cassette: $CASSETTE"
[[ "$(sha256_file "$CASSETTE")" == "$EXPECTED_CASSETTE_SHA256" ]] || fail "cassette checksum mismatch"

printf '%s\n' "${BOLD}Recorded provider response replay${RESET} — the gate path and verdict handling are live."
printf '%s\n' "${DIM}Notice: provider response outputs were recorded for deterministic replay and provenance verification.${RESET}"
printf '%s\n' "${DIM}reviewgate@$EXPECTED_VERSION · OpenRouter · deepseek/deepseek-v4-flash · upstream alibaba${RESET}"
pause

WORK="$(mktemp -d "${TMPDIR:-/tmp}/reviewgate-alpha11-replay.XXXXXX")"
AUX="$(mktemp -d "${TMPDIR:-/tmp}/reviewgate-alpha11-output.XXXXXX")"
cleanup() {
  if [[ "$KEEP" == "1" ]]; then
    printf '%s\n' "Demo worktree kept at $WORK (output: $AUX)" >&2
  else
    rm -rf "$WORK" "$AUX"
  fi
}
trap cleanup EXIT
cd "$WORK"

git init -q -b master
git config user.name "ReviewGate Demo"
git config user.email "demo@reviewgate.local"
git config core.autocrlf false
git config core.eol lf
git config commit.gpgsign false

cat > reviewgate.config.ts <<'CONFIG'
export default {
  providers: {
    openrouter: {
      enabled: true,
      openrouterProvider: { only: ["alibaba"] },
    },
  },
  phases: {
    review: {
      reviewers: [{ provider: "openrouter", persona: "security" }],
    },
    brain: null,
    fpLedger: { enabled: false },
    agentLessons: null,
    reputation: { enabled: false },
    contextDocs: null,
  },
  research: { languages: [] },
};
CONFIG

cat > .gitignore <<'IGNORE'
node_modules/
.reviewgate/
.claude/
.codex/
demo.jsonl
IGNORE

printf '\n%s\n' "${BLUE}01 / INITIALIZE${RESET}  fresh repository · data-only policy · both native hosts"
reviewgate init --hooks-only --host both > "$AUX/init.log" 2>&1
grep -E 'hooks installed|Codex activation' "$AUX/init.log" || cat "$AUX/init.log"
reviewgate config status

git add .gitignore reviewgate.config.ts
GIT_AUTHOR_DATE='2026-07-13T13:15:00+02:00' \
GIT_COMMITTER_DATE='2026-07-13T13:15:00+02:00' \
  git commit -q -m 'chore: initialize portable alpha.11 proof'
[[ "$(git rev-parse HEAD)" == "$EXPECTED_BASELINE_SHA" ]] || fail "fixture baseline drifted"

SESSION_ID="reviewgate-alpha11-replay"
printf '{"hook_event_name":"SessionStart","source":"startup","session_id":"%s","cwd":"%s"}' "$SESSION_ID" "$WORK" | ./.reviewgate/bin/reset
mkdir -p src/users

cat > src/users/UserRepository.java <<'VULNERABLE'
package users;

import java.util.List;
import java.util.Objects;
import java.util.Optional;

record UserRow(String id, String name) {}

interface Database {
  Optional<UserRow> queryOne(String sql, List<Object> values);
}

final class UserRepository {
  static Optional<UserRow> findUserByName(Object rawName, Database db) {
    Objects.requireNonNull(db, "db");
    if (!(rawName instanceof String name) || name.isBlank() || name.length() > 80) {
      throw new IllegalArgumentException("name must be non-blank and contain at most 80 characters");
    }

    return db.queryOne(
        "SELECT id, name FROM users WHERE name = '" + name + "' LIMIT 1", List.of());
  }
}
VULNERABLE

# Replay queues are process-local. Each Stop hook is a fresh process, so expose
# the matching recorded response to each invocation as a one-entry cassette.
sed -n '1p' "$CASSETTE" > "$AUX/fail.jsonl"
sed -n '2p' "$CASSETTE" > "$AUX/pass.jsonl"

printf '\n%s\n' "${BLUE}02 / MUTATION${RESET}  agent writes src/users/UserRepository.java"
printf '%s\n' "${RED}- unsafe SQL interpolation accepts attacker-controlled input${RESET}"
printf '{"hook_event_name":"PostToolUse","session_id":"%s","cwd":"%s","tool_name":"Edit","tool_input":{"file_path":"%s/src/users/UserRepository.java"}}' "$SESSION_ID" "$WORK" "$WORK" | ./.reviewgate/bin/trigger
pause

printf '\n%s\n' "${BLUE}03 / STOP${RESET}  native hook runs the production gate"
printf '{"hook_event_name":"Stop","session_id":"%s","cwd":"%s","stop_hook_active":false}' "$SESSION_ID" "$WORK" \
  | REVIEWGATE_CASSETTE="replay:$AUX/fail.jsonl" REVIEWGATE_HOST_MODEL='claude-opus-4-7' ./.reviewgate/bin/gate \
      > "$AUX/fail-hook.json" 2> "$AUX/fail-display.log"
if grep -qE 'cassette: (prompt drift for|no recorded)' "$AUX/fail-hook.json" "$AUX/fail-display.log"; then
  grep -hoE 'cassette: (prompt drift for|no recorded).*' "$AUX/fail-hook.json" "$AUX/fail-display.log" >&2 || true
  fail "recorded response no longer matches the live Alpha.11 prompt"
fi
grep -q '"decision":"block"' "$AUX/fail-hook.json" || fail "first Stop hook did not block"
cat "$AUX/fail-display.log"
printf '\n'
sed -n '/### F-001/,+8p' .reviewgate/pending.md
pause

printf '\n%s\n' "${BLUE}04 / DECISION + FIX${RESET}  accept F-001 and parameterize the query"
mkdir -p .reviewgate/decisions
cat > .reviewgate/decisions/1.jsonl <<'DECISION'
{"schema":"reviewgate.decision.v1","finding_id":"F-001","verdict":"accepted","action":"fixed","files_touched":["src/users/UserRepository.java"]}
DECISION

cat > src/users/UserRepository.java <<'FIXED'
package users;

import java.util.List;
import java.util.Objects;
import java.util.Optional;

record UserRow(String id, String name) {}

interface Database {
  Optional<UserRow> queryOne(String sql, List<Object> values);
}

final class UserRepository {
  static Optional<UserRow> findUserByName(Object rawName, Database db) {
    Objects.requireNonNull(db, "db");
    if (!(rawName instanceof String name) || name.isBlank() || name.length() > 80) {
      throw new IllegalArgumentException("name must be non-blank and contain at most 80 characters");
    }

    return db.queryOne(
        "SELECT id, name FROM users WHERE name = ? LIMIT 1", List.<Object>of(name));
  }
}
FIXED
printf '%s\n' "${ACID}+ db.queryOne(\"… name = ? LIMIT 1\", List.of(name))${RESET}"
printf '{"hook_event_name":"PostToolUse","session_id":"%s","cwd":"%s","tool_name":"Edit","tool_input":{"file_path":"%s/src/users/UserRepository.java"}}' "$SESSION_ID" "$WORK" "$WORK" | ./.reviewgate/bin/trigger
pause
# Alpha.11 partitions audit files by second. Keep the two independent hook
# processes in separate partitions so each file contains one valid hash chain.
sleep 1.1

printf '\n%s\n' "${BLUE}05 / RE-REVIEW${RESET}  same gate path, fixed diff"
printf '{"hook_event_name":"Stop","session_id":"%s","cwd":"%s","stop_hook_active":true}' "$SESSION_ID" "$WORK" \
  | REVIEWGATE_CASSETTE="replay:$AUX/pass.jsonl" REVIEWGATE_HOST_MODEL='claude-opus-4-7' ./.reviewgate/bin/gate \
      > "$AUX/pass-hook.json" 2> "$AUX/pass-display.log"
if grep -qE 'cassette: (prompt drift for|no recorded)' "$AUX/pass-hook.json" "$AUX/pass-display.log"; then
  grep -hoE 'cassette: (prompt drift for|no recorded).*' "$AUX/pass-hook.json" "$AUX/pass-display.log" >&2 || true
  fail "recorded response no longer matches the live Alpha.11 prompt"
fi
grep -q 'GATE OPEN' "$AUX/pass-display.log" || fail "second Stop hook did not pass"
cat "$AUX/pass-display.log"
printf '\n'
pause

printf '\n%s\n' "${BLUE}06 / VERIFY${RESET}  tamper-evident audit chains"
while IFS= read -r audit_file; do
  reviewgate audit verify --file "$audit_file"
done < <(find .reviewgate/audit -type f -name '*.jsonl' | sort)
printf '%s\n' "${ACID}${BOLD}Evidence complete.${RESET} Cassette SHA-256 ${EXPECTED_CASSETTE_SHA256:0:12}…"
