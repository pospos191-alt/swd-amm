// Rule engine: turns what was read from the chain into findings.
// Fixed rules only, no AI and no randomness: the same input always gives
// the same findings, so any two machines can check each other's answer
// (plan weakness #1, "work that can be re-checked").

const ZERO = '0x0000000000000000000000000000000000000000';
const RANK = { high: 3, medium: 2, low: 1, info: 0, good: 0 };

// Owner-gated powers. `base` is the severity while someone still holds control.
const POWERS = [
  { cat: 'mint', id: 'can-mint', base: 'high' },
  { cat: 'blacklist', id: 'can-blacklist', base: 'high' },
  { cat: 'pause', id: 'can-pause', base: 'high' },
  { cat: 'seize', id: 'can-seize', base: 'high' },
  { cat: 'fee', id: 'can-change-fee', base: 'medium' },
  { cat: 'trading', id: 'trading-switch', base: 'medium' },
  { cat: 'limit', id: 'can-limit', base: 'medium' },
];

// Template guarantee -> the power category it rules out.
const GUARANTEED_ABSENT = { 'no-mint': 'mint', 'no-blacklist': 'blacklist', 'no-pause': 'pause' };

// A name like "Claim at reward-site.xyz" is a common phishing airdrop trick.
const LINK_RE = /(https?:\/\/|www\.|\b[a-z0-9-]{2,}\.(com|net|org|io|xyz|app|site|top|vip|pro|finance|claims?|gift|live|online|info)\b|t\.me\/)/i;

/**
 * @param {object} input
 * @param {boolean} input.hasCode
 * @param {Array<{selector:string,sig:string,cat:string}>} input.functions  known functions (proxy + implementation)
 * @param {{selfdestruct:boolean,delegatecall:boolean,callcode:boolean}} input.opcodes  of the logic contract
 * @param {{kind:'eip1967'|'beacon'|'eip1167'|null, implementation?:string, admin?:string}} input.proxy
 * @param {{name?:string,symbol?:string,decimals?:number,totalSupply?:string}} input.token
 * @param {string|null|undefined} input.owner  undefined = no owner() found or call failed
 * @param {{project:string,name:string,guarantees?:string[]}|null} [input.template]  registered template this code matches
 * @param {{symbol:string,issuer:string,kind:string,address:string}|null} [input.known]  official token at this exact address
 * @param {{symbol:string,issuer:string,address:string}|null} [input.lookalike]  official token whose symbol this one copies
 * @param {string[]} [input.unknownSelectors]  dispatcher functions with no known name
 * @param {{flagged: boolean, reason?: string}|null} [input.threat]  ZETAPHY ThreatRegistry verdict for this code
 * @returns {{level:'high'|'medium'|'low'|'info', control:string, findings:Array}}
 */
