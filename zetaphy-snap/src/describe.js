// What the confirmation dialog says, in plain words, for the messages the snap has
// built (each message's `intent` is read back from the message pqtx.js built, so
// the dialog shows the canonical values that are encoded, not what the dapp sent).
// Pure: no snap APIs here, so tests can read the words directly.
import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  CHAIN_ID, DENOM, formatZeta, normalizeAddress, toChecksumHex, validatorAddress, bytesToHex, hexToBytes,
  STAKING_PRECOMPILE, DISTRIBUTION_PRECOMPILE, PQ_LOCK_ADDRESS, SECURITY_PRECOMPILE,
} from './pqtx.js';

const T = {
  en: {
    title: 'Sign a ZETAPHY transaction',
    requestedBy: 'Requested by',
    signer: 'Your ML-DSA-44 account',
    chain: 'Chain',
    otherChainTitle: 'Not ZETAPHY testnet',
    otherChain: 'This transaction is for the chain {chain}, not {testnet}.',
    send: 'Send',
    delegate: 'Stake (delegate)',
    undelegate: 'Unstake (undelegate)',
    withdrawRewards: 'Claim staking rewards',
    evmCall: 'Call a contract',
    evmTransfer: 'Send ZETAPHY (EVM transfer)',
    evmDeploy: 'Create a contract (deploy)',
    quantumLock: 'Hand over a quantum-locked account',
    to: 'To',
    to0x: 'To (0x form)',
    amount: 'Amount',
    validator: 'Validator',
    contract: 'Contract',
    method: 'Method',
    deploy: 'deploy (new contract)',
    unknownMethod: 'unknown method {sel}',
    value: 'ZETAPHY sent with it',
    evmGas: 'EVM gas limit',
    asOwner: 'Acting for (as_owner)',
    codeSize: 'Contract code',
    codeHash: 'Code hash (keccak-256)',
    bytes: '{n} bytes',
    data: 'Call data',
    tokenTo: 'Token recipient',
    tokenFrom: 'Token owner',
    tokenAmount: 'Token amount (smallest units)',
    spender: 'Spender',
    allowance: 'Allowance (smallest units)',
    unlimited: 'UNLIMITED',
    delegator: 'Delegator',
    owner: 'Locked account',
    controller: 'New controller',
    fee: 'Max fee',
    gas: 'Gas limit × price',
    total: 'Your account pays (ZETAPHY amounts + max fee)',
    memo: 'Memo',
    sequence: 'Account number / sequence',
    stakingPrecompile: 'staking precompile',
    distributionPrecompile: 'distribution precompile',
    noteUnbond: 'Unstaked ZETAPHY comes back only after the chain\'s unbonding period.',
    noteAsOwner: 'Funds and tokens leave {owner}, which is quantum-locked to your account. Your account pays the fee.',
    noteUnknownTitle: 'This call cannot be read',
    noteUnknown: 'The snap does not know method {sel}. Approve only if you trust {origin} and know what this contract does.',
    noteApproveTitle: 'Token approval',
    noteApprove: 'This lets {spender} move your tokens, up to the allowance, without asking again.',
    noteDeploy: 'Check the code hash against the one the contract\'s author published.',
    noteLockAddress: 'This calls the quantum-lock address {lock}.',
    noteHandoverTitle: 'You give up control',
    noteHandover: 'After this, your account can no longer act for {owner}; only {controller} can. You cannot undo it.',
    footer: 'Approve only if you started this yourself on {origin}. Nothing else is signed.',
    consent: 'Consent to call a flagged contract',
    qdayCommit: 'Q-day migration, step 1 (commitment)',
    qdayReveal: 'Q-day migration, step 2 (reveal)',
    ibcHoldCancel: 'Return a held IBC transfer',
    target: 'Flagged contract',
    duration: 'For',
    seconds: '{n} seconds',
    commitment: 'Commitment',
    holdId: 'Held transfer',
    noteConsentTitle: 'You go past a safety check',
    noteConsent: 'The network refuses calls from this account to {target} because the Neuro threat registry has an enforced flag on it. With this consent, it delivers them for {n} seconds. Read the flag\'s reason first; approve only if you are sure.',
    noteConsentWithdraw: 'This withdraws an earlier consent for {target}.',
    noteCommit: 'This records only a hash. It shows nothing about the old key; the reveal comes later.',
    noteRevealTitle: 'Control moves for good',
    noteReveal: 'After the wait, {owner} is controlled by {controller}. Only {origin} should ask for this, after you signed the migration text in your old wallet.',
    noteHoldCancel: 'Only the IBC hold guardian can do this: transfer {id} goes back to its sender on the other chain.',
  },
  th: {
    title: 'เซ็นธุรกรรม ZETAPHY',
    requestedBy: 'ขอโดย',
    signer: 'บัญชี ML-DSA-44 ของคุณ',
    chain: 'เชน',
    otherChainTitle: 'ไม่ใช่ ZETAPHY testnet',
    otherChain: 'ธุรกรรมนี้เป็นของเชน {chain} ไม่ใช่ {testnet}',
    send: 'โอน',
    delegate: 'Stake (delegate)',
    undelegate: 'ถอน stake (undelegate)',
    withdrawRewards: 'รับรางวัล stake',
    evmCall: 'เรียกสัญญา',
    evmTransfer: 'โอน ZETAPHY (ผ่าน EVM)',
    evmDeploy: 'สร้างสัญญาใหม่ (deploy)',
    quantumLock: 'ส่งต่อบัญชีที่ล็อกควอนตัม',
    to: 'ถึง',
    to0x: 'ถึง (แบบ 0x)',
    amount: 'จำนวน',
    validator: 'validator',
    contract: 'สัญญา',
    method: 'ฟังก์ชัน',
    deploy: 'deploy (สัญญาใหม่)',
    unknownMethod: 'ฟังก์ชันที่ไม่รู้จัก {sel}',
    value: 'ZETAPHY ที่ส่งไปด้วย',
    evmGas: 'EVM gas limit',
    asOwner: 'ทำในนามของ (as_owner)',
    codeSize: 'โค้ดสัญญา',
    codeHash: 'hash ของโค้ด (keccak-256)',
    bytes: '{n} ไบต์',
    data: 'ข้อมูลที่ส่ง (call data)',
    tokenTo: 'ผู้รับโทเคน',
    tokenFrom: 'เจ้าของโทเคน',
    tokenAmount: 'จำนวนโทเคน (หน่วยเล็กสุด)',
    spender: 'ผู้ได้รับอนุญาต',
    allowance: 'วงเงินที่อนุญาต (หน่วยเล็กสุด)',
    unlimited: 'ไม่จำกัด',
    delegator: 'ผู้ stake',
    owner: 'บัญชีที่ล็อกไว้',
    controller: 'ผู้ควบคุมคนใหม่',
    fee: 'ค่าธรรมเนียมสูงสุด',
    gas: 'gas limit × ราคา',
    total: 'บัญชีคุณจ่าย (จำนวน ZETAPHY + ค่าธรรมเนียมสูงสุด)',
    memo: 'บันทึก (memo)',
    sequence: 'หมายเลขบัญชี / sequence',
    stakingPrecompile: 'precompile สำหรับ stake',
    distributionPrecompile: 'precompile สำหรับรางวัล',
    noteUnbond: 'เงินที่ถอน stake จะกลับเข้าบัญชีหลังพ้นช่วง unbonding ของเชนเท่านั้น',
    noteAsOwner: 'เงินและโทเคนออกจาก {owner} ซึ่งล็อกควอนตัมให้บัญชีคุณ ค่าธรรมเนียมหักจากบัญชีคุณ',
    noteUnknownTitle: 'อ่านการเรียกนี้ไม่ออก',
    noteUnknown: 'snap ไม่รู้จักฟังก์ชัน {sel} อนุมัติเฉพาะเมื่อเชื่อ {origin} และรู้ว่าสัญญานี้ทำอะไร',
    noteApproveTitle: 'อนุญาตให้ใช้โทเคน',
    noteApprove: 'อนุญาตให้ {spender} ย้ายโทเคนของคุณได้ไม่เกินวงเงินนี้ โดยไม่ต้องถามอีก',
    noteDeploy: 'เทียบ hash ของโค้ดกับที่ผู้เขียนสัญญาประกาศไว้',
    noteLockAddress: 'นี่คือการเรียกที่อยู่ล็อกควอนตัม {lock}',
    noteHandoverTitle: 'คุณสละการควบคุม',
    noteHandover: 'หลังจากนี้ บัญชีคุณทำรายการแทน {owner} ไม่ได้อีก มีแต่ {controller} ที่ทำได้ และคุณยกเลิกเองไม่ได้',
    footer: 'อนุมัติเฉพาะเมื่อคุณเริ่มรายการนี้เองบน {origin} ไม่มีอะไรอื่นถูกเซ็น',
    consent: 'ยินยอมเรียกสัญญาที่ติดธง',
    qdayCommit: 'ย้ายบัญชีรับ Q-day ขั้นที่ 1 (commitment)',
    qdayReveal: 'ย้ายบัญชีรับ Q-day ขั้นที่ 2 (reveal)',
    ibcHoldCancel: 'คืนรายการ IBC ที่ถูกพักไว้',
    target: 'สัญญาที่ติดธง',
    duration: 'นาน',
    seconds: '{n} วินาที',
    commitment: 'commitment',
    holdId: 'รายการที่พักไว้',
    noteConsentTitle: 'คุณกำลังข้ามด่านตรวจความปลอดภัย',
    noteConsent: 'เครือข่ายปฏิเสธการเรียก {target} จากบัญชีนี้ เพราะ Neuro threat registry ติดธงแบบบังคับใช้ไว้ เมื่อยินยอม เครือข่ายจะส่งให้ได้นาน {n} วินาที อ่านเหตุผลของธงก่อน อนุมัติเฉพาะเมื่อแน่ใจ',
    noteConsentWithdraw: 'นี่คือการถอนความยินยอมที่เคยให้ไว้กับ {target}',
    noteCommit: 'บันทึกแค่ค่า hash ไม่เปิดเผยอะไรเกี่ยวกับกุญแจเก่า ขั้น reveal ทำทีหลัง',
    noteRevealTitle: 'ย้ายการควบคุมถาวร',
    noteReveal: 'เมื่อครบเวลารอ {owner} จะถูกควบคุมโดย {controller} ควรเป็น {origin} เท่านั้นที่ขอ หลังจากคุณเซ็นข้อความย้ายบัญชีในกระเป๋าเก่าแล้ว',
    noteHoldCancel: 'ทำได้เฉพาะ guardian ของ IBC hold: รายการ {id} จะกลับไปหาผู้ส่งบนเชนต้นทาง',
  },
};

const sel = (signature) => bytesToHex(keccak_256(new TextEncoder().encode(signature)).slice(0, 4));
const SEL = {
  transfer: sel('transfer(address,uint256)'),
  approve: sel('approve(address,uint256)'),
  transferFrom: sel('transferFrom(address,address,uint256)'),
  delegate: sel('delegate(address,string,uint256)'),
  undelegate: sel('undelegate(address,string,uint256)'),
  withdrawRewards: sel('withdrawDelegatorRewards(address,string)'),
  consent: sel('consent(address,uint64)'),
};
const MAX_UINT256 = 2n ** 256n - 1n;
/** Call data longer than this is shown cut, with its full length. */
const SHOWN_DATA_BYTES = 256;

// ---- ABI reading (only the shapes above; anything odd is shown as unknown) ----

const word = (b, i) => {
  if (b.length < 32 * (i + 1)) throw new Error('short');
  return BigInt('0x' + bytesToHex(b.slice(32 * i, 32 * i + 32)));
};
function addressWord(b, i) {
  const w = word(b, i);
  if (w >> 160n) throw new Error('not an address');
  return toChecksumHex(hexToBytes(w.toString(16).padStart(40, '0')));
}
function stringAt(b, i) {
  const off = word(b, i);
  if (off % 32n || off + 32n > BigInt(b.length)) throw new Error('bad offset');
  const n = word(b, Number(off / 32n));
  if (n > 256n || Number(off) + 32 + Number(n) > b.length) throw new Error('bad length');
  return new TextDecoder('utf-8', { fatal: true }).decode(b.slice(Number(off) + 32, Number(off) + 32 + Number(n)));
}
/** A validator string from call data: shown only if it is a real zetaphyvaloper1… address. */
function valoper(s) {
  try { return validatorAddress(s); } catch { throw new Error('not a validator'); }
}

/** [rows, notes, method label] for an EVM call's data, or null when the method is unknown. */
function decodeCall(to, data, t) {
  const sig = bytesToHex(data.slice(0, 4));
  const args = data.slice(4);
  const fixed = (n) => { if (args.length !== 32 * n) throw new Error('length'); };
  try {
    if (sig === SEL.transfer) {
      fixed(2);
      return { method: 'transfer(address,uint256) · ERC-20', rows: [[t.tokenTo, addressWord(args, 0)], [t.tokenAmount, word(args, 1).toString()]] };
    }
    if (sig === SEL.approve) {
      fixed(2);
      const spender = addressWord(args, 0); const v = word(args, 1);
      return { method: 'approve(address,uint256) · ERC-20', rows: [[t.spender, spender], [t.allowance, v === MAX_UINT256 ? t.unlimited : v.toString()]],
        notes: [{ severity: 'warning', title: t.noteApproveTitle, text: fill(t.noteApprove, { spender }) }] };
    }
    if (sig === SEL.transferFrom) {
      fixed(3);
      return { method: 'transferFrom(address,address,uint256) · ERC-20', rows: [[t.tokenFrom, addressWord(args, 0)], [t.tokenTo, addressWord(args, 1)], [t.tokenAmount, word(args, 2).toString()]] };
    }
    if ((sig === SEL.delegate || sig === SEL.undelegate) && to === STAKING_PRECOMPILE) {
      const name = sig === SEL.delegate ? 'delegate' : 'undelegate';
      return { method: `${name}(address,string,uint256) · ${t.stakingPrecompile}`,
        rows: [[t.delegator, addressWord(args, 0)], [t.validator, valoper(stringAt(args, 1))], [t.amount, `${formatZeta(word(args, 2))} ZETAPHY`]],
        notes: name === 'undelegate' ? [{ severity: 'info', text: t.noteUnbond }] : [] };
    }
    if (sig === SEL.consent && to === SECURITY_PRECOMPILE) {
      fixed(2);
      const target = addressWord(args, 0); const n = word(args, 1);
      return { method: 'consent(address,uint64) · ZETAPHY security precompile', rows: [[t.target, target], [t.duration, fill(t.seconds, { n })]],
        notes: [n > 0n ? { severity: 'danger', title: t.noteConsentTitle, text: fill(t.noteConsent, { target, n }) } : { severity: 'info', text: fill(t.noteConsentWithdraw, { target }) }] };
    }
    if (sig === SEL.withdrawRewards && to === DISTRIBUTION_PRECOMPILE) {
      return { method: `withdrawDelegatorRewards(address,string) · ${t.distributionPrecompile}`,
        rows: [[t.delegator, addressWord(args, 0)], [t.validator, valoper(stringAt(args, 1))]] };
    }
  } catch {
    // Known selector, odd arguments: shown as unknown, with the raw data.
  }
  return null;
}

