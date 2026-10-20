// zetaphy_signTx parameters, checked strictly before anything is built or shown.
// The dapp sends structured messages (intents, see messageFromIntent in pqtx.js),
// never bytes: the snap builds the transaction itself, shows it in plain words and
// signs what it built. Unknown fields are refused, so a dapp cannot believe it set
// something (a sender, a fee payer, a timeout) that the snap would ignore.
import { DEFAULT_EVM_GAS_LIMIT, DEFAULT_DEPLOY_GAS_LIMIT } from './pqtx.js';

export const MAX_MESSAGES = 8;
/** The Cosmos SDK's default MaxMemoCharacters. */
export const MAX_MEMO_CHARS = 256;
/** EIP-3860's limit on init code; call data is held to the same. */
export const MAX_DATA_BYTES = 49152;
export const MAX_TX_GAS = 100000000n;
/** 10^6 ZETAPHY per unit of gas: far above any real price, below any overflow. */
export const MAX_GAS_PRICE = 10n ** 24n;
const MAX_UINT64 = 2n ** 64n - 1n;
const MAX_UINT256 = 2n ** 256n - 1n;

/** type -> [required fields, optional fields] */
const MESSAGES = {
  send: [['to', 'amount'], ['denom']],
  delegate: [['validator', 'amount'], ['denom']],
  undelegate: [['validator', 'amount'], ['denom']],
  withdrawRewards: [['validator'], []],
  evmCall: [['to'], ['data', 'value', 'gasLimit', 'asOwner']],
  evmDeploy: [['initCode'], ['value', 'gasLimit', 'asOwner']],
  quantumLock: [['owner', 'controller'], []],
};
export const MESSAGE_TYPES = Object.keys(MESSAGES);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

function fields(obj, required, optional, what) {
  if (!isPlainObject(obj)) throw new Error(`${what} must be an object`);
  for (const k of Object.keys(obj)) {
    if (!required.includes(k) && !optional.includes(k)) throw new Error(`${what}: unknown field "${k}"`);
  }
  for (const k of required) if (obj[k] === undefined) throw new Error(`${what}: "${k}" is required`);
}

/** A whole number as a decimal string (or a safe integer), within [min, max]. */
function uint(v, what, { min = 0n, max = MAX_UINT256 } = {}) {
  let s;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) s = String(v);
  else if (typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v)) s = v;
  else throw new Error(`${what} must be a whole number as a decimal string`);
  const x = BigInt(s);
  if (x < min) throw new Error(`${what} must be at least ${min}`);
  if (x > max) throw new Error(`${what} must be at most ${max}`);
  return x;
}

/** An address as typed (0x… or zetaphy1… / zetaphyvaloper1…); pqtx.js checks it fully. */
function address(v, what) {
  if (typeof v !== 'string' || !/^[0-9a-zA-Z]{1,100}$/.test(v)) throw new Error(`${what} must be an address (0x… or zetaphy1…)`);
  return v;
}

function hexData(v, what) {
  if (typeof v !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(v)) throw new Error(`${what} must be 0x-prefixed hex bytes`);
  if ((v.length - 2) / 2 > MAX_DATA_BYTES) throw new Error(`${what} is longer than ${MAX_DATA_BYTES} bytes`);
  return v.toLowerCase();
}

function denom(v) {
  if (typeof v !== 'string' || !/^[a-zA-Z][a-zA-Z0-9/:._-]{2,127}$/.test(v)) throw new Error('denom is not a valid Cosmos denom');
  return v;
}

