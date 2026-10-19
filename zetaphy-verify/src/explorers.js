// Explorer clients. Each one exposes the same three calls:
//   isVerified(chainId, address)        -> boolean
//   submit({chainId, address, contract, txHash, constructorArgs}) -> job
//   wait(job)                           -> {ok, status, detail}
//
// Sourcify is free on every chain. Etherscan API V2 covers etherscan.io,
// bscscan.com, basescan.org, arbiscan.io... with one key, but its free tier
// leaves some chains out (BNB Chain and Base at the time of writing); those
// come back as status 'plan-required' instead of a failure.

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

export function sourcify({ fetchImpl = globalThis.fetch, base = 'https://sourcify.dev/server', sleep = sleepMs, polls = 40 } = {}) {
  const json = async (res) => { try { return await res.json(); } catch { return {}; } };
  return {
    name: 'sourcify',
    async isVerified(chainId, address) {
      const res = await fetchImpl(`${base}/v2/contract/${chainId}/${address}`);
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`sourcify lookup: HTTP ${res.status}`);
      const body = await json(res);
      return !!(body.match || body.runtimeMatch || body.creationMatch);
    },
    async submit({ chainId, address, contract, txHash }) {
      const res = await fetchImpl(`${base}/v2/verify/${chainId}/${address}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          stdJsonInput: contract.input,
          compilerVersion: contract.longVersion,
          contractIdentifier: contract.fqn,
          ...(txHash ? { creationTransactionHash: txHash } : {}),
        }),
      });
      const body = await json(res);
      if (res.status === 409) return { done: { ok: true, status: 'already-verified' } };
      if (!res.ok) return { done: { ok: false, status: 'rejected', detail: body.message ?? `HTTP ${res.status}` } };
      return { id: body.verificationId };
    },
    async wait(job) {
      if (job.done) return job.done;
      for (let i = 0; i < polls; i++) {
        await sleep(3000);
        const res = await fetchImpl(`${base}/v2/verify/${job.id}`);
        const body = await json(res);
        if (!body.isJobCompleted) continue;
        if (body.error) return { ok: false, status: 'failed', detail: body.error.message ?? body.error.customCode };
        const match = body.contract?.match ?? body.contract?.runtimeMatch;
        return match ? { ok: true, status: 'verified', detail: match } : { ok: false, status: 'failed', detail: 'no match' };
      }
      return { ok: false, status: 'timeout', detail: `job ${job.id}` };
    },
  };
}

const PLAN_RE = /not (supported|available).*(free|plan)|upgrade.*plan|free (api )?(tier|access)/i;

export function etherscan({ apiKey, fetchImpl = globalThis.fetch, base = 'https://api.etherscan.io/v2/api', sleep = sleepMs, polls = 40, gapMs = 400 } = {}) {
  if (!apiKey) return null;
  let last = 0;
  // Free keys allow a few calls per second: keep a gap between calls.
  async function call(chainId, params, form) {
    const wait = last + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const q = new URLSearchParams({ chainid: String(chainId), ...(form ? {} : params), apikey: apiKey });
    const res = await fetchImpl(`${base}?${q}`, form
      ? { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) }
      : {});
    if (!res.ok) throw new Error(`etherscan ${params.action}: HTTP ${res.status}`);
    return res.json();
  }
  const planError = (body) => {
    const text = `${body.message ?? ''} ${typeof body.result === 'string' ? body.result : ''}`;
    return PLAN_RE.test(text) ? text.trim() : null;
  };

  return {
    name: 'etherscan',
    async isVerified(chainId, address) {
      const body = await call(chainId, { module: 'contract', action: 'getsourcecode', address });
      const plan = planError(body);
      if (plan) { const e = new Error(plan); e.planRequired = true; throw e; }
      return Array.isArray(body.result) && !!body.result[0]?.SourceCode;
    },
    /** Creation code as the explorer recorded it (holds the constructor arguments). */
    async creation(chainId, address) {
      const body = await call(chainId, { module: 'contract', action: 'getcontractcreation', contractaddresses: address });
      const r = Array.isArray(body.result) ? body.result[0] : null;
      return r ? { txHash: r.txHash, creationBytecode: r.creationBytecode ?? null } : null;
    },
    async submit({ chainId, address, contract, constructorArgs }) {
      const body = await call(chainId, {
        module: 'contract',
        action: 'verifysourcecode',
        codeformat: 'solidity-standard-json-input',
        sourceCode: JSON.stringify(contract.input),
        contractaddress: address,
        contractname: contract.fqn,
        compilerversion: `v${contract.longVersion}`,
        constructorArguements: constructorArgs ?? '', // sic: the API's spelling
      }, true);
      const plan = planError(body);
      if (plan) return { done: { ok: false, status: 'plan-required', detail: plan } };
      if (body.status === '1') return { guid: body.result, chainId };
      if (/already verified/i.test(body.result ?? '')) return { done: { ok: true, status: 'already-verified' } };
      return { done: { ok: false, status: 'rejected', detail: body.result ?? body.message } };
    },
    async wait(job) {
      if (job.done) return job.done;
      for (let i = 0; i < polls; i++) {
        await sleep(3000);
        const body = await call(job.chainId, { module: 'contract', action: 'checkverifystatus', guid: job.guid });
        const r = String(body.result ?? '');
        if (/pending|queue/i.test(r)) continue;
        if (/^pass|already verified/i.test(r)) return { ok: true, status: 'verified', detail: r };
        return { ok: false, status: 'failed', detail: r };
      }
      return { ok: false, status: 'timeout', detail: `guid ${job.guid}` };
    },
  };
}
