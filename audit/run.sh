#!/usr/bin/env bash
# The in-house audit pipeline (audit/README.md). Runs every tool it finds on
# PATH, writes raw outputs to <out>/raw/ and the merged report with report.js.
#
#   audit/run.sh [--target <dir>] [--tier fast|deep] [--out <dir>] [--commit <sha>]
#                [--only slither,aderyn,...] [--skip go,deps,...] [--report <REPORT.md path>] [--no-report]
#
#   steps: compile slither aderyn semgrep smtchecker invariants mutation neuro go deps
#
#   --target  the code to audit (default: this repository, scoped by
#             audit/scope.json). Any other directory is audited as a plain
#             Solidity project: its contracts are found by walking the tree
#             (dependencies, tests, mocks and scripts skipped); the Go and
#             repository-specific steps are skipped.
#   --tier    fast (PR, <= 15 min) or deep (weekly, <= 6 h). See README.md.
#   --commit  recorded in the report (default: git HEAD of the target).
#
# Tools (install with audit/tools/install.sh): solc, slither, aderyn, semgrep
# (+ $SEMGREP_RULES), z3 for the SMTChecker, osv-scanner, npm; deep tier also
# forge, halmos, medusa, echidna and Go. A missing tool is recorded as
# "not installed" in the report; it never counts as "passed".
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
TARGET=$REPO; TIER=fast; OUT="$HERE/out"; COMMIT=""; ONLY=""; SKIP=""; REPORT=""; NO_REPORT=""
while [ $# -gt 0 ]; do
  case $1 in
    --target) TARGET=$2; shift 2 ;;
    --tier) TIER=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --commit) COMMIT=$2; shift 2 ;;
    --only) ONLY=$2; shift 2 ;;
    --skip) SKIP=$2; shift 2 ;;
    --report) REPORT=$2; shift 2 ;;
    --no-report) NO_REPORT=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
done
case $TIER in fast|deep) ;; *) echo "--tier fast|deep"; exit 2 ;; esac
TARGET=$(cd "$TARGET" && pwd)
mkdir -p "$OUT/raw"; OUT=$(cd "$OUT" && pwd)
# A full run starts clean; --only re-runs those steps into an existing <out>
# (e.g. CI's chain job adds raw/go to the contracts job's output).
[ -n "$ONLY" ] || { rm -rf "$OUT/raw"; mkdir -p "$OUT/raw"; }
MODE=repo; SCOPE_ARG=(--scope "$HERE/scope.json")
[ "$TARGET" = "$REPO" ] || { MODE=target; SCOPE_ARG=(); }
[ -n "$COMMIT" ] || COMMIT=$(git -C "$TARGET" rev-parse HEAD 2>/dev/null || echo unknown)
SOLC=${SOLC:-solc}

TOOLS="$OUT/raw/tools.tsv"
if [ -n "$ONLY" ] && [ -f "$TOOLS" ]; then
  awk -F'\t' -v only=",$ONLY," 'NR == 1 || index(only, "," $1 ",") == 0' "$TOOLS" > "$TOOLS.tmp" && mv "$TOOLS.tmp" "$TOOLS"
else printf 'tool\tstatus\tseconds\tversion\tnote\n' > "$TOOLS"; fi
want() { # tool name: is it selected by --only / --skip?
  if [ -n "$ONLY" ] && [[ ",$ONLY," != *",$1,"* ]]; then return 1; fi
  if [ -n "$SKIP" ] && [[ ",$SKIP," == *",$1,"* ]]; then return 1; fi
  return 0
}
record() { printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "${5:-}" >> "$TOOLS"; echo "audit: $1 $2 (${3}s) ${5:-}"; }
have() { command -v "$1" >/dev/null 2>&1; }
T_ALL=$(date +%s)

[ -n "$ONLY" ] && [ -f "$OUT/raw/meta.json" ] || cat > "$OUT/raw/meta.json" <<EOF
{"commit": "$COMMIT", "tier": "$TIER", "mode": "$MODE", "target": "$TARGET", "started": "$(date -u +%Y-%m-%dT%H:%M:%SZ)", "runner": "$(uname -sm)"}
EOF

