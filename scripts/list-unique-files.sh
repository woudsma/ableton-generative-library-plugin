#!/usr/bin/env bash

ROOT="${1:-.}"

find "$ROOT" -type f \( -iname "*.wav" -o -iname "*.aif" \) -path "*/Samples/*" -print0 |
xargs -0 -n1 basename |
sed -E 's/\.[^.]+$//; s/ \[[^]]+\]$//; s/ [0-9]+$//' |
grep -E '^[A-Z0-9-]+$' |
grep -Ev '[0-9]{3,}' |
sort -u