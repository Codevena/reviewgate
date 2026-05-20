#!/usr/bin/env bash
# Fake codex that fails: emits nothing useful and exits non-zero.
set -u
echo "simulated codex failure" >&2
exit 7
