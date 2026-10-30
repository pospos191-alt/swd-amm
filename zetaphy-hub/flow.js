// The "How it works" strip above every hub tab and the data behind the AI map tab (aimap.js): line icons,
// four steps per tab with an icon each (words in flow-i18n.js), the tabs to go to next, and where each of the
// 35 AI features lives and how far it is (docs/future/*.md).
import { withFallback, LANG_CODES } from './i18n.js';
import { FLOW } from './flow-i18n.js';

// 24×24 line icons, drawn with currentColor (classes only: the hub's CSP allows no inline style).
export const ICON = {
  wallet: '<path d="M3 7h15a3 3 0 0 1 3 3v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l12-4 2 4M16 13h2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3M12 15v2"/>',
  shield: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6zM9 12l2 2 4-4"/>',
  faucet: '<path d="M4 9h9a3 3 0 0 1 3 3v1M4 6v6M16 13v2M16 19.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/>',
  coin: '<circle cx="12" cy="12" r="8"/><path d="M14.5 9.5h-4a1.5 1.5 0 0 0 0 3h3a1.5 1.5 0 0 1 0 3h-4M12 7.5V9M12 15.5V17"/>',
  swap: '<path d="M4 8h14l-4-4M20 16H6l4 4"/>',
  image: '<path d="M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4"/><circle cx="15.5" cy="9" r="1.5"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  paste: '<path d="M9 3h6v3H9zM7 4.5H5V21h14V4.5h-2M8 11h8M8 15h5"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  play: '<path d="M7 4l12 8-12 8z"/>',
  report: '<path d="M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5"/>',
  tokens: '<circle cx="8" cy="9" r="5"/><circle cx="16" cy="15" r="5"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  pen: '<path d="M4 20l4-1 11-11-3-3L5 16zM14 6l3 3"/>',
  server: '<path d="M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01"/>',
  users: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20a6 6 0 0 1 12 0M14.5 20a5 5 0 0 1 7-4.5"/>',
  vote: '<path d="M4 13h16v8H4zM8 13V5h8v8M10 9l1.5 1.5L14 8"/>',
  gift: '<path d="M4 10h16v4H4zM6 14v7h12v-7M12 10v11M12 10c-2-4-6-4-6-1.5S10 10 12 10c2 0 6 1 6-1.5S14 6 12 10z"/>',
  pick: '<path d="M14 4c3 0 5 1 6 3-3-1-6-1-9 1M14 4L4 20M9 8l3 3"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 9h6v6H9zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
  bridge: '<path d="M2 18h20M4 18v-3a8 8 0 0 1 16 0v3M8 18v-6M12 18v-7M16 18v-6"/>',
  link: '<path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1"/>',
  robot: '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M9.5 16.5h5"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".5"/>',
  fence: '<path d="M5 21V7l2-3 2 3v14M15 21V7l2-3 2 3v14M3 11h18M3 16h18"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8zM7.5 8.5h.01"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5zM3 13l9 5 9-5"/>',
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
  chart: '<path d="M4 20h16M7 16v-4M12 16V8M17 16V9"/>',
  pie: '<path d="M12 3v9h9A9 9 0 1 1 12 3z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>',
  flame: '<path d="M12 21a6 6 0 0 0 6-6c0-4-3-6-4-10-2 2-3 4-3 6-1-1-1.5-2-1.5-3C7.5 10 6 12.5 6 15a6 6 0 0 0 6 6z"/>',
  pool: '<path d="M3 15c3 0 3 2 6 2s3-2 6-2 3 2 6 2M3 19c3 0 3 2 6 2s3-2 6-2 3 2 6 2M8 12V5a2 2 0 0 1 4 0M14 12V5"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H4a3 3 0 0 0 4 4M16 6h4a3 3 0 0 1-4 4M12 13v4M8 21h8M9 17h6"/>',
  doc: '<path d="M6 3h9l4 4v14H6zM14 3v5h5"/>',
  gavel: '<path d="M14 4l6 6M11 7l6 6M9 9l4 4M4 20l7-7M3 21h8"/>',
  bug: '<rect x="7" y="8" width="10" height="12" rx="5"/><path d="M12 8v12M9 5l1.5 3M15 5l-1.5 3M3 13h4M17 13h4M4 8l3 2M20 8l-3 2M4 19l3-2M20 19l-3-2"/>',
  code: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>',
  globe: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.5 2.5 3.5 5 3.5 8s-1 5.5-3.5 8c-2.5-2.5-3.5-5-3.5-8s1-5.5 3.5-8z"/>',
  brain: '<path d="M9 3a3 3 0 0 0-3 3v1a3 3 0 0 0-2 5 3 3 0 0 0 2 5v1a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M15 3a3 3 0 0 1 3 3v1a3 3 0 0 1 2 5 3 3 0 0 1-2 5v1a3 3 0 0 1-6 0"/>',
  map: '<path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3zM9 3v15M15 6v15"/>',
  spark: '<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>',
  network: '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M7 6h10M6 8l5 8M18 8l-5 8"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  umbrella: '<path d="M3 12a9 9 0 0 1 18 0zM12 12v6a2 2 0 0 0 4 0"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  dna: '<path d="M7 3c0 6 10 6 10 12s-10 6-10 6M17 3c0 6-10 6-10 12M9 7h6M9 17h6"/>',
  swords: '<path d="M4 4l9 9M4 4h4M4 4v4M20 4l-9 9M20 4h-4M20 4v4M7 17l-3 3M17 17l3 3M9 15l-2 2M15 15l2 2"/>',
  eyeLock: '<path d="M2 12s4-7 10-7 10 7 10 7"/><rect x="8" y="12" width="8" height="8" rx="1.5"/><path d="M10 12v-1.5a2 2 0 0 1 4 0V12"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/>',
  grid: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>',
};

