// Registered contract templates (code fingerprints from src/fingerprint.js).
//
// To register a ZETAPHY launcher template: take ONE token made by the
// launcher on each chain and run
//   node cli.js fingerprint <bsc|base|arbitrum> <token address>
// then paste the printed entry below. Every other token made from the same
// template will then be recognised.
//
// `guarantees` are what the template's code promises (from ZETAPHY's own
// rules: tax can only go down, no minting, no blacklist, no pause). Neuro
// still runs every normal check, and reports a contradiction loudly if a
// "guaranteed" power shows up anyway. These promises are not audited yet.
//
// Known guarantee keys: 'tax-decrease-only', 'no-mint', 'no-blacklist', 'no-pause'.

export const TEMPLATES = [
  {
    fingerprint: 'fp1:a2a5f84a4cc3e712206b2c8918f3300e82ca54787020d31adb453290b69174be',
    project: 'ZETAPHY',
    name: 'ZETAPHY token',
    // Same code => same fingerprint on any chain, so it is recognised wherever
    // the launcher deployed it. Taken from a BNB Chain token (19 Oct 2026).
    chains: ['bsc', 'base', 'arbitrum', 'eth'],
    // Seen absent in the sample token's code: no mint, blacklist or pause
    // functions. No tax setter was detected, so tax-decrease-only is not
    // claimed here.
    guarantees: ['no-mint', 'no-blacklist', 'no-pause'],
    source: 'bsc 0xc1ed4b78071e7c9a84958d8be0215a10984fc28f (NEWZETA)',
  },
  // {
  //   fingerprint: 'fp1:…',
  //   project: 'ZETAPHY',
  //   name: 'ZETAPHY token',
  //   chains: ['bsc', 'base', 'arbitrum'],
  //   guarantees: ['tax-decrease-only', 'no-mint', 'no-blacklist', 'no-pause'],
  //   source: 'bsc 0x… (token used to take the fingerprint)',
  // },
];
