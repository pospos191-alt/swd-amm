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
  // {
  //   fingerprint: 'fp1:…',
  //   project: 'ZETAPHY',
  //   name: 'ZETAPHY token',
  //   chains: ['bsc', 'base', 'arbitrum'],
  //   guarantees: ['tax-decrease-only', 'no-mint', 'no-blacklist', 'no-pause'],
  //   source: 'bsc 0x… (token used to take the fingerprint)',
  // },
];