const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
const zeta = (v) => `${formatZeta(BigInt(v))} ZETAPHY`;
const coin = (amount, denom) => (denom === DENOM ? zeta(amount) : `${amount} ${denom}`);
const both = (addr) => { const a = normalizeAddress(addr); return `${a.bech32}\n${a.hex}`; };
function shownHex(bytes) {
  const hex = '0x' + bytesToHex(bytes.slice(0, SHOWN_DATA_BYTES));
  return bytes.length > SHOWN_DATA_BYTES ? `${hex}… (${bytes.length} bytes)` : hex;
}

function describeMessage(m, i, ctx) {
  const { t, origin } = ctx;
  const it = m.intent;
  const rows = []; const notes = [];
  let title = t[it.type];
  switch (it.type) {
    case 'send': {
      const to = normalizeAddress(it.to);
      rows.push([t.to, to.bech32], [t.to0x, to.hex], [t.amount, coin(it.amount, it.denom)]);
      break;
    }
    case 'delegate':
    case 'undelegate':
      rows.push([t.validator, it.validator], [t.amount, coin(it.amount, it.denom)]);
      if (it.type === 'undelegate') notes.push({ severity: 'info', text: t.noteUnbond });
      break;
    case 'withdrawRewards':
      rows.push([t.validator, it.validator]);
      break;
    case 'evmCall':
    case 'evmDeploy': {
      const deploy = it.type === 'evmDeploy';
      const data = hexToBytes(deploy ? it.initCode : it.data);
      if (deploy) {
        rows.push([t.method, t.deploy], [t.codeSize, fill(t.bytes, { n: data.length })], [t.codeHash, '0x' + bytesToHex(keccak_256(data))]);
        notes.push({ severity: 'info', text: t.noteDeploy });
      } else {
        const label = it.to === STAKING_PRECOMPILE ? ` (${t.stakingPrecompile})` : it.to === DISTRIBUTION_PRECOMPILE ? ` (${t.distributionPrecompile})` : '';
        rows.push([data.length ? t.contract : t.to, it.to + label]);
        if (it.to === PQ_LOCK_ADDRESS) notes.push({ severity: 'warning', text: fill(t.noteLockAddress, { lock: PQ_LOCK_ADDRESS }) });
        if (data.length === 0) {
          title = t.evmTransfer;
        } else {
          const call = decodeCall(it.to, data, t);
          if (call) {
            rows.push([t.method, call.method], ...call.rows);
            notes.push(...(call.notes ?? []));
          } else {
            const s = '0x' + bytesToHex(data.slice(0, 4));
            rows.push([t.method, fill(t.unknownMethod, { sel: s })], [t.data, shownHex(data)]);
            notes.push({ severity: 'warning', title: t.noteUnknownTitle, text: fill(t.noteUnknown, { sel: s, origin }) });
          }
        }
      }
      if (BigInt(it.value) > 0n || (!deploy && data.length === 0)) rows.push([t.value, zeta(it.value)]);
      rows.push([t.evmGas, it.gasLimit]);
      if (it.asOwner) {
        rows.push([t.asOwner, both(it.asOwner)]);
        notes.push({ severity: 'warning', text: fill(t.noteAsOwner, { owner: normalizeAddress(it.asOwner).hex }) });
      }
      break;
    }
    case 'consent': {
      const n = BigInt(it.seconds);
      rows.push([t.target, it.target], [t.duration, fill(t.seconds, { n })]);
      if (it.asOwner) rows.push([t.asOwner, both(it.asOwner)]);
      notes.push(n > 0n ? { severity: 'danger', title: t.noteConsentTitle, text: fill(t.noteConsent, { target: it.target, n }) }
        : { severity: 'info', text: fill(t.noteConsentWithdraw, { target: it.target }) });
      break;
    }
    case 'qdayCommit':
      rows.push([t.commitment, it.commitment]);
      notes.push({ severity: 'info', text: t.noteCommit });
      break;
    case 'qdayReveal':
      rows.push([t.owner, both(it.owner)], [t.controller, both(it.controller)]);
      notes.push({ severity: 'danger', title: t.noteRevealTitle, text: fill(t.noteReveal, { owner: it.owner, controller: it.controller, origin }) });
      break;
    case 'ibcHoldCancel':
      rows.push([t.holdId, `#${it.id}`]);
      notes.push({ severity: 'warning', text: fill(t.noteHoldCancel, { id: it.id }) });
      break;
    case 'quantumLock':
      rows.push([t.owner, both(it.owner)], [t.controller, both(it.controller)]);
      notes.push({ severity: 'danger', title: t.noteHandoverTitle, text: fill(t.noteHandover, { owner: it.owner, controller: it.controller }) });
      break;
    default:
      throw new Error(`no description for ${it.type}`);
  }
  return { title: ctx.many ? `${i + 1}. ${title}` : title, rows, notes };
}

