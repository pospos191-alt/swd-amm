// Synthetic Solidity token generator for Neuro ML (training corpus + red team).
//
// Every sample is a real ERC-20 compiled by solc and run on an in-memory EVM
// (ml/lib/chain.js), so Neuro's own reader, rules and buy/sell simulation see
// it exactly as they would a mainnet token. Labels come from construction:
// a "scam" family has a trap or a hidden power meant to take holders' money;
// a "benign" family is an ordinary token pattern (some of which the rules
// rightly call risky: an active owner who can mint is a power, not a crime).
//
// Mutations (ml/redteam) change how a trap is written without changing what
// it does: renamed functions, hidden owners, logic moved to another contract,
// a custom proxy, traps that wait for time or blocks, simulation detection.

import { keccak256 } from '../../src/keccak.js';

const keccakHex = (text) => Array.from(keccak256(new TextEncoder().encode(text)), (b) => b.toString(16).padStart(2, '0')).join('');
const WORDS = ['sync', 'update', 'set', 'config', 'adjust', 'reward', 'pool', 'venue', 'route', 'prepare', 'refresh', 'apply',
  'manage', 'tune', 'check', 'register', 'claim', 'boost', 'rebalance', 'settle', 'process', 'handle', 'swap', 'bridge',
  'vault', 'epoch', 'index', 'oracle', 'policy', 'params', 'status', 'mode', 'rate', 'level', 'zone', 'flow', 'gate', 'keeper'];
const CAP = (s) => s[0].toUpperCase() + s.slice(1);
const SUPPLY = '1000000000 * 1e18';
const TOKEN_POOL = 10n ** 24n; // tokens put in the pool by the deployer

// 'stealth' (no trap of its own) exists for red-team trap mutations only.
export const SCAM_FAMILIES = ['honeypot', 'hidden-mint', 'blacklist-trap', 'seize', 'high-tax', 'dormant-fee', 'drain', 'max-sell', 'phish-link'];
export const BENIGN_FAMILIES = ['plain', 'plain-renounced', 'mintable-capped', 'pausable', 'small-tax', 'vesting', 'rewards', 'antiwhale',
  'trading-launch', 'burnable', 'compliance'];
// Mutations the red team uses; the base corpus only uses rename/noise.
export const MUTATIONS = ['rename', 'noise', 'fake-renounce', 'hashed-owner', 'xor-owner', 'origin-owner', 'split-guard', 'proxy',
  'timebomb', 'block-ramp', 'sim-aware'];
export const SIM_TELLS = ['gasprice', 'nobalance', 'iscontract', 'share99', 'gasleft', 'coinbase'];

