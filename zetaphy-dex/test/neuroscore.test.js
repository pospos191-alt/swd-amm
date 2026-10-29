// The router's optional NeuroScore check: OFF by default, set only by governance
// (factory.setNeuroScore), refuses buys (swaps INTO a token) whose current score
// under the active model is >= the threshold; selling, liquidity, unscored tokens
// and tokens scored only under an older model go through. Uses the real
// NeuroScore (zetaphy-network/artifacts) with Neuro's exported model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Interface, encodeBytes32String } from 'ethers';
import { setupDex, art, ONE } from './helpers/dex.js';
import { evalFixed, fromHex, quantizeVector, packFeatures, probabilityToScore } from '../../zetaphy-neuro/ml/onchain/fixed.js';

const ML = new URL('../../zetaphy-neuro/ml/onchain/', import.meta.url);
const FIXED = JSON.parse(readFileSync(new URL('model.fixed.json', ML), 'utf8'));
const HELD = JSON.parse(readFileSync(new URL('heldout.json', ML), 'utf8'));
const BYTES = fromHex(FIXED.bytes);
const ZERO = '0x' + '00'.repeat(20);
const MAX = 2n ** 256n - 1n;
const vecOf = (row) => { const v = new Array(FIXED.features.length).fill(0); for (const [i, x] of row.x) v[i] = x; return v; };
const scored = (row) => { const q = quantizeVector(vecOf(row)); return { feats: packFeatures(q), score: evalFixed(BYTES, q).score }; };

async function setup() {
  const d = await setupDex(['feeder']);
  const { c, addr, router, A, B, C, deadline } = d;
  // In production NeuroScore's governance is the ZetaphyTimelock (zetaphy-network/test/neuroscore.test.js);
  // here 'gov' stands in for it.
  const ns = await c.deployRaw(art('NeuroScore'), [addr('gov')], 'gov');
  await ns.send('carol', 'publishModel', [FIXED.bytes]);
  await ns.send('gov', 'activateModel', [FIXED.hash, encodeBytes32String(FIXED.modelId), FIXED.levels.low, FIXED.levels.medium, FIXED.levels.high]);
  await ns.send('gov', 'setFeeder', [addr('feeder'), true]);
  // B gets a held-out scam row's features (high score), C a benign row's (low score); A is never scored.
  const hi = HELD.rows.map(scored).filter((r) => r.score >= FIXED.levels.high)[0];
  const lo = HELD.rows.map(scored).filter((r) => r.score < FIXED.levels.low)[0];
  await ns.send('feeder', 'postFeatures', [B.address, hi.feats]);
  await ns.send('feeder', 'postFeatures', [C.address, lo.feats]);
  await router.send('alice', 'addLiquidity', [A.address, B.address, 1000n * ONE, 1000n * ONE, 0, 0, addr('alice'), deadline()]);
  await router.send('alice', 'addLiquidity', [A.address, C.address, 1000n * ONE, 1000n * ONE, 0, 0, addr('alice'), deadline()]);
  await router.send('alice', 'addLiquidity', [B.address, C.address, 1000n * ONE, 1000n * ONE, 0, 0, addr('alice'), deadline()]);
  await router.send('alice', 'addLiquidityETH', [B.address, 1000n * ONE, 0, 0, addr('alice'), deadline()], 100n * ONE);
  return { ...d, ns, hi, lo, W: d.weth.address };
}