export function analyze(input) {
  const findings = [];
  const add = (id, severity, params = {}) => findings.push({ id, severity, params });
  const known = input.known ?? null;
  // For an official issuer's own contract, powers the issuer is expected to
  // hold are about trusting the issuer, not hidden code: cap them at "low".
  const issuerCap = (severity) => (known && RANK[severity] > RANK.low ? 'low' : severity);

  if (!input.hasCode) {
    add('no-code', 'info');
    return { level: 'info', control: 'none', findings };
  }

  const cats = new Set(input.functions.map((f) => f.cat));
  const sigsIn = (cat) => input.functions.filter((f) => f.cat === cat).map((f) => f.sig);
  const proxy = input.proxy ?? { kind: null };
  // implementation() alone is only a getter; upgradeTo* (or USDT's deprecate,
  // which forwards all calls to a new contract) is what swaps the code.
  const upgradeable = proxy.kind === 'eip1967' || proxy.kind === 'beacon' || proxy.kind === 'zos'
    || sigsIn('upgrade').some((s) => s.startsWith('upgradeTo') || s === 'deprecate(address)');

  // Who controls the contract?
  let control;
  if (upgradeable) control = 'upgradeable';
  else if (cats.has('roles')) control = 'roles';
  else if (typeof input.owner === 'string' && input.owner !== ZERO) control = 'owner';
  else if (input.owner === ZERO) control = 'renounced';
  else control = 'unknown';

  // Token identity
  const t = input.token ?? {};
  if (cats.has('erc20') && t.symbol != null) {
    add('erc20', 'info', { name: t.name, symbol: t.symbol, decimals: t.decimals, totalSupply: t.totalSupply });
  } else if (!cats.has('erc20')) {
    add('not-erc20', 'info');
  }
  if ((t.name && LINK_RE.test(t.name)) || (t.symbol && LINK_RE.test(t.symbol))) {
    add('name-has-link', 'high', { name: t.name, symbol: t.symbol });
  }
  if (known) add('known-issuer', 'good', { symbol: known.symbol, issuer: known.issuer, kind: known.kind });
  // Neuro runners voted this exact code dangerous (immune system, stage 4).
  if (input.threat?.flagged) add('network-flagged', 'high', { reason: input.threat.reason });
  if (input.lookalike) {
    add('lookalike', 'high', { symbol: t.symbol, official: input.lookalike.address, issuer: input.lookalike.issuer });
  }

  // Proxy / upgrade
  if (proxy.kind === 'eip1167') {
    add('proxy-minimal', 'info', { implementation: proxy.implementation });
  } else if (upgradeable) {
    add('proxy-upgradeable', issuerCap('high'), { implementation: proxy.implementation, admin: proxy.admin, kind: proxy.kind, issuer: known?.issuer });
  }

  // Control
  if (control === 'owner') add('owner-active', 'info', { owner: input.owner });
  if (control === 'renounced') add('owner-renounced', 'good');
  if (control === 'roles') add('roles', issuerCap('medium'));
  if (control === 'unknown' && POWERS.some((p) => cats.has(p.cat))) add('owner-unknown', issuerCap('medium'));

  // Registered template (e.g. a ZETAPHY launcher token)
  const tpl = input.template ?? null;
  const promised = new Set(tpl?.guarantees ?? []);
  if (tpl) add('template-match', 'good', { project: tpl.project, name: tpl.name });
  for (const [key, cat] of Object.entries(GUARANTEED_ABSENT)) {
    // The registry says this power cannot exist, yet the code has it: the
    // registry entry is wrong or the template changed. Never trust it silently.
    if (promised.has(key) && cats.has(cat)) add('template-mismatch', 'high', { project: tpl.project, functions: sigsIn(cat) });
  }

  // Powers held by whoever controls it. Renounced ownership lowers them to
  // "low": the code is still there, but the usual onlyOwner guard can no
  // longer be passed (we cannot prove every function uses that guard).
  for (const p of POWERS) {
    if (!cats.has(p.cat)) continue;
    let severity = issuerCap(control === 'renounced' ? 'low' : p.base);
    const params = { functions: sigsIn(p.cat) };
    if (known) params.issuer = known.issuer;
    if (p.cat === 'fee' && promised.has('tax-decrease-only')) {
      severity = 'low';
      params.decreaseOnly = true;
      params.project = tpl.project;
    }
    add(p.id, severity, params);
  }
  if (cats.has('feeExempt')) add('fee-exempt', 'info', { functions: sigsIn('feeExempt') });
  if (cats.has('taxWallet')) add('tax-wallet', 'info', { functions: sigsIn('taxWallet') });

  // Functions we cannot name. With someone still in control they may be
  // privileged (a tax or limit setter under an unusual name), so never claim
  // "nothing found" over them.
  const unknown = input.unknownSelectors ?? [];
  if (unknown.length) {
    const controlled = control !== 'renounced';
    add('unknown-functions', controlled ? issuerCap('low') : 'info', { count: unknown.length, selectors: unknown.slice(0, 12) });
  }

  // Dangerous instructions in the logic contract
  if (input.opcodes?.selfdestruct) add('selfdestruct', 'high');
  if ((input.opcodes?.delegatecall || input.opcodes?.callcode) && !proxy.kind) add('delegatecall', 'medium');

  if (!findings.some((f) => RANK[f.severity] > 0 || f.severity === 'good')) add('nothing-found', 'info');
  // Verified source (Sourcify): undefined = not checked, null = not found.
  // Added after "nothing found": public source is not by itself a safety signal.
  if (input.source) add('source-verified', 'good', { match: input.source.match, language: input.source.language, compiler: input.source.compiler, name: input.source.name, url: input.source.url });
  else if (input.source === null) add('source-unverified', 'info');
  add('bytecode-only', 'info');

  const level = findings.reduce((m, f) => (RANK[f.severity] > RANK[m] ? f.severity : m), 'info');
  return { level, control, findings };
}

/**
 * Code Neuro's EVM rules cannot read: Stylus (Rust/C compiled to WASM on
 * Arbitrum) or another non-EVM format. Only what the ABI can still answer
 * (name, symbol, owner) is used; the powers stay unknown and are said so.
 * @param {{format:'stylus'|'eof', token:object, owner?:string|null, known?:object|null, lookalike?:object|null}} input
 */
export function analyzeOpaque(input) {
  const findings = [];
  const add = (id, severity, params = {}) => findings.push({ id, severity, params });
  const known = input.known ?? null;
  const t = input.token ?? {};
  if (t.symbol != null) add('erc20', 'info', { name: t.name, symbol: t.symbol, decimals: t.decimals, totalSupply: t.totalSupply });
  if ((t.name && LINK_RE.test(t.name)) || (t.symbol && LINK_RE.test(t.symbol))) add('name-has-link', 'high', { name: t.name, symbol: t.symbol });
  if (known) add('known-issuer', 'good', { symbol: known.symbol, issuer: known.issuer, kind: known.kind });
  if (input.lookalike) add('lookalike', 'high', { symbol: t.symbol, official: input.lookalike.address, issuer: input.lookalike.issuer });
  add(input.format === 'stylus' ? 'stylus-code' : 'unknown-code-format', known ? 'low' : 'medium', known ? { issuer: known.issuer } : {});
  if (typeof input.owner === 'string' && input.owner !== ZERO) add('owner-active', 'info', { owner: input.owner });
  else if (input.owner === ZERO) add('owner-renounced', 'good');
  add('bytecode-only', 'info');
  const level = findings.reduce((m, f) => (RANK[f.severity] > RANK[m] ? f.severity : m), 'info');
  return { level, control: input.format, findings };
}

/** An EIP-7702 account: a normal wallet whose key holder chose to run another contract's code. */
export function analyzeDelegated(target) {
  const findings = [
    { id: 'eip7702', severity: 'medium', params: { target } },
    { id: 'bytecode-only', severity: 'info', params: {} },
  ];
  return { level: 'medium', control: 'eip7702', findings };
}