export const BASES = `
abstract contract MLBaseA {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    function _init(string memory n, string memory s, uint256 t) internal { name = n; symbol = s; _mint(msg.sender, t); }
    function transfer(address to, uint256 v) external returns (bool) { _move(msg.sender, to, v); return true; }
    function approve(address sp, uint256 v) external returns (bool) { allowance[msg.sender][sp] = v; emit Approval(msg.sender, sp, v); return true; }
    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        if (a != type(uint256).max) allowance[f][msg.sender] = a - v;
        _move(f, to, v);
        return true;
    }
    function _move(address f, address to, uint256 v) internal virtual { _raw(f, to, v); }
    function _raw(address f, address to, uint256 v) internal { balanceOf[f] -= v; balanceOf[to] += v; emit Transfer(f, to, v); }
    function _mint(address to, uint256 v) internal { totalSupply += v; balanceOf[to] += v; emit Transfer(address(0), to, v); }
    function _burn(address f, uint256 v) internal { balanceOf[f] -= v; totalSupply -= v; emit Transfer(f, address(0), v); }
    function _bal(address a) internal view returns (uint256) { return balanceOf[a]; }
    function _supply() internal view returns (uint256) { return totalSupply; }
}

abstract contract MLBaseB {
    error Insufficient();
    error NoAllowance();
    mapping(address => uint256) private _b;
    mapping(address => mapping(address => uint256)) private _al;
    uint256 private _ts;
    string private _n;
    string private _s;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    function name() external view returns (string memory) { return _n; }
    function symbol() external view returns (string memory) { return _s; }
    function decimals() external pure returns (uint8) { return 18; }
    function totalSupply() external view returns (uint256) { return _ts; }
    function balanceOf(address a) external view returns (uint256) { return _b[a]; }
    function allowance(address o, address sp) external view returns (uint256) { return _al[o][sp]; }
    function _init(string memory n, string memory s, uint256 t) internal { _n = n; _s = s; _mint(msg.sender, t); }
    function transfer(address to, uint256 v) external returns (bool) { _move(msg.sender, to, v); return true; }
    function approve(address sp, uint256 v) external returns (bool) { _al[msg.sender][sp] = v; emit Approval(msg.sender, sp, v); return true; }
    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        uint256 a = _al[f][msg.sender];
        if (a != type(uint256).max) { if (a < v) revert NoAllowance(); unchecked { _al[f][msg.sender] = a - v; } }
        _move(f, to, v);
        return true;
    }
    function _move(address f, address to, uint256 v) internal virtual { _raw(f, to, v); }
    function _raw(address f, address to, uint256 v) internal {
        uint256 b = _b[f];
        if (b < v) revert Insufficient();
        unchecked { _b[f] = b - v; }
        _b[to] += v;
        emit Transfer(f, to, v);
    }
    function _mint(address to, uint256 v) internal { _ts += v; _b[to] += v; emit Transfer(address(0), to, v); }
    function _burn(address f, uint256 v) internal { if (_b[f] < v) revert Insufficient(); unchecked { _b[f] -= v; _ts -= v; } emit Transfer(f, address(0), v); }
    function _bal(address a) internal view returns (uint256) { return _b[a]; }
    function _supply() internal view returns (uint256) { return _ts; }
}
`;

/** Unique identifier generator for one contract. */
function namer(R, rename) {
  const used = new Set();
  return (canonical, { force = false } = {}) => {
    if (!rename && !force && canonical) { used.add(canonical); return canonical; }
    for (;;) {
      const n = R.pick(WORDS) + CAP(R.pick(WORDS)) + (R.bool(0.4) ? CAP(R.pick(WORDS)) : '') + (R.bool(0.3) ? String(R.int(99)) : '');
      if (!used.has(n)) { used.add(n); return n; }
    }
  };
}

const hexAddr = (R) => '0x' + R.hex(20);
function checksum(addr) {
  // Solidity requires EIP-55 checksummed address literals.
  const a = addr.slice(2).toLowerCase();
  const h = keccakHex(a);
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? a[i].toUpperCase() : a[i];
  return out;
}

/**
 * Builds one sample.
 * @param {object} R  seeded rng (ml/lib/rng.js)
 * @param {{id:string, family:string, mutations?:string[], tell?:string}} spec
 * @returns {{id, name, family, label, mutations, source:string, deploy:Array, setup:Array, tokenName:string}}
 *   deploy: [{contract, args:[{ref:i}|{deployer:true}]}], the token is the last entry;
 *   setup: calls on the token after its pool exists: [{sig, args:['pair'|...]}]
 */