test('off by default; only governance sets it; an address that does not answer scoreOf is refused; zero switches it off', async () => {
  const { factory, router, ns, A, B, addr, deadline } = await setup();
  assert.equal(await factory.call('neuroScore'), ZERO, 'off by default');
  assert.equal(await factory.call('scoreThreshold'), 0n);
  // off: a high-score token can be bought
  await router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [A.address, B.address], addr('bob'), deadline()]);
  await assert.rejects(factory.send('alice', 'setNeuroScore', [ns.address, FIXED.levels.medium]), /NotGovernance/);
  await assert.rejects(factory.send('gov', 'setNeuroScore', [addr('bob'), FIXED.levels.medium]), /NotAScorer/);
  await assert.rejects(factory.send('gov', 'setNeuroScore', [A.address, FIXED.levels.medium]), /NotAScorer/);
  const ev = await factory.send('gov', 'setNeuroScore', [ns.address, FIXED.levels.medium]);
  assert.ok(ev.some((e) => e?.name === 'NeuroScoreSet'));
  assert.equal((await factory.call('neuroScore')).toLowerCase(), ns.address.toLowerCase());
  assert.equal(await factory.call('scoreThreshold'), BigInt(FIXED.levels.medium));
  const [, s, t] = await factory.call('buyChecks');
  assert.equal(s.toLowerCase(), ns.address.toLowerCase());
  assert.equal(t, BigInt(FIXED.levels.medium));
  await factory.send('gov', 'setNeuroScore', [ZERO, 0]);
  assert.equal(await factory.call('neuroScore'), ZERO);
  await router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [A.address, B.address], addr('bob'), deadline()]);
});

test('on: buys of a token scored >= threshold are refused (every swap kind, multi-hop too); selling, liquidity, low-score and unscored tokens work', async () => {
  const { factory, router, ns, A, B, C, W, addr, deadline, hi, pairAt } = await setup();
  await factory.send('gov', 'setNeuroScore', [ns.address, probabilityToScore(0.8)]);
  const refused = /TokenScoreTooHigh/;
  await assert.rejects(router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [A.address, B.address], addr('bob'), deadline()]), refused);
  await assert.rejects(router.send('bob', 'swapTokensForExactTokens', [ONE, MAX, [A.address, B.address], addr('bob'), deadline()]), refused);
  await assert.rejects(router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [A.address, B.address, C.address], addr('bob'), deadline()]), refused, 'through it');
  await assert.rejects(router.send('bob', 'swapExactETHForTokens', [0, [W, B.address], addr('bob'), deadline()], ONE), refused);
  await assert.rejects(router.send('bob', 'swapETHForExactTokens', [ONE, [W, B.address], addr('bob'), deadline()], 10n * ONE), refused);
  await assert.rejects(router.send('bob', 'swapExactTokensForTokensSupportingFeeOnTransferTokens', [ONE, 0, [A.address, B.address], addr('bob'), deadline()]), refused);
  await assert.rejects(router.send('bob', 'swapExactETHForTokensSupportingFeeOnTransferTokens', [0, [W, B.address], addr('bob'), deadline()], ONE), refused);
  // the error names the token and its score
  const err = await router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [A.address, B.address], addr('bob'), deadline()]).catch((e) => e);
  const parsed = new Interface(art('ZetaphyRouter').abi).parseError(err.data);
  assert.equal(parsed.name, 'TokenScoreTooHigh');
  assert.equal(parsed.args[0].toLowerCase(), B.address.toLowerCase());
  assert.equal(parsed.args[1], BigInt(hi.score));
  // low score (C) and never scored (A): bought normally
  await router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [A.address, C.address], addr('bob'), deadline()]);
  await router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [C.address, A.address], addr('bob'), deadline()]);
  // holders are never locked in: selling B, and liquidity, do not ask the scorer
  await router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [B.address, A.address], addr('bob'), deadline()]);
  await router.send('bob', 'swapExactTokensForETH', [ONE, 0, [B.address, W], addr('bob'), deadline()]);
  await router.send('bob', 'addLiquidity', [A.address, B.address, ONE, ONE, 0, 0, addr('bob'), deadline()]);
  const pair = pairAt(await factory.call('getPair', [A.address, B.address]));
  await pair.send('alice', 'approve', [router.address, MAX]);
  await router.send('alice', 'removeLiquidity', [A.address, B.address, ONE, 0, 0, addr('alice'), deadline()]);
  // a threshold above B's score lets it through
  await factory.send('gov', 'setNeuroScore', [ns.address, BigInt(hi.score) + 1n]);
  await router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [A.address, B.address], addr('bob'), deadline()]);
});

