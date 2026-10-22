// ZetaphyOracle from JavaScript: Pyth's update format (what ZetaphyPythRelay takes), Hermes
// (Pyth's free public price service) to that format, and the oracle's problem codes.

import { AbiCoder, getAddress, isHexString } from 'ethers';

const coder = AbiCoder.defaultAbiCoder();
const PRICE = 'tuple(int64 price, uint64 conf, int32 expo, uint256 publishTime)';
const FEED = `tuple(bytes32 id, ${PRICE} price, ${PRICE} emaPrice)`;

/** ZetaphyOracle.Problem, by its uint8 value. */
export const PROBLEMS = ['None', 'NotConfigured', 'TwapUnavailable', 'TwapStale', 'TooFewObservations', 'LowLiquidity', 'TwapSpike',
  'PythUnavailable', 'PythStale', 'PythInvalid', 'PythConfidence', 'SourcesDeviate'];

/**
 * One Pyth price update: abi.encode(PythStructs.PriceFeed, uint64 prevPublishTime), the format of
 * Pyth's MockPyth.createPriceFeedUpdateData (pyth-sdk-solidity), which ZetaphyPythRelay takes.
 */
export function encodePriceFeed({ id, price, conf, expo, publishTime, emaPrice = price, emaConf = conf, prevPublishTime = null }) {
  if (!isHexString(id, 32)) throw new Error('feed id: 0x + 64 hex');
  const t = BigInt(publishTime);
  return coder.encode([FEED, 'uint64'], [[id, [BigInt(price), BigInt(conf), Number(expo), t], [BigInt(emaPrice), BigInt(emaConf), Number(expo), t]], prevPublishTime == null ? (t > 0n ? t - 1n : 0n) : BigInt(prevPublishTime)]);
}

export function decodePriceFeed(data) {
  const [f, prev] = coder.decode([FEED, 'uint64'], data);
  return { id: f.id, price: f.price.price, conf: f.price.conf, expo: Number(f.price.expo), publishTime: f.price.publishTime, prevPublishTime: prev };
}

/** Hermes' JSON (GET /v2/updates/price/latest?ids[]=…&parsed=true) to update data, one per parsed feed. */
export function fromHermes(json) {
  const parsed = json?.parsed;
  if (!Array.isArray(parsed) || !parsed.length) throw new Error('Hermes answered no parsed prices');
  return parsed.map((p) => {
    const id = `0x${String(p.id).replace(/^0x/, '')}`;
    const ok = (x) => x && /^-?\d+$/.test(String(x.price)) && /^\d+$/.test(String(x.conf)) && Number.isInteger(Number(x.expo)) && Number.isInteger(Number(x.publish_time));
    if (!ok(p.price) || !ok(p.ema_price)) throw new Error(`Hermes: a malformed price for ${id}`);
    return encodePriceFeed({ id, price: p.price.price, conf: p.price.conf, expo: p.price.expo, publishTime: p.price.publish_time,
      emaPrice: p.ema_price.price, emaConf: p.ema_price.conf, prevPublishTime: p.metadata?.prev_publish_time ?? null });
  });
}

/** The Hermes URL for these feed ids (Pyth's public, free endpoint by default). */
export function hermesUrl(ids, base = 'https://hermes.pyth.network') {
  const u = new URL('/v2/updates/price/latest', base);
  if (u.protocol !== 'https:') throw new Error('--hermes must be https://');
  for (const id of ids) {
    if (!isHexString(id, 32)) throw new Error(`feed id ${id}: 0x + 64 hex`);
    u.searchParams.append('ids[]', id);
  }
  u.searchParams.set('parsed', 'true');
  return u.href;
}

/** A USD amount (18 decimals) for people. */
export const usd = (v) => {
  const x = BigInt(v);
  const whole = x / 10n ** 18n;
  const frac = String(x % 10n ** 18n).padStart(18, '0').slice(0, 6).replace(/0+$/, '');
  return `$${whole}${frac ? `.${frac}` : ''}`;
};

export const asAddress = (a) => getAddress(String(a));