/** An SVG icon element (no innerHTML from data: the paths are the constants above). */
export function icon(name, cls = 'fl-ic') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', cls);
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICON[name] ?? ICON.spark;
  return s;
}

/** Per tab: an icon for each of its four steps, and the tabs to go to next. */
export const FLOWS = {
  home: { icons: ['wallet', 'faucet', 'swap', 'brain'], next: ['wallet', 'mine', 'neuro', 'ai'] },
  wallet: { icons: ['key', 'shield', 'search', 'lock'], next: ['mine', 'swap', 'stake'] },
  swap: { icons: ['tokens', 'brain', 'sliders', 'pen'], next: ['neuro', 'defi', 'wallet'] },
  stake: { icons: ['server', 'coin', 'gift', 'vote'], next: ['gov', 'leaderboard', 'earn'] },
  earn: { icons: ['faucet', 'pick', 'server', 'pool'], next: ['mine', 'stake', 'explorer'] },
  mine: { icons: ['paste', 'cpu', 'check', 'brain'], next: ['wallet', 'earn', 'explorer'] },
  saphan: { icons: ['map', 'pen', 'link', 'bridge'], next: ['wallet', 'swap', 'explorer'] },
  agents: { icons: ['robot', 'doc', 'play', 'fence'], next: ['wallet', 'ai', 'immune'] },
  nft: { icons: ['layers', 'image', 'tag', 'swap'], next: ['wallet', 'explorer'] },
  explorer: { icons: ['search', 'swap', 'shield', 'users'], next: ['analytics', 'leaderboard', 'immune'] },
  neuro: { icons: ['paste', 'eye', 'play', 'report'], next: ['immune', 'swap', 'ai'] },
  analytics: { icons: ['chart', 'flame', 'pie', 'clock'], next: ['explorer', 'defi', 'leaderboard'] },
  defi: { icons: ['pool', 'coin', 'grid', 'swap'], next: ['swap', 'analytics', 'neuro'] },
  leaderboard: { icons: ['trophy', 'server', 'clock', 'users'], next: ['stake', 'analytics'] },
  gov: { icons: ['doc', 'play', 'vote', 'gavel'], next: ['stake', 'immune', 'ai'] },
  immune: { icons: ['brain', 'shield', 'globe', 'lock'], next: ['neuro', 'gov', 'ai'] },
  dev: { icons: ['terminal', 'link', 'code', 'doc'], next: ['explorer', 'ai'] },
  ai: { icons: ['map', 'check', 'link', 'cube'], next: ['neuro', 'agents', 'immune'] },
};
export const flowText = (lang, tab) => withFallback(FLOW, lang).steps[tab];
export { LANG_CODES };

// ------------------------------------------------------------------ the AI map (35 roadmap items)
const DOCS = 'https://github.com/pospos191-alt/swd-amm/blob/main/docs/future/';
/** Doc page for a language (Thai has its own .th.md; the others read English). */
export const docUrl = (file, lang) => `${DOCS}${file}${lang === 'th' ? '.th' : ''}.md`;

export const GROUPS = [
  ['browserAi', 'cpu', [1, 2, 7, 8]],
  ['onchainMl', 'cube', [3, 4]],
  ['usefulWork', 'pick', [5, 10, 17, 34]],
  ['federated', 'network', [6, 35]],
  ['agents', 'robot', [9, 14, 23, 24, 25]],
  ['chain', 'shield', [11, 12, 13, 31, 33]],
  ['markets', 'chart', [15, 16, 26, 27, 29]],
  ['crosschain', 'globe', [18, 19, 20, 21, 22, 28, 30, 32]],
];
/**
 * The status shown: a "not deployed" item becomes "works now" once hub-config.json has every contract it
 * `needs` (written at build time from the deployments; .github/workflows/ai-deploy.yml).
 */