/** One message intent -> the same intent with every value checked and in canonical string form. */
function intent(m, i) {
  const what = `messages[${i}]`;
  if (!isPlainObject(m)) throw new Error(`${what} must be an object`);
  if (typeof m.type !== 'string' || !MESSAGE_TYPES.includes(m.type)) throw new Error(`${what}: type must be one of ${MESSAGE_TYPES.join(', ')}`);
  const spec = MESSAGES[m.type];
  fields(m, ['type', ...spec[0]], spec[1], `${what} (${m.type})`);
  const out = { type: m.type };
  const has = (k) => m[k] !== undefined;
  switch (m.type) {
    case 'send':
      out.to = address(m.to, `${what}.to`);
      out.amount = uint(m.amount, `${what}.amount`, { min: 1n }).toString();
      if (has('denom')) out.denom = denom(m.denom);
      break;
    case 'delegate':
    case 'undelegate':
      out.validator = address(m.validator, `${what}.validator`);
      out.amount = uint(m.amount, `${what}.amount`, { min: 1n }).toString();
      if (has('denom')) out.denom = denom(m.denom);
      break;
    case 'withdrawRewards':
      out.validator = address(m.validator, `${what}.validator`);
      break;
    case 'evmCall':
    case 'evmDeploy':
      if (m.type === 'evmCall') {
        out.to = address(m.to, `${what}.to`);
        out.data = has('data') ? hexData(m.data, `${what}.data`) : '0x';
      } else {
        out.initCode = hexData(m.initCode, `${what}.initCode`);
        if (out.initCode === '0x') throw new Error(`${what}.initCode: a contract creation needs init code`);
      }
      out.value = has('value') ? uint(m.value, `${what}.value`).toString() : '0';
      out.gasLimit = has('gasLimit') ? uint(m.gasLimit, `${what}.gasLimit`, { max: MAX_UINT64 }).toString()
        : String(m.type === 'evmCall' ? DEFAULT_EVM_GAS_LIMIT : DEFAULT_DEPLOY_GAS_LIMIT);
      if (has('asOwner') && m.asOwner !== '') out.asOwner = address(m.asOwner, `${what}.asOwner`);
      break;
    case 'quantumLock':
      out.owner = address(m.owner, `${what}.owner`);
      out.controller = address(m.controller, `${what}.controller`);
      break;
    default:
      throw new Error(`${what}: unknown type`);
  }
  return out;
}

/**
 * The checked request: { chainId, accountNumber, sequence, gasLimit, gasPrice (bigints),
 * memo, lang, intents }. Throws an Error with a plain reason on anything malformed.
 */
export function parseSignRequest(params) {
  fields(params, ['chainId', 'accountNumber', 'sequence', 'gasLimit', 'gasPrice', 'messages'], ['memo', 'lang'], 'params');
  const { chainId } = params;
  if (typeof chainId !== 'string' || !/^zetaphy[-_][a-z0-9][a-z0-9-]{0,39}$/.test(chainId)) throw new Error('chainId must be a ZETAPHY chain id such as zetaphy_77390-1');
  const memo = params.memo ?? '';
  if (typeof memo !== 'string' || memo.length > MAX_MEMO_CHARS) throw new Error(`memo must be text of at most ${MAX_MEMO_CHARS} characters`);
  // Control and invisible formatting characters (e.g. bidi overrides) could make the memo read differently.
  if (/\p{C}/u.test(memo)) throw new Error('memo must not contain control or invisible characters');
  const lang = params.lang ?? 'en';
  if (lang !== 'en' && lang !== 'th') throw new Error('lang must be "en" or "th"');
  const { messages } = params;
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('messages must be a non-empty array');
  if (messages.length > MAX_MESSAGES) throw new Error(`at most ${MAX_MESSAGES} messages in one transaction`);
  const req = {
    chainId,
    accountNumber: uint(params.accountNumber, 'accountNumber', { max: MAX_UINT64 }),
    sequence: uint(params.sequence, 'sequence', { max: MAX_UINT64 }),
    gasLimit: uint(params.gasLimit, 'gasLimit', { min: 1n, max: MAX_TX_GAS }),
    gasPrice: uint(params.gasPrice, 'gasPrice', { max: MAX_GAS_PRICE }),
    memo,
    lang,
    intents: messages.map(intent),
  };
  // The chain charges each MsgEVMCall's EVM gas on the tx's gas meter: a tx with less gas than
  // that fails after the fee is paid, so it is refused here instead.
  const evmGas = req.intents.reduce((n, m) => n + (m.gasLimit ? BigInt(m.gasLimit) : 0n), 0n);
  if (evmGas > 0n && req.gasLimit <= evmGas) throw new Error('gasLimit must be more than the EVM gas limits of the messages (the chain charges the EVM gas on the tx)');
  return req;
}