# --- 1. compile: scope, LOC, runtime code hashes, artifact drift ------------
# Every Solidity step needs the compile output (scope, sources, bytecode).
NEED_SOL=""; for s in compile slither aderyn semgrep smtchecker mutation neuro; do want $s && NEED_SOL=1; done
t0=$(date +%s)
if [ -z "$NEED_SOL" ]; then :
elif [ -n "$ONLY" ] && ! want compile && [ -f "$OUT/raw/scope.json" ]; then :
elif have "$SOLC"; then
  node "$HERE/tools/compile.js" --target "$TARGET" --out "$OUT" --solc "$SOLC" "${SCOPE_ARG[@]}" > "$OUT/raw/compile.log" 2>&1 \
    && record compile ran $(( $(date +%s) - t0 )) "$("$SOLC" --version | sed -n 's/^Version: //p')" \
    || record compile failed $(( $(date +%s) - t0 )) "" "see raw/compile.log"
else record compile "not installed" 0 "" "solc"; fi
[ -z "$NEED_SOL" ] || [ -f "$OUT/raw/scope.json" ] || { echo "no scope: compile failed"; cat "$OUT/raw/compile.log"; exit 1; }

# The projects as "name|root|remappings(,)|excluded(,)|files( )|source dir" (| not a tab: read collapses empty tab fields)
PROJECTS=$([ -f "$OUT/raw/scope.json" ] && node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const p of s.projects) console.log([p.name, p.root, p.remappings.join(","), Object.keys(p.excluded).join(","), p.files.filter((f) => !p.excluded[f]).join(" "),
    [...new Set(p.files.map((f) => f.split("/")[0]))].length === 1 && p.files[0].includes("/") ? p.files[0].split("/")[0] : ""].join("|"));
' "$OUT/raw/scope.json")

# --- 2. Slither (every detector) --------------------------------------------
if want slither; then
  t0=$(date +%s)
  if have slither && have "$SOLC"; then
    rm -rf "$OUT/raw/slither"; mkdir -p "$OUT/raw/slither"; fails=0
    while IFS='|' read -r name root remaps excluded files srcdir; do
      [ -n "$name" ] || continue
      remap_args=(); [ -n "$remaps" ] && remap_args=(--solc-remaps "${remaps//,/ }")
      for f in $files; do
        o="$OUT/raw/slither/${name}__$(echo "$f" | tr '/' '_').json"
        (cd "$TARGET/$root" && slither "$f" --solc "$SOLC" "${remap_args[@]}" --solc-args "--optimize --optimize-runs 200 --evm-version cancun" \
          --filter-paths "(^|/)(vendor|node_modules|lib|test|tests|mocks?)/" --exclude-dependencies --json "$o" --disable-color >/dev/null 2>>"$OUT/raw/slither/stderr.log")
        # slither exits non-zero when it FINDS something; only a missing/failed JSON is an error
        node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]));if(!d.success)process.exit(1)' "$o" 2>/dev/null || { fails=$((fails+1)); echo "slither failed on $root/$f" >> "$OUT/raw/slither/stderr.log"; }
        rm -rf "$TARGET/$root/crytic-export"
      done
    done <<< "$PROJECTS"
    record slither ran $(( $(date +%s) - t0 )) "$(slither --version)" "$([ $fails -gt 0 ] && echo "$fails files failed to analyse")"
  else record slither "not installed" 0 ""; fi
fi

# --- 3. Aderyn ---------------------------------------------------------------
if want aderyn; then
  t0=$(date +%s)
  if have aderyn; then
    rm -rf "$OUT/raw/aderyn"; mkdir -p "$OUT/raw/aderyn"
    while IFS='|' read -r name root remaps excluded files srcdir; do
      [ -n "$name" ] || continue
      # Aderyn reads remappings from remappings.txt: give it a copy of the
      # project with one (never write into the audited tree).
      work="$OUT/work/aderyn/$name"; rm -rf "$work"; mkdir -p "$work"
      (cd "$TARGET/$root" && tar --exclude=node_modules --exclude=.git --exclude=artifacts -cf - .) | tar -xf - -C "$work"
      [ -n "$remaps" ] && echo "${remaps//,/$'\n'}" > "$work/remappings.txt"
      x="vendor/,node_modules/,lib/,test/,mocks/${excluded:+,$excluded}"
      (cd "$work" && aderyn . ${srcdir:+--src "$srcdir"} -x "$x" -o "$OUT/raw/aderyn/$name.json" --no-snippets > "$OUT/raw/aderyn/$name.log" 2>&1) \
        || echo "aderyn failed on $name" >> "$OUT/raw/aderyn/errors.log"
    done <<< "$PROJECTS"
    rm -rf "$OUT/work/aderyn"
    record aderyn ran $(( $(date +%s) - t0 )) "$(aderyn --version | head -1)" "$([ -s "$OUT/raw/aderyn/errors.log" ] && tr '\n' ' ' < "$OUT/raw/aderyn/errors.log")"
  else record aderyn "not installed" 0 ""; fi