export function statusOf(it, contracts = {}) {
  if (it.s === 'notDeployed' && it.needs?.length && it.needs.every((k) => /^0x[0-9a-fA-F]{40}$/.test(String(contracts?.[k] ?? '')))) return 'live';
  return it.s;
}
export const STATUS_ICON = { live: 'check', practice: 'play', notDeployed: 'clock', chain: 'cube', cli: 'terminal' };

/**
 * Each item: status, icon, doc file, and where to open it: { tab, hint?, mode? } (a hub tab), { page } (a page of
 * this site) or nothing (no page: the doc says how it works).
 */
export const ITEMS = {
  1: { s: 'notDeployed', i: 'layers', doc: 'browser-ai', tab: 'neuro', hint: 'neuroAi', needs: ['modelRegistry'] },
  2: { s: 'practice', i: 'network', doc: 'browser-ai', tab: 'neuro', hint: 'neuroAi' },
  3: { s: 'cli', i: 'cube', doc: 'onchain-ml' },
  4: { s: 'practice', i: 'eyeLock', doc: 'onchain-ml', page: 'ceremony.html' },
  5: { s: 'practice', i: 'cpu', doc: 'useful-work', tab: 'mine', mode: 'work', hint: 'mineWork' },
  6: { s: 'notDeployed', i: 'users', doc: 'federated', tab: 'neuro', hint: 'neuroFl', needs: ['federatedRounds'] },
  7: { s: 'practice', i: 'brain', doc: 'browser-ai', tab: 'neuro', hint: 'neuroAi' },
  8: { s: 'live', i: 'doc', doc: 'browser-ai', tab: 'neuro', hint: 'neuroAi' },
  9: { s: 'notDeployed', i: 'fence', doc: 'agents', tab: 'agents', needs: ['cosignCommittee', 'webauthn'] },
  10: { s: 'notDeployed', i: 'trophy', doc: 'useful-work', tab: 'mine', mode: 'work', hint: 'mineWork', needs: ['workerReputation'] },
  11: { s: 'chain', i: 'cpu', doc: 'chain-protocol' },
  12: { s: 'chain', i: 'shield', doc: 'chain-protocol' },
  13: { s: 'chain', i: 'lock', doc: 'chain-protocol' },
  14: { s: 'cli', i: 'pen', doc: 'agents' },
  15: { s: 'notDeployed', i: 'chart', doc: 'markets', page: 'forecasts.html#forecasts', needs: ['riskForecasts'] },
  16: { s: 'notDeployed', i: 'pie', doc: 'markets', page: 'forecasts.html#data', needs: ['dataDao'] },
  17: { s: 'practice', i: 'bug', doc: 'useful-work', tab: 'mine', mode: 'work', hint: 'mineWork' },
  18: { s: 'cli', i: 'globe', doc: 'crosschain-assist', tab: 'immune' },
  19: { s: 'notDeployed', i: 'check', doc: 'crosschain-assist', tab: 'immune', needs: ['neuroAttest'] },
  20: { s: 'live', i: 'eye', doc: 'crosschain-assist', tab: 'wallet', hint: 'everyTx' },
  21: { s: 'live', i: 'gavel', doc: 'crosschain-assist', tab: 'gov' },
  22: { s: 'live', i: 'terminal', doc: 'crosschain-assist', page: 'validators.html' },
  23: { s: 'notDeployed', i: 'robot', doc: 'agents', tab: 'agents', needs: ['agentRegistry'] },
  24: { s: 'notDeployed', i: 'target', doc: 'agents', tab: 'agents', needs: ['intentExecutor'] },
  25: { s: 'notDeployed', i: 'tag', doc: 'agents', tab: 'agents', needs: ['labelRegistry', 'vouchRegistry'] },
  26: { s: 'notDeployed', i: 'dna', doc: 'markets', page: 'forecasts.html#detectors', needs: ['detectorPool'] },
  27: { s: 'notDeployed', i: 'swords', doc: 'markets', page: 'forecasts.html#arena', needs: ['arena'] },
  28: { s: 'notDeployed', i: 'network', doc: 'crosschain-assist', tab: 'immune', needs: ['neuroOracleSender'] },
  29: { s: 'notDeployed', i: 'eye', doc: 'markets', page: 'forecasts.html#foresight', needs: ['foresight'] },
  30: { s: 'practice', i: 'key', doc: 'crosschain-assist', tab: 'immune' },
  31: { s: 'chain', i: 'bridge', doc: 'chain-protocol' },
  32: { s: 'cli', i: 'umbrella', doc: 'crosschain-assist' },
  33: { s: 'chain', i: 'pause', doc: 'chain-protocol' },
  34: { s: 'cli', i: 'coin', doc: 'useful-work' },
  35: { s: 'cli', i: 'clock', doc: 'federated' },
};