test('a model change: scores from the old model read unknown (not refused) until rescored', async () => {
  const { factory, router, ns, A, B, addr, deadline, hi } = await setup();
  await factory.send('gov', 'setNeuroScore', [ns.address, probabilityToScore(0.8)]);
  await assert.rejects(router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [A.address, B.address], addr('bob'), deadline()]), /TokenScoreTooHigh/);
  await ns.send('gov', 'activateModel', [FIXED.hash, encodeBytes32String('v2'), FIXED.levels.low, FIXED.levels.medium, FIXED.levels.high]);
  await router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [A.address, B.address], addr('bob'), deadline()]);
  await ns.send('bob', 'rescore', [B.address, hi.feats]);
  await assert.rejects(router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [A.address, B.address], addr('bob'), deadline()]), /TokenScoreTooHigh/);
});

test('fails closed: a scorer that needs more than SCORE_GAS stops buys (not sells); zero lifts it; gas of the check', async () => {
  const { c, factory, router, A, B, W, addr, deadline } = await setup();
  assert.equal(await router.call('SCORE_GAS'), 50_000n);
  assert.equal(await factory.call('SCORE_GAS'), 50_000n);
  const hog = await c.deployRaw(art('GasHogScorer'), [], 'gov');
  await hog.send('gov', 'set', [80_000n, false, 0n]);
  await assert.rejects(factory.send('gov', 'setNeuroScore', [hog.address, 0]), /NotAScorer/, 'too slow when set');
  await hog.send('gov', 'set', [0n, false, 0n]);
  await factory.send('gov', 'setNeuroScore', [hog.address, 0]);
  await router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [A.address, B.address], addr('bob'), deadline()]);
  await hog.send('gov', 'set', [80_000n, false, 0n]);
  await assert.rejects(router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [A.address, B.address], addr('bob'), deadline()]), /ScoreUnavailable/);
  await router.send('bob', 'swapExactTokensForETH', [ONE, 0, [B.address, W], addr('bob'), deadline()]);
  await factory.send('gov', 'setNeuroScore', [ZERO, 0]);
  await router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [A.address, B.address], addr('bob'), deadline()]);
  // known score at exactly the threshold is refused (>=)
  await hog.send('gov', 'set', [0n, true, 5n]);
  await factory.send('gov', 'setNeuroScore', [hog.address, 5]);
  await assert.rejects(router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [A.address, B.address], addr('bob'), deadline()]), /TokenScoreTooHigh/);
  await factory.send('gov', 'setNeuroScore', [hog.address, 6]);
  await router.send('bob', 'swapExactTokensForTokens', [ONE, 0, [A.address, B.address], addr('bob'), deadline()]);
});

test('gas: the check adds little to a swap when off, and one stored-score read per bought token when on', async () => {
  const { c, factory, router, ns, A, C, addr, deadline } = await setup();
  const args = () => [ONE, 0, [A.address, C.address], addr('bob'), deadline()];
  await router.send('bob', 'swapExactTokensForTokens', args()); // first swap writes bob's balance 0 -> x: not measured
  const off = (await router.gas('bob', 'swapExactTokensForTokens', args())).exec;
  await factory.send('gov', 'setNeuroScore', [ns.address, probabilityToScore(0.8)]);
  const on = (await router.gas('bob', 'swapExactTokensForTokens', args())).exec;
  console.log(`swapExactTokensForTokens execution gas: check off ${off}, on (scored token, allowed) ${on} (+${on - off})`);
  assert.ok(on - off < 20_000, `${on - off}`);
  assert.ok(c);
});

test('cli set-neuro-score: --min-p becomes the same fixed threshold as Neuro\'s exporter; junk refused', async () => {
  const { scoreThresholdOf } = await import('../cli.js');
  for (const p of [0.5, 0.8, 0.95, 0.01]) assert.equal(scoreThresholdOf(p), BigInt(probabilityToScore(p)));
  assert.equal(scoreThresholdOf('0.8'), BigInt(FIXED.levels.medium));
  for (const bad of ['0', '1', 'x', '-0.2', '1.5']) assert.throws(() => scoreThresholdOf(bad), /--min-p/);
});
