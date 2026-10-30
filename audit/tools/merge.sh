#!/usr/bin/env bash
# Merges the raw output of a partial run (run.sh --only ...; e.g. CI's chain
# job) into a main <out> directory, so report.js sees one run.
#
#   audit/tools/merge.sh <main out> <part out> [<part out> ...]
# The part's step directories replace the main's; its tools.tsv rows replace
# the main's rows for the same steps. meta.json / scope.json / seconds.txt
# stay the main run's.
set -euo pipefail
shopt -s nullglob
MAIN=$1; shift
mkdir -p "$MAIN/raw"
[ -f "$MAIN/raw/tools.tsv" ] || printf 'tool\tstatus\tseconds\tversion\tnote\n' > "$MAIN/raw/tools.tsv"
for PART in "$@"; do
  [ -d "$PART/raw" ] || { echo "merge: $PART has no raw/ (job skipped?)"; continue; }
  for d in "$PART"/raw/*/; do
    name=$(basename "$d")
    rm -rf "${MAIN:?}/raw/$name"; cp -r "$d" "$MAIN/raw/$name"
  done
  for f in "$PART"/raw/*.log; do [ -f "$f" ] && cp "$f" "$MAIN/raw/"; done
  [ -f "$MAIN/raw/meta.json" ] || cp "$PART/raw/meta.json" "$MAIN/raw/" 2>/dev/null || true
  if [ -f "$PART/raw/tools.tsv" ]; then
    steps=$(tail -n +2 "$PART/raw/tools.tsv" | cut -f1 | sort -u | tr '\n' ',')
    awk -F'\t' -v s=",$steps" 'NR == 1 || index(s, "," $1 ",") == 0' "$MAIN/raw/tools.tsv" > "$MAIN/raw/tools.tsv.tmp"
    tail -n +2 "$PART/raw/tools.tsv" >> "$MAIN/raw/tools.tsv.tmp"
    mv "$MAIN/raw/tools.tsv.tmp" "$MAIN/raw/tools.tsv"
  fi
  echo "merge: $PART -> $MAIN ($steps)"
done