fi

# --- 4. Semgrep (Decurity smart-contract rules, pinned) ---------------------
if want semgrep; then
  t0=$(date +%s)
  if have semgrep && [ -d "${SEMGREP_RULES:-}/solidity/security" ]; then
    rm -rf "$OUT/raw/semgrep"; mkdir -p "$OUT/raw/semgrep"
    paths=()
    while IFS='|' read -r name root remaps excluded files srcdir; do
      for f in $files; do paths+=("$root/$f"); done
    done <<< "$PROJECTS"
    (cd "$TARGET" && semgrep scan --metrics=off --disable-version-check --quiet --no-git-ignore \
      --config "$SEMGREP_RULES/solidity/security" --json --output "$OUT/raw/semgrep/results.json" "${paths[@]}" 2> "$OUT/raw/semgrep/stderr.log")
    record semgrep ran $(( $(date +%s) - t0 )) "$(semgrep --version) rules $(git -C "$SEMGREP_RULES" rev-parse --short HEAD 2>/dev/null)"
  else record semgrep "not installed" 0 "" "semgrep or SEMGREP_RULES missing"; fi
fi

# --- 5. SMTChecker (solc's built-in formal checks) --------------------------
if want smtchecker; then
  t0=$(date +%s)
  if [ "$MODE" = repo ] && have "$SOLC"; then
    node "$HERE/tools/smtchecker.js" --target "$TARGET" --out "$OUT" --tier "$TIER" --solc "$SOLC" --scope "$HERE/scope.json" ${SMT_WALL:+--wall "$SMT_WALL"} > "$OUT/raw/smtchecker.log" 2>&1
    note=$(grep -c ': done' "$OUT/raw/smtchecker.log")" contracts done; "$(grep -vc ': done' "$OUT/raw/smtchecker.log")" not"
    grep -q 'no-solver' "$OUT/raw/smtchecker.log" && note="z3 not found (LD_LIBRARY_PATH): nothing checked"
    record smtchecker ran $(( $(date +%s) - t0 )) "solc $("$SOLC" --version | sed -n 's/^Version: //p')" "$note"
  else record smtchecker skipped 0 "" "core contracts are listed in audit/scope.json (this repository only)"; fi
fi

# --- 6. invariant / property suites (*/audit/invariants/) -------------------
if want invariants; then
  t0=$(date +%s)
  bash "$HERE/tools/invariants.sh" "$TARGET" "$OUT" "$TIER" "$MODE" > "$OUT/raw/invariants.log" 2>&1
  record invariants ran $(( $(date +%s) - t0 )) "$(forge --version 2>/dev/null | head -1)" "$(tail -1 "$OUT/raw/invariants.log")"
fi

# --- 7. mutation testing (deep) ---------------------------------------------
if want mutation; then
  if [ "$TIER" = deep ] && [ "$MODE" = repo ]; then
    t0=$(date +%s)
    node "$HERE/tools/mutate.js" --target "$TARGET" --out "$OUT" --solc "$SOLC" --scope "$HERE/scope.json" --max "${MUTANTS_PER_FILE:-30}" > "$OUT/raw/mutation.log" 2>&1 \
      && record mutation ran $(( $(date +%s) - t0 )) "audit/tools/mutate.js" \
      || record mutation failed $(( $(date +%s) - t0 )) "audit/tools/mutate.js" "see raw/mutation.log"
  else record mutation skipped 0 "" "deep tier only"; fi
fi

# --- 8. Neuro (our own scanner) on our own bytecode -------------------------
if want neuro; then
  t0=$(date +%s)
  if [ -f "$REPO/zetaphy-neuro/src/analyze.js" ]; then
    node "$HERE/tools/neuro-dogfood.js" --out "$OUT" > "$OUT/raw/neuro.log" 2>&1 \
      && record neuro ran $(( $(date +%s) - t0 )) "zetaphy-neuro $(git -C "$REPO" log -1 --format=%h -- zetaphy-neuro/src 2>/dev/null)" "$(tail -1 "$OUT/raw/neuro.log")" \
      || record neuro failed $(( $(date +%s) - t0 )) "" "see raw/neuro.log"
  fi
