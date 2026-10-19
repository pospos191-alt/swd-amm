# build-info

Put the compiler's build-info file(s) for the ZETAPHY launcher here.

- Hardhat: `artifacts/build-info/*.json` (Hardhat 3 also writes a matching
  `*.output.json` next to each one: copy both).
- Foundry: `out/build-info/*.json` (build with `forge build --build-info`).

These files hold the exact sources and compiler settings used for the
deploy. Explorers need exactly that to verify. They contain no keys, but
check that nothing secret was ever pasted into a `.sol` file.
