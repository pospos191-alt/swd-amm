// What `zetaphy deploy-assist attest|anchor|insurance` deploys (src/assistcli.js), shared with the frontier deploy
// (src/frontierdeploy.js) so both build the same constructor: NeuroAttest, NeuroAnchor, or the testnet-only HackInsurance
// (its claim committee: NeuroJobs runners, `quorum` voters with at least `minAgreed` accepted verdicts).
export const ASSIST_DEFAULTS = Object.freeze({ quorum: 3, minAgreed: 1 });
const ZERO = '0x' + '00'.repeat(20);

/** [contract name, constructor args] for one deploy-assist command, or null for an unknown one. */
export function assistDeployArgs(cmd, { gov, jobs = null, quorum = ASSIST_DEFAULTS.quorum, minAgreed = ASSIST_DEFAULTS.minAgreed } = {}) {
  const make = {
    attest: () => ['NeuroAttest', [jobs ?? ZERO, gov]],
    anchor: () => ['NeuroAnchor', []],
    insurance: () => { if (!jobs) throw new Error('--jobs 0x<NeuroJobs> (the committee is its runners)'); return ['HackInsurance', [jobs, Number(quorum), Number(minAgreed), gov]]; },
  }[cmd];
  return make ? make() : null;
}
