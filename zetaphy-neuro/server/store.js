// Which store the counter and the rate limiter use, from the environment:
//   1. Cloudflare D1, when NEURO_D1_ACCOUNT_ID, NEURO_D1_DATABASE_ID and NEURO_D1_TOKEN are set;
//   2. otherwise Upstash Redis (KV_REST_API_URL + KV_REST_API_TOKEN from Vercel's integration);
//   3. otherwise none: the counter is off, the rate limiter keeps counts in memory.
// If the store fails, the page still works: /api/usage answers 503 (the numbers are
// hidden) and the early-warning limiter falls back to memory.
import { d1Store } from './d1store.js';
import { upstashStore } from './usage.js';

export function storeFromEnv(env = process.env) {
  return d1Store(env.NEURO_D1_ACCOUNT_ID, env.NEURO_D1_DATABASE_ID, env.NEURO_D1_TOKEN)
    ?? upstashStore(env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL, env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN);
}