/** A delegation through the staking precompile takes its amount, not the call's value. */
function precompileDelegation(it) {
  if (it.type !== 'evmCall' || it.to !== STAKING_PRECOMPILE) return 0n;
  const data = hexToBytes(it.data);
  if (bytesToHex(data.slice(0, 4)) !== SEL.delegate) return 0n;
  try { return word(data.slice(4), 2); } catch { return 0n; }
}

/**
 * azetaphy the messages themselves take from the signer's own account, besides the fee: sends,
 * delegations, EVM values. (What a called contract then does, e.g. with tokens, is shown per call.)
 */
export function ownSpend(messages) {
  return messages.reduce((n, { intent: it }) => {
    if ((it.type === 'send' || it.type === 'delegate') && it.denom === DENOM) return n + BigInt(it.amount);
    if ((it.type === 'evmCall' || it.type === 'evmDeploy') && !it.asOwner) return n + BigInt(it.value) + precompileDelegation(it);
    return n;
  }, 0n);
}

/**
 * The dialog's content as data: { title, origin, banners, sections: [{ title, rows: [[label,
 * value]], notes }], footer }. messages: built by messageFromIntent (each has its intent).
 */
export function describeTx({ origin, signer, req, messages, lang = 'en' }) {
  const t = T[lang] ?? T.en;
  const ctx = { t, origin, many: messages.length > 1 };
  const fee = req.gasLimit * req.gasPrice;
  const banners = req.chainId === CHAIN_ID ? [] : [{ severity: 'warning', title: t.otherChainTitle, text: fill(t.otherChain, { chain: req.chainId, testnet: CHAIN_ID }) }];
  const summary = [
    [t.fee, zeta(fee)],
    [t.gas, `${req.gasLimit} × ${req.gasPrice} azetaphy`],
    [t.total, zeta(ownSpend(messages) + fee)],
  ];
  if (req.memo) summary.push([t.memo, req.memo]);
  summary.push([t.chain, req.chainId], [t.sequence, `${req.accountNumber} / ${req.sequence}`], [t.signer, `${signer.bech32}\n${signer.hex}`]);
  return {
    title: t.title,
    requestedBy: t.requestedBy,
    origin,
    banners,
    sections: messages.map((m, i) => describeMessage(m, i, ctx)),
    summary,
    footer: fill(t.footer, { origin }),
  };
}