fi

# --- 9. Go: the chain patches (staticcheck, gosec, govulncheck, -race) ------
if want go; then
  if [ "$MODE" = repo ] && have go && { [ "$TIER" = deep ] || [ -n "${AUDIT_GO:-}" ]; }; then
    t0=$(date +%s)
    bash "$HERE/tools/go-scan.sh" "$TARGET" "$OUT" "$TIER" > "$OUT/raw/go.log" 2>&1
    record go ran $(( $(date +%s) - t0 )) "$(go version | cut -d' ' -f3)" "$(tr '\n' ';' < "$OUT/raw/go/status.txt" 2>/dev/null)"
  else record go skipped 0 "" "fast tier runs it only when zetaphy-chain/ changed (AUDIT_GO=1)"; fi
fi

# --- 10. dependencies: npm audit (production deps) + OSV-Scanner -----------
if want deps; then
  t0=$(date +%s)
  rm -rf "$OUT/raw/deps"; mkdir -p "$OUT/raw/deps"
  if [ "$MODE" = repo ]; then
    locks=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).lockfiles.join("\n"))' "$HERE/scope.json")
  else
    locks=$(cd "$TARGET" && find . -name node_modules -prune -o \( -name package-lock.json -o -name yarn.lock -o -name pnpm-lock.yaml -o -name Cargo.lock -o -name go.sum \) -print | sed 's#^\./##')
  fi
  osv_args=()
  for l in $locks; do
    [ -f "$TARGET/$l" ] || continue
    osv_args+=(-L "$TARGET/$l")
    if [ "$(basename "$l")" = package-lock.json ] && have npm; then
      d=$(dirname "$l")
      (cd "$TARGET/$d" && npm audit --package-lock-only --omit=dev --json > "$OUT/raw/deps/npm-$(echo "$d" | tr '/' '_').json" 2>/dev/null)
    fi
  done
  if have osv-scanner && [ ${#osv_args[@]} -gt 0 ]; then
    osv-scanner scan source "${osv_args[@]}" --format json --output-file "$OUT/raw/deps/osv.json" > "$OUT/raw/deps/osv.log" 2>&1
    # osv-scanner exits non-zero when it FINDS something; a database it could not reach is a failure
    if grep -qE 'Error during extraction|request failed' "$OUT/raw/deps/osv.log"; then
      rm -f "$OUT/raw/deps/osv.json"
      record osv-scanner failed $(( $(date +%s) - t0 )) "$(osv-scanner --version | head -1 | awk '{print $NF}')" "could not reach the OSV database: $(grep -oE 'request failed[^"]*"[^"]*"[^:]*: [A-Za-z ]+' "$OUT/raw/deps/osv.log" | head -1)"
    else
      record osv-scanner ran $(( $(date +%s) - t0 )) "$(osv-scanner --version | head -1 | awk '{print $NF}')"
    fi
  else record osv-scanner "not installed" 0 ""; fi
  if have npm; then
    bad=$(for f in "$OUT"/raw/deps/npm-*.json; do node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]));if(d.error||!d.auditReportVersion)console.log(process.argv[1])' "$f" 2>/dev/null || echo "$f"; done)
    for f in $bad; do rm -f "$f"; done
    if [ -n "$bad" ]; then record npm-audit failed 0 "npm $(npm --version)" "no audit answer for: $(echo "$bad" | xargs -n1 basename | tr '\n' ' ')"
    else record npm-audit ran 0 "npm $(npm --version)" "production dependencies (--omit=dev)"; fi
  fi
fi

[ -n "$ONLY" ] || printf '%s\n' "$(( $(date +%s) - T_ALL ))" > "$OUT/raw/seconds.txt"
[ -z "$NO_REPORT" ] || exit 0
REPORT_ARGS=("$OUT")
[ -n "$REPORT" ] && REPORT_ARGS+=(--md "$REPORT")
node "$HERE/report.js" "${REPORT_ARGS[@]}" --triage "$HERE/triage.yml" --baseline "$HERE/baseline.json"
