#!/usr/bin/env bash
# Reviewgate Stop hook driver — keep this script tiny.
# Reviewgate-managed; do not edit by hand.
set -u
exec reviewgate gate --hook stop
