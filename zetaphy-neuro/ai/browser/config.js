// Where the in-browser AI finds its model and its on-chain knowledge (testnet).
//
// modelRegistry: the ModelRegistry address on ZETAPHY. null until it is deployed
// (zetaphy-network/scripts/model-registry.js deploy) and the release below is
// published there through the timelock. While it is null the page uses PINNED,
// the release record written by scripts/build-model-pack.js
// (web/models/neuro-ml-gbdt/1/release.json; a test keeps the two equal): the
// hashes are then vouched for by this page's own code, not by the chain, and
// the panel says so.
import { ZETAPHY } from '../../graph/sources.js';

export const BROWSER_AI = {
  chainId: ZETAPHY.chainId,
  rpc: ZETAPHY.rpc,
  modelRegistry: null,
  threatRegistry: ZETAPHY.threatRegistry,
  neuroJobs: null,          // NeuroJobs address for past verdicts (null: not read)
  knowledgeWindows: 40,     // eth_getLogs windows per sync (500 blocks each), per click
  model: { kind: 'model', name: 'neuro-ml-gbdt' },
  // relative to the page (/web/): this site; more mirrors (GitHub Releases, IPFS) can be listed here or in the manifest
  mirrors: [{ label: 'this site', manifest: './models/neuro-ml-gbdt/1/manifest.json', chunk: './models/neuro-ml-gbdt/1/{hash}.bin' }],
};

export const PINNED = {
  version: 1,
  status: 'active',
  manifestHash: '0x5b4896cc85d32a230a05099ffb3855f39a03ac61895af4760edbe0d0517c2302',
  chunkRoot: '0xfa1b039d506793c52e004260d82657279543fc143cf992919adb67d8589265db',
  size: 87087,
  chunkSize: 16384,
};