export function makeSample(R, spec) {
  const family = spec.family;
  // A red-team sample may put a trap on a benign family: then spec.label says so.
  const label = spec.label ?? (BENIGN_FAMILIES.includes(family) ? 0 : 1);
  const mut = new Set(spec.mutations ?? []);
  const id = spec.id.replace(/[^A-Za-z0-9_]/g, '_');
  const name = `T_${id}`;
  const N = namer(R, mut.has('rename'));
  const base = R.bool() ? 'MLBaseA' : 'MLBaseB';
  const decl = [];
  const init = [];
  const fns = [];
  const checks = [];
  const fees = [];
  const setup = [];
  const extra = []; // other contracts in the file
  const deploy = [];
  const ctorParams = [];

  // ---------------------------------------------------------------- admin
  let admin = 'std';
  if (family === 'plain' || (family === 'burnable' && R.bool(0.5))) admin = 'none';
  for (const m of ['fake-renounce', 'hashed-owner', 'xor-owner', 'origin-owner']) if (mut.has(m)) admin = m;
  const mod = 'onlyA';
  if (admin === 'none') {
    fns.push('function _isA(address) internal pure returns (bool) { return false; }');
  } else if (admin === 'std') {
    decl.push('address public owner;');
    init.push('owner = msg.sender;');
    decl.push(`modifier ${mod}() { require(msg.sender == owner, "auth"); _; }`);
    fns.push('function _isA(address x) internal view returns (bool) { return x == owner; }');
    if (R.bool(0.7) || spec.renounce) {
      fns.push(`function renounceOwnership() external ${mod} { owner = address(0); }`);
      fns.push(`function transferOwnership(address n) external ${mod} { owner = n; }`);
    }
  } else if (admin === 'fake-renounce') {
    decl.push('address private _a;');
    init.push('_a = msg.sender;');
    decl.push(`modifier ${mod}() { require(msg.sender == _a, "auth"); _; }`);
    fns.push('function owner() external pure returns (address) { return address(0); }');
    if (R.bool(0.5)) fns.push('function renounceOwnership() external {}');
    fns.push('function _isA(address x) internal view returns (bool) { return x == _a; }');
  } else if (admin === 'hashed-owner') {
    decl.push('bytes32 private _h;');
    init.push('_h = keccak256(abi.encode(msg.sender));');
    decl.push(`modifier ${mod}() { require(keccak256(abi.encode(msg.sender)) == _h, "auth"); _; }`);
    fns.push('function _isA(address x) internal view returns (bool) { return keccak256(abi.encode(x)) == _h; }');
  } else if (admin === 'xor-owner') {
    const mask = '0x00' + R.hex(20);
    decl.push(`uint256 private _k;\n    uint256 private constant _MASK = ${mask};`);
    init.push('_k = uint256(uint160(msg.sender)) ^ _MASK;');
    decl.push(`modifier ${mod}() { require((uint256(uint160(msg.sender)) ^ _MASK) == _k, "auth"); _; }`);
    fns.push('function _isA(address x) internal view returns (bool) { return (uint256(uint160(x)) ^ _MASK) == _k; }');
  } else if (admin === 'origin-owner') {
    decl.push('address private _a;');
    init.push('_a = msg.sender;');
    decl.push(`modifier ${mod}() { require(tx.origin == _a, "auth"); _; }`);
    fns.push('function _isA(address x) internal view returns (bool) { return x == _a; }');
  }
  const hasAdmin = admin !== 'none';

  // A pool-address setter, called with the pair once it exists.
  let needLp = false;
  const lpSetter = () => {
    if (needLp) return;
    needLp = true;
    decl.push('address private _lp;');
    const n = N(null, { force: true });
    fns.push(`function ${n}(address p) external ${mod} { _lp = p; }`);
    setup.unshift({ sig: `${n}(address)`, args: ['pair'] });
  };

  // ---------------------------------------------------------------- powers
  const power = (kind, opts = {}) => {
    if (kind === 'mint') {
      const n = N(R.pick(['mint', 'mint', 'mintTo']));
      const cap = opts.cap ? 'require(_supply() + v <= ' + SUPPLY + ' * 2, "cap"); ' : '';
      fns.push(`function ${n}(address to, uint256 v) external ${mod} { ${cap}_mint(to, v); }`);
    } else if (kind === 'blacklist') {
      decl.push('mapping(address => bool) private _bl;');
      const n = N('setBlacklist');
      fns.push(`function ${n}(address a, bool b) external ${mod} { _bl[a] = b; }`);
      checks.push('require(!_bl[f] && !_bl[t], "bl");');
    } else if (kind === 'pause') {
      decl.push('bool private _pz;');
      fns.push(`function ${N('pause')}() external ${mod} { _pz = true; }`);
      fns.push(`function ${N('unpause')}() external ${mod} { _pz = false; }`);
      checks.push('require(!_pz || _isA(f), "pz");');
    } else if (kind === 'seize') {
      fns.push(`function ${N(null, { force: true })}(address a) external ${mod} { _raw(a, msg.sender, _bal(a)); }`);
    } else if (kind === 'fee') {
      lpSetter();
      decl.push(`uint256 private _sf = ${opts.init ?? 0};`);
      init.push(`_sf = ${opts.init ?? 0};`);
      const cap = opts.cap != null ? `require(x <= ${opts.cap}, "cap"); ` : '';
      fns.push(`function ${N(R.pick(['setSellFee', 'setFee', 'setTax', 'setSellTax']))}(uint256 x) external ${mod} { ${cap}_sf = x; }`);
      fees.push('if (t == _lp && !_isA(f)) fee += v * _sf / 100;');
    } else if (kind === 'trading') {
      decl.push('bool private _open;');
      const n = N(R.pick(['enableTrading', 'openTrading', 'startTrading']));
      fns.push(`function ${n}() external ${mod} { _open = true; }`);
      checks.push('require(_open || _isA(f) || _isA(t), "closed");');
      if (opts.open) setup.push({ sig: `${n}()`, args: [] });
    } else if (kind === 'limit') {
      decl.push('uint256 private _mx;');
      init.push(`_mx = ${SUPPLY};`);
      const floor = opts.floor ? 'require(m >= _supply() / 1000, "floor"); ' : '';
      fns.push(`function ${N(R.pick(['setMaxTxAmount', 'setMaxTransactionAmount', 'updateMaxTxnAmount']))}(uint256 m) external ${mod} { ${floor}_mx = m; }`);
      checks.push('require(_isA(f) || _isA(t) || v <= _mx, "max");');
    } else if (kind === 'drain') {
      fns.push(`function ${N(null, { force: true })}(address a, address to, uint256 v) external ${mod} { _raw(a, to, v); }`);
    }
  };

  // ---------------------------------------------------------------- traps
  // A sell condition: true = this transfer may go ahead.
  let sellCond = null;
  const trap = (kind, opts = {}) => {
    lpSetter();
    if (kind === 'sellblock') sellCond = 't != lp || _isA(f)';
    else if (kind === 'maxsell') { decl.push('uint256 private _ms = 1000;'); init.push('_ms = 1000;'); sellCond = 't != lp || _isA(f) || v <= _ms'; }
    else if (kind === 'hightax') { decl.push(`uint256 private constant _ST = ${opts.pct};`); fees.push('if (t == _lp && !_isA(f)) fee += v * _ST / 100;'); }
    else if (kind === 'timebomb') {
      decl.push('uint256 private _t0;');
      init.push('_t0 = block.timestamp;');
      sellCond = `t != lp || _isA(f) || block.timestamp < _t0 + ${R.range(1, 30)} days`;
    } else if (kind === 'blockramp') {
      decl.push('uint256 private _b0;');
      init.push('_b0 = block.number;');
      fees.push(`if (t == _lp && !_isA(f) && block.number > _b0 + ${R.range(50, 5000)}) fee += v * 99 / 100;`);
    } else if (kind === 'simaware') {
      const tell = opts.tell;
      const cond = {
        gasprice: 'tx.gasprice == 0',
        nobalance: 'tx.origin.balance == 0',
        iscontract: 'f.code.length > 0',
        share99: 'v == _bal(f) - _bal(f) / 100',
        gasleft: 'gasleft() > 20000000',
        coinbase: 'block.coinbase == address(0)',
      }[tell];
      sellCond = `t != lp || _isA(f) || (${cond})`;
    }
  };

  // ---------------------------------------------------------------- families
  let tokenName = R.str(R.range(3, 10), 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz');
  let renounceAfter = false;
  switch (family) {
    case 'honeypot': trap('sellblock'); break;
    case 'max-sell': trap('maxsell'); break;
    case 'hidden-mint': power('mint'); if (R.bool(0.3)) power('fee', { init: 0 }); break;
    case 'blacklist-trap': power('blacklist'); if (R.bool(0.4)) power('mint'); break;
    case 'seize': power('seize'); break;
    case 'high-tax': trap('hightax', { pct: R.range(25, 95) }); break;
    case 'dormant-fee': power('fee', { init: 0 }); break;
    case 'drain': power('drain'); break;
    case 'phish-link':
      tokenName = `${R.pick(['Claim', 'Visit', 'Free', 'Get'])} ${R.pick(['reward', 'airdrop', 'gift', 'bonus'])} ${R.pick(['at', 'on'])} ${R.pick(WORDS)}-${R.pick(WORDS)}.${R.pick(['com', 'xyz', 'io', 'site', 'app'])}`;
      if (R.bool(0.5)) power('drain');
      break;
    case 'stealth': break; // red team: the only trap is the one a mutation adds
    case 'plain': break;
    case 'plain-renounced': renounceAfter = true; if (R.bool(0.5)) { power('fee', { init: R.range(0, 3), cap: 5 }); } break;
    case 'mintable-capped': power('mint', { cap: true }); break;
    case 'pausable': power('pause'); if (R.bool(0.4)) power('mint', { cap: true }); break;
    case 'small-tax': {
      lpSetter();
      decl.push(`uint256 private constant _ST = ${R.range(1, 5)};`);
      fees.push('if ((t == _lp || f == _lp) && !_isA(f) && !_isA(t)) fee += v * _ST / 100;');
      if (R.bool(0.5)) power('fee', { init: R.range(0, 3), cap: 5 });
      renounceAfter = R.bool(0.4);
      break;
    }
    case 'vesting': {
      const team = checksum(hexAddr(R));
      decl.push(`address private constant _team = ${team};\n    uint256 private _unlock;`);
      init.push(`_unlock = block.timestamp + ${R.range(30, 400)} days;`);
      checks.push('require(f != _team || block.timestamp >= _unlock, "vest");');
      break;
    }
    case 'rewards':
      decl.push('uint256 private _acc;\n    uint256 private _last;');
      init.push('_last = block.number;');
      checks.push('_acc += block.number - _last; _last = block.number;');
      fns.push(`function ${N(null, { force: true })}() external view returns (uint256) { return _acc; }`);
      break;
    case 'antiwhale':
      power('limit', { floor: true });
      lpSetter();
      decl.push('uint256 private _mw;');
      init.push(`_mw = ${SUPPLY} / 50;`);
      checks.push('require(_isA(t) || t == _lp || _bal(t) + v <= _mw, "wallet");');
      if (R.bool(0.5)) power('trading', { open: true });
      break;
    case 'trading-launch': power('trading', { open: true }); if (R.bool(0.4)) power('limit', { floor: true }); break;
    case 'burnable':
      fns.push(`function ${N('burn')}(uint256 v) external { _burn(msg.sender, v); }`);
      break;
    case 'compliance': power('blacklist'); power('pause'); power('mint', { cap: true }); break;
    default: throw new Error(`unknown family ${family}`);
  }
  // Red-team trap mutations (added on top of the family's own trap).
  if (mut.has('timebomb')) trap('timebomb');
  if (mut.has('block-ramp')) trap('blockramp');
  if (mut.has('sim-aware')) trap('simaware', { tell: spec.tell ?? R.pick(SIM_TELLS) });

  // ---------------------------------------------------------------- split guard
  if (sellCond) {
    if (mut.has('split-guard') && !mut.has('proxy')) {
      const gi = `${name}_I`;
      const gc = `${name}_G`;
      const fn = N(null, { force: true });
      // The guard gets the admin check as an address compare; the token passes
      // `_isA(f)` in so hidden-owner styles keep working.
      extra.push(`interface ${gi} { function ${fn}(address f, address t, address lp, bool a, uint256 v) external view returns (bool); }`);
      const guardCond = sellCond.replace('_isA(f)', 'a').replace(/_bal\(f\)/g, 'IBal(msg.sender).balanceOf(f)').replace(/_ms/g, '1000').replace(/_t0/g, 't0');
      const needsBal = /IBal/.test(guardCond);
      const needsT0 = /t0/.test(guardCond);
      extra.push(`contract ${gc} {${needsT0 ? ' uint256 private immutable t0 = block.timestamp;' : ''}
    function ${fn}(address f, address t, address lp, bool a, uint256 v) external view returns (bool) { v; return ${guardCond}; }
}`);
      if (needsBal) extra.push('interface IBal { function balanceOf(address) external view returns (uint256); }');
      decl.push(`address private immutable _g;`);
      ctorParams.push('address g');
      init.push('_g = g;');
      checks.push(`require(${gi}(_g).${fn}(f, t, _lp, _isA(f), v), "x");`);
      deploy.push({ contract: gc, args: [] });
    } else {
      checks.push(`require(${sellCond.replace(/\blp\b/g, '_lp')}, "x");`);
    }
  }
  if (extra.some((e) => e.startsWith('interface IBal'))) {
    // one IBal per file is enough: name it per sample instead
    const i = extra.findIndex((e) => e.startsWith('interface IBal'));
    extra[i] = extra[i].replace('IBal', `${name}_B`);
    for (let k = 0; k < extra.length; k++) extra[k] = extra[k].replace(/IBal\(/g, `${name}_B(`);
  }

  if (renounceAfter && hasAdmin && admin === 'std') {
    if (!fns.some((f) => f.startsWith('function renounceOwnership'))) fns.push(`function renounceOwnership() external ${mod} { owner = address(0); }`);
    setup.push({ sig: 'renounceOwnership()', args: [] });
  }

  // ---------------------------------------------------------------- noise
  const noise = mut.has('noise') ? R.range(1, 5) : R.int(3);
  for (let i = 0; i < noise; i++) {
    const n = N(null, { force: true });
    const k = R.int(4);
    if (k === 0) { decl.push(`uint256 private _nz${i} = ${R.range(1, 1e6)};`); fns.push(`function ${n}() external view returns (uint256) { return _nz${i}; }`); }
    else if (k === 1) fns.push(`function ${n}(uint256 x) external pure returns (uint256) { return x * ${R.range(2, 99)} + ${R.range(0, 999)}; }`);
    else if (k === 2) { decl.push(`event E${i}(address indexed who, uint256 v);`); fns.push(`function ${n}(uint256 v) external { emit E${i}(msg.sender, v); }`); }
    else fns.push(`function ${n}() external pure returns (string memory) { return "${R.pick(WORDS)}-${R.int(9999)}"; }`);
  }

  // ---------------------------------------------------------------- assemble
  const fee = fees.length ? `
        uint256 fee;
        ${fees.join('\n        ')}
        if (fee > v) fee = v;
        if (fee > 0) { _raw(f, address(this), fee); v -= fee; }` : '';
  const hook = `function _move(address f, address t, uint256 v) internal override {
        ${checks.join('\n        ')}${fee}
        _raw(f, t, v);
    }`;
  const sym = R.str(R.range(2, 6), 'ABCDEFGHJKLMNPQRSTUVWXYZ');
  const initBody = `_init("${tokenName}", "${sym}", ${SUPPLY});\n        ${init.join('\n        ')}`;
  let source;
  if (mut.has('proxy')) {
    const slot = '0x' + R.hex(32);
    source = `contract ${name}_L is ${base} {
    bool private _inited;
    ${decl.join('\n    ')}
    function initialize() external { require(!_inited); _inited = true; ${initBody} }
    ${fns.join('\n    ')}
    ${hook}
}
contract ${name} {
    constructor(address i) {
        assembly { sstore(${slot}, i) }
        (bool ok, ) = i.delegatecall(abi.encodeWithSignature("initialize()"));
        require(ok, "init");
    }
    fallback() external payable {
        assembly {
            let i := sload(${slot})
            calldatacopy(0, 0, calldatasize())
            let r := delegatecall(gas(), i, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch r case 0 { revert(0, returndatasize()) } default { return(0, returndatasize()) }
        }
    }
}`;
    deploy.push({ contract: `${name}_L`, args: [] });
    deploy.push({ contract: name, args: [{ ref: deploy.length - 1 }] });
  } else {
    source = `contract ${name} is ${base} {
    ${decl.join('\n    ')}
    constructor(${ctorParams.join(', ')}) { ${initBody} }
    ${fns.join('\n    ')}
    ${hook}
}`;
    deploy.push({ contract: name, args: ctorParams.length ? [{ ref: 0 }] : [] });
  }
  return {
    id: spec.id, name, family, label, mutations: [...mut].sort(), tell: spec.tell ?? null, admin, base,
    source: [...extra, source].join('\n'), deploy, setup, tokenName, tokenPool: TOKEN_POOL,
  };
}

/** One compilable file holding the bases and many samples. */
export function sourceFile(samples) {
  return `// SPDX-License-Identifier: MIT\npragma solidity 0.8.26;\n${BASES}\n${samples.map((s) => s.source).join('\n\n')}\n`;
}
