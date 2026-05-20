#!/usr/bin/env bash
# Reviewgate SessionStart hook driver — keep this script tiny.
# Reviewgate-managed; do not edit by hand.
set -u
exec reviewgate gate --hook reset
