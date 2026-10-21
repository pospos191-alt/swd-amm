// ZETAPHY MetaMask Snap: a post-quantum ML-DSA-44 account derived from the
// MetaMask Secret Recovery Phrase (snap_getEntropy), for the ZETAPHY chain.
//
//   zetaphy_getAccount  -> { publicKey, address (zetaphy1…), hex (0x…) }
//   zetaphy_signTx      -> builds the tx from structured messages (intents) with pqtx.js,
//                          shows it in plain words (snap_dialog), and only if the user
//                          approves returns { signature, txHex, txHash, bodyBytes, authInfoBytes }
//   zetaphy_getThreatSource -> { rpc, registry, overridden } the transaction insight uses
//   zetaphy_setThreatSource -> { rpc, registry } or { reset: true }; only from the ZETAPHY
//                          wallet's origin (WALLET_ORIGINS), and only after the user approves
//   onTransaction       -> the vaccine for any EVM transaction in MetaMask (threats.js)
//
// The seed and the secret key are made for each request, used, wiped, and never
// returned, stored or sent anywhere. Signing uses no network: the dapp broadcasts
// the tx. The only network use is the transaction insight's read-only calls to the
// ZETAPHY RPC (threats.js says exactly what is sent).
import { InvalidParamsError, MethodNotFoundError, UnauthorizedError, UserRejectedRequestError } from '@metamask/snaps-sdk';
import { Box, Heading, Row, Text } from '@metamask/snaps-sdk/jsx';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { accountFromEntropy, publicAccount, ENTROPY_SALT } from './account.js';
import { describeTx } from './describe.js';
import { Confirmation } from './dialog.jsx';
import { buildTx, bytesToHex, messageFromIntent } from './pqtx.js';
import { parseSignRequest } from './request.js';
import { checkTransaction, threatSource, setThreatSource, parseThreatSource, WALLET_ORIGINS } from './threats.js';
import { insight } from './insight.jsx';

async function withAccount(fn) {
  const entropy = await snap.request({ method: 'snap_getEntropy', params: { version: 1, salt: ENTROPY_SALT } });
  const account = accountFromEntropy(entropy);
  try {
    return await fn(account);
  } finally {
    account.secretKey.fill(0);
  }
}

async function signTx(origin, params) {
  let req;
  try {
    req = parseSignRequest(params);
  } catch (e) {
    throw new InvalidParamsError(e.message);
  }
  return withAccount(async (account) => {
    const me = account.address;
    // Built once, before the dialog: the dialog shows these messages and these are signed.
    let messages;
    let view;
    try {
      messages = req.intents.map((i) => messageFromIntent(i, me.bech32));
      view = describeTx({ origin, signer: me, req, messages, lang: req.lang });
    } catch (e) {
      throw new InvalidParamsError(e.message);
    }
    const approved = await snap.request({
      method: 'snap_dialog',
      params: { type: 'confirmation', content: <Confirmation view={view} /> },
    });
    if (approved !== true) throw new UserRejectedRequestError('Rejected in the ZETAPHY snap: nothing was signed.');
    let signature;
    const tx = buildTx({
      publicKey: account.publicKey,
      sign: (signDoc) => (signature = ml_dsa44.sign(signDoc, account.secretKey)),
      messages, chainId: req.chainId, accountNumber: req.accountNumber, sequence: req.sequence,
      gasLimit: req.gasLimit, gasPrice: req.gasPrice, memo: req.memo,
    });
    return {
      signature: '0x' + bytesToHex(signature),
      txHex: tx.txHex,
      txHash: tx.txHash,
      bodyBytes: '0x' + bytesToHex(tx.bodyBytes),
      authInfoBytes: '0x' + bytesToHex(tx.authInfoBytes),
    };
  });
}

async function changeThreatSource(origin, params) {
  if (!WALLET_ORIGINS.includes(origin)) throw new UnauthorizedError('Only the ZETAPHY wallet may change the threat source.');
  let source;
  try {
    source = parseThreatSource(params);
  } catch (e) {
    throw new InvalidParamsError(e.message);
  }
  const shown = source ?? { rpc: 'built-in', registry: 'built-in' };
  const approved = await snap.request({
    method: 'snap_dialog',
    params: {
      type: 'confirmation',
      content: (
        <Box>
          <Heading>ZETAPHY Neuro</Heading>
          <Text>{origin} ขอเปลี่ยนแหล่งตรวจภัย (ThreatRegistry) ที่ใช้ตรวจทุกธุรกรรม / asks to change where every transaction is checked</Text>
          <Row label="RPC"><Text>{shown.rpc}</Text></Row>
          <Row label="ThreatRegistry"><Text>{shown.registry}</Text></Row>
        </Box>
      ),
    },
  });
  if (approved !== true) throw new UserRejectedRequestError('Rejected in the ZETAPHY snap: the threat source was not changed.');
  await setThreatSource(source);
  return threatSource();
}

export const onTransaction = async ({ transaction, chainId }) => {
  let result;
  try {
    result = await checkTransaction({ transaction, chainId }, await threatSource());
  } catch (e) {
    result = { state: 'unchecked', findings: [], error: e?.message ?? String(e) };
  }
  return insight(result);
};

export const onRpcRequest = async ({ origin, request }) => {
  switch (request.method) {
    case 'zetaphy_getAccount':
      return withAccount(async (account) => publicAccount(account));
    case 'zetaphy_signTx':
      return signTx(origin, request.params);
    case 'zetaphy_getThreatSource':
      return threatSource();
    case 'zetaphy_setThreatSource':
      return changeThreatSource(origin, request.params);
    default:
      throw new MethodNotFoundError({ method: request.method });
  }
};
