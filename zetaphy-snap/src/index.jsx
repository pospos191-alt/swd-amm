// ZETAPHY MetaMask Snap: a post-quantum ML-DSA-44 account derived from the
// MetaMask Secret Recovery Phrase (snap_getEntropy), for the ZETAPHY chain.
//
//   zetaphy_getAccount  -> { publicKey, address (zetaphy1…), hex (0x…) }
//   zetaphy_signTx      -> builds the tx from structured messages (intents) with pqtx.js,
//                          shows it in plain words (snap_dialog), and only if the user
//                          approves returns { signature, txHex, txHash, bodyBytes, authInfoBytes }
//
// The seed and the secret key are made for each request, used, wiped, and never
// returned, stored or sent anywhere. No network access: the dapp broadcasts the tx.
import { InvalidParamsError, MethodNotFoundError, UserRejectedRequestError } from '@metamask/snaps-sdk';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { accountFromEntropy, publicAccount, ENTROPY_SALT } from './account.js';
import { describeTx } from './describe.js';
import { Confirmation } from './dialog.jsx';
import { buildTx, bytesToHex, messageFromIntent } from './pqtx.js';
import { parseSignRequest } from './request.js';

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

export const onRpcRequest = async ({ origin, request }) => {
  switch (request.method) {
    case 'zetaphy_getAccount':
      return withAccount(async (account) => publicAccount(account));
    case 'zetaphy_signTx':
      return signTx(origin, request.params);
    default:
      throw new MethodNotFoundError({ method: request.method });
  }
};
