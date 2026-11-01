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
  // Automatic peer discovery (ai/browser/discovery.js). signalBoard: the SignalBoard address on
  // ZETAPHY (zetaphy-network/scripts/signal-board.js deploy); null until deployed, and then the page
  // offers only the manual codes. Posting uses a throwaway session key paid by the testnet faucet.
  signalBoard: '0x515c7135D501B7980e84c9cFac74AD528698AF69',
  // Public WebTorrent trackers as a second board: OFF (empty). Each is a third party that sees
  // every peer's IP address and topic, and the CSP (web/index.html + vercel.json connect-src)
  // would need its exact wss:// URL added first.
  trackers: [],
  // STUN servers to cross home NATs (a third party sees the IP address asking); none = same network only.
  iceServers: [],
  discovery: { pollMs: 5000, ttl: 300, maxPeers: 4, offerTimeoutMs: 90_000 },
  // Upload limits when this browser serves chunks to others.
  upload: { maxBytesPerSecond: 2 * 1024 * 1024, maxBytesTotal: 256 * 1024 * 1024 },
};

// The tiny language model split across browsers (ai/browser/llama.js; docs/future/browser-ai.md item 7).
export const BROWSER_LLM = {
  model: { kind: 'model', name: 'zetaphy-docs-tiny' },
  mirrors: [{ label: 'this site', manifest: './models/zetaphy-docs-tiny/1/manifest.json', chunk: './models/zetaphy-docs-tiny/1/{hash}.bin' }],
  maxNew: 80,
};

// Pinned like PINNED above (web/models/zetaphy-docs-tiny/1/release.json; a test keeps them equal).
export const PINNED_LLM = {
  version: 1,
  status: 'active',
  manifestHash: '0x4cf41414f2f963269ad8f3f41ef96a1e54e58917f4e02a475a188ea1ffba73ad',
  chunkRoot: '0x886a2e732863cdf9d5a7db3bb91572145e7f638fa8dec5bc9cbaff7eb968c320',
  size: 1365824,
  chunkSize: 65536,
  layers: 6,
};

export const PINNED = {
  version: 1,
  status: 'active',
  manifestHash: '0xea2b241a562c00eb1b5ef3e910728bb1cb0fa0450eb89c28d80a36cf4cf391b5',
  chunkRoot: '0x642f93596ff33eb0bff10388505efc4aba05030bb8019949a3c510010a46a8f9',
  size: 75510,
  chunkSize: 16384,
};
