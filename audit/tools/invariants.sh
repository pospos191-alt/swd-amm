#!/usr/bin/env bash
# Runs the invariant / property suites that exist, and records each result as
# passed / failed / not run (a suite that is missing or whose tool is not
# installed is "not run": never "passed").
#
#   audit/tools/invariants.sh <target> <out> <fast|deep> <repo|target>
#
# Where suites are looked for:
#   this repository: the "invariants.dirs" of audit/scope.json
#                    (zetaphy-network/audit/invariants, zetaphy-dex/audit/invariants, ...)
#   another target:  every directory under it named audit/invariants, test/invariant(s)
#                    or containing echidna.yaml / medusa.json (outside node_modules and lib)
#
# What runs in a suite directory (conventions in audit/README.md):
#   foundry.toml   (in the suite directory, or <project>/foundry.toml with test = "audit/invariants"
#                  for <project>/audit/invariants)
#                  forge test: invariant_* (stateful fuzzing) and test*/testFuzz*
#                  fast: 32 runs x depth 15 (a smoke test); deep: 1000 x 100
#   foundry.toml   halmos (deep only): symbolic proofs of every check_* function
#   medusa.json    medusa fuzz (deep only), its own config (targetContracts)
#   echidna.yaml   echidna (deep only) on every contract named *Echidna* in the suite
# Results: <out>/raw/invariants/summary.json
set -uo pipefail
TARGET=$1; OUT=$2; TIER=$3; MODE=$4
HERE=$(cd "$(dirname "$0")/.." && pwd)
R="$OUT/raw/invariants"; mkdir -p "$R"
have() { command -v "$1" >/dev/null 2>&1; }
SUITES="$R/suites.tsv"; : > "$SUITES"   # dir  tool  passed  failed  notRun  note
add() { printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$@" >> "$SUITES"; echo "invariants: $1 $2 passed=$3 failed=$4 notRun=$5 $6"; }

if [ "$MODE" = repo ]; then
  dirs=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).invariants.dirs.join("\n"))' "$HERE/scope.json")
else
  dirs=$(cd "$TARGET" && find . \( -name node_modules -o -name lib -o -name .git \) -prune -o -type d \( -path '*/audit/invariants' -o -path '*/test/invariant' -o -path '*/test/invariants' \) -print | sed 's#^\./##')
  dirs="$dirs"$'\n'$(cd "$TARGET" && find . \( -name node_modules -o -name lib -o -name .git \) -prune -o \( -name echidna.yaml -o -name medusa.json \) -print | xargs -r -n1 dirname | sed 's#^\./##')
fi
dirs=$(echo "$dirs" | sed '/^$/d' | sort -u)

if [ "$TIER" = deep ]; then RUNS=${INVARIANT_RUNS:-1000}; DEPTH=${INVARIANT_DEPTH:-100}; FUZZ=${FUZZ_RUNS:-10000}; else RUNS=32; DEPTH=15; FUZZ=256; fi
for d in $dirs; do
  abs="$TARGET/$d"
  if [ ! -d "$abs" ]; then add "$d" none 0 0 1 "directory not there yet"; continue; fi
  name=$(echo "$d" | tr '/' '_')
  # The Foundry project of a suite: a foundry.toml in the suite directory itself, or the project's
  # own foundry.toml two levels up (<project>/foundry.toml with test = "audit/invariants", which is
  # how zetaphy-network / zetaphy-dex / zetaphy-nft keep src = "contracts" next to the suites).
  fdir=""
  if [ -f "$abs/foundry.toml" ]; then fdir=$abs
  elif [ "$(basename "$d")" = invariants ] && [ "$(basename "$(dirname "$d")")" = audit ] && [ -f "$abs/../../foundry.toml" ] \
    && grep -qE '^\s*test\s*=\s*"audit/invariants"' "$abs/../../foundry.toml"; then fdir=$(cd "$abs/../.." && pwd)
  fi
  if [ -n "$fdir" ]; then
    if have forge; then
      (cd "$fdir" && FOUNDRY_INVARIANT_RUNS=$RUNS FOUNDRY_INVARIANT_DEPTH=$DEPTH FOUNDRY_FUZZ_RUNS=$FUZZ \
        timeout "${FORGE_TIMEOUT:-3600}" forge test --json > "$R/$name.forge.json" 2> "$R/$name.forge.err")
      counts=$(node -e '
        let d; try { d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch { console.log("0 0 1 no-json-output"); process.exit(); }
        let p = 0, f = 0; const failed = [];
        for (const [suite, r] of Object.entries(d)) for (const [t, x] of Object.entries(r.test_results ?? {})) {
          if (x.status === "Success") p++; else { f++; failed.push(suite.split(":").pop() + "." + t); }
        }
        console.log(p, f, 0, failed.join(",") || "-");' "$R/$name.forge.json")
      add "$d" forge $counts
    else add "$d" forge 0 0 1 "forge not installed"; fi
    if [ "$TIER" = deep ]; then
      if have halmos; then
        (cd "$fdir" && timeout "${HALMOS_TIMEOUT:-3600}" halmos --json-output "$R/$name.halmos.json" > "$R/$name.halmos.log" 2>&1)
        counts=$(node -e '
          let d; try { d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch { console.log("0 0 1 no-json-output(no check_ functions?)"); process.exit(); }
          let p = 0, f = 0, n = 0; const failed = [];
          for (const [c, list] of Object.entries(d.test_results ?? {})) for (const t of list) {
            if (t.exitcode === 0) p++; else if (t.exitcode === 1) { f++; failed.push(c.split(":").pop() + "." + t.name); } else n++;
          }
          console.log(p, f, n, failed.join(",") || "-");' "$R/$name.halmos.json")
        add "$d" halmos $counts
      else add "$d" halmos 0 0 1 "halmos not installed"; fi
    fi
  fi
  # medusa.json / echidna.yaml: in the suite directory, or in its echidna/ subdirectory (zetaphy-network
  # keeps them in audit/invariants/echidna/ and runs them from the project root, where foundry.toml is).
  fz=""; for c in "$abs" "$abs/echidna"; do [ -f "$c/medusa.json" ] || [ -f "$c/echidna.yaml" ] && { fz=$c; break; }; done
  run_in=${fdir:-$abs}
  rel=${fz#"$run_in"/}; [ "$fz" = "$run_in" ] && rel=.
  if [ -n "$fz" ] && [ -f "$fz/medusa.json" ] && [ "$TIER" = deep ]; then
    if have medusa; then
      (cd "$run_in" && timeout "${MEDUSA_TIMEOUT:-3600}" medusa fuzz --config "$rel/medusa.json" --timeout "${MEDUSA_SECONDS:-1800}" --no-color > "$R/$name.medusa.log" 2>&1)
      p=$(grep -oE '[0-9]+ test\(s\) passed' "$R/$name.medusa.log" | tail -1 | grep -oE '^[0-9]+' || echo 0)
      f=$(grep -oE '[0-9]+ test\(s\) failed' "$R/$name.medusa.log" | tail -1 | grep -oE '^[0-9]+' || echo 0)
      add "$d" medusa "${p:-0}" "${f:-0}" 0 "-"
    else add "$d" medusa 0 0 1 "medusa not installed"; fi
  fi
  if [ -n "$fz" ] && [ -f "$fz/echidna.yaml" ] && [ "$TIER" = deep ]; then
    if have echidna; then
      contracts=$(grep -rhoE '^\s*contract\s+\w*Echidna\w*' "$fz" --include='*.sol' | awk '{print $2}' | grep -v Smoke | sort -u)
      p=0; f=0
      for c in $contracts; do
        (cd "$run_in" && timeout "${ECHIDNA_TIMEOUT:-3600}" echidna . --contract "$c" --config "$rel/echidna.yaml" --format text > "$R/$name.$c.echidna.log" 2>&1)
        p=$((p + $(grep -cE ': (passing|passed)' "$R/$name.$c.echidna.log"))); f=$((f + $(grep -cE ': failed' "$R/$name.$c.echidna.log")))
      done
      add "$d" echidna $p $f 0 "${contracts:-no *Echidna* contract}"
    else add "$d" echidna 0 0 1 "echidna not installed"; fi
  fi
  if [ -z "$fdir" ] && [ -z "$fz" ]; then
    add "$d" none 0 0 1 "no foundry.toml / medusa.json / echidna.yaml"
  fi
done
node -e '
  const rows = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map((l) => l.split("\t"));
  const suites = rows.map(([dir, tool, p, f, n, note]) => ({ dir, tool, passed: +p, failed: +f, notRun: +n, note: note === "-" ? "" : note }));
  const sum = (k) => suites.reduce((s, x) => s + x[k], 0);
  const r = { tier: process.argv[3], passed: sum("passed"), failed: sum("failed"), notRun: sum("notRun"), suites };
  require("fs").writeFileSync(process.argv[2], JSON.stringify(r, null, 1));
  console.log(`passed ${r.passed}, failed ${r.failed}, not run ${r.notRun}`);
' "$SUITES" "$R/summary.json" "$TIER"
