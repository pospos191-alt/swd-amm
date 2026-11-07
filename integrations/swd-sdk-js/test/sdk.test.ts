import { describe, expect, it } from "vitest";
import { generateKeyPairSync, createHash, randomBytes, sign } from "node:crypto";
import { canonical, createSwdClient, solAmountString, SwdApiError, verifyAttestation, SWD_MINT } from "../src/index";

type Call = { url: string; init?: RequestInit };
function mockFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input);
    calls.push({ url: u, init });
    return handler(new URL(u), init);
  }) as typeof fetch;
  return { f, calls };
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const BASE = "https://example.test";

describe("audit", () => {
  it("calls /api/audit with chain, address, lang and drops the full report", async () => {
    const { f, calls } = mockFetch(() => json({ ok: true, audit: { chain: "sol", address: SWD_MINT, level: "low", report: { big: 1 }, permalink: "p" } }));
    const swd = createSwdClient({ baseUrl: BASE + "/", fetch: f });
    const a = await swd.audit("sol", SWD_MINT, { lang: "th" });
    const u = new URL(calls[0].url);
    expect(u.origin + u.pathname).toBe(`${BASE}/api/audit`);
    expect(u.searchParams.get("chain")).toBe("sol");
    expect(u.searchParams.get("address")).toBe(SWD_MINT);
    expect(u.searchParams.get("lang")).toBe("th");
    expect(a.level).toBe("low");
    expect(a.report).toBeUndefined();
  });
  it("keeps the report with full: true", async () => {
    const { f } = mockFetch(() => json({ ok: true, audit: { level: "high", report: { big: 1 } } }));
    expect((await createSwdClient({ baseUrl: BASE, fetch: f }).audit("eth", "0xabc", { full: true })).report).toEqual({ big: 1 });
  });
  it("turns { ok: false } into SwdApiError with the API's code", async () => {
    const { f } = mockFetch(() => json({ ok: false, code: "bad_chain", error: "chain must be one of" }, 400));
    const err = await createSwdClient({ baseUrl: BASE, fetch: f }).audit("nope", "x").catch((e) => e);
    expect(err).toBeInstanceOf(SwdApiError);
    expect(err.code).toBe("bad_chain");
    expect(err.status).toBe(400);
  });
  it("auditTx uses /api/audit/tx?hash=", async () => {
    const { f, calls } = mockFetch(() => json({ ok: true, tx: { found: true, level: "info", overall: "medium" } }));
    const t = await createSwdClient({ baseUrl: BASE, fetch: f }).auditTx("sol", "5sig");
    expect(new URL(calls[0].url).pathname).toBe("/api/audit/tx");
    expect(new URL(calls[0].url).searchParams.get("hash")).toBe("5sig");
    expect(t.overall).toBe("medium");
  });
  it("builds badge and permalink URLs", () => {
    const swd = createSwdClient({ baseUrl: BASE, fetch: (() => {}) as unknown as typeof fetch });
    expect(swd.badgeUrl("sol", SWD_MINT)).toBe(`${BASE}/api/audit/badge?chain=sol&address=${SWD_MINT}`);
    expect(swd.permalink("osmosis", "factory/osmo1x/name")).toBe(`${BASE}/audit/osmosis/factory/osmo1x/name`);
  });
});

describe("supply", () => {
  it("reads both plain-text numbers", async () => {
    const { f } = mockFetch((u) => new Response(u.pathname.endsWith("total") ? "1000000000\n" : "750000000.5", { status: 200 }));
    expect(await createSwdClient({ baseUrl: BASE, fetch: f }).supply()).toEqual({ total: "1000000000", circulating: "750000000.5" });
  });
  it("fails on 503 unavailable", async () => {
    const { f } = mockFetch(() => new Response("unavailable", { status: 503 }));
    await expect(createSwdClient({ baseUrl: BASE, fetch: f }).supply()).rejects.toBeInstanceOf(SwdApiError);
  });
});

describe("buySwdTransaction", () => {
  const account = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  it("POSTs { account } with ?amount= and decodes the transaction", async () => {
    const { f, calls } = mockFetch(() => json({ type: "transaction", transaction: "AQID", message: "0.1 SOL → ~123 SWD" }));
    const r = await createSwdClient({ baseUrl: BASE, fetch: f }).buySwdTransaction({ account, amountSol: 0.1, slippageBps: 100 });
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe("/api/actions/buy-swd");
    expect(u.searchParams.get("amount")).toBe("0.1");
    expect(u.searchParams.get("slippageBps")).toBe("100");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ account });
    expect(Array.from(r.bytes)).toEqual([1, 2, 3]);
    expect(r.message).toContain("SWD");
  });
  it("refuses bad input before any request", async () => {
    const { f, calls } = mockFetch(() => json({}));
    const swd = createSwdClient({ baseUrl: BASE, fetch: f });
    await expect(swd.buySwdTransaction({ account: "not-an-address", amountSol: 0.1 })).rejects.toMatchObject({ code: "bad_input" });
    await expect(swd.buySwdTransaction({ account, amountSol: 51 })).rejects.toMatchObject({ code: "bad_input" });
    await expect(swd.buySwdTransaction({ account, amountSol: "0.0001" })).rejects.toMatchObject({ code: "bad_input" });
    await expect(swd.buySwdTransaction({ account, amountSol: 1, slippageBps: 5000 })).rejects.toMatchObject({ code: "bad_input" });
    expect(calls).toHaveLength(0);
  });
  it("passes the Action's error message through", async () => {
    const { f } = mockFetch(() => json({ message: "no route right now" }, 422));
    await expect(createSwdClient({ baseUrl: BASE, fetch: f }).buySwdTransaction({ account, amountSol: "0.05" })).rejects.toThrow("no route right now");
  });
  it("solAmountString normalizes numbers", () => {
    expect(solAmountString(0.05)).toBe("0.05");
    expect(solAmountString(1)).toBe("1");
    expect(() => solAmountString(NaN)).toThrow();
  });
});

describe("MCP tools", () => {
  it("sends tools/call and returns structuredContent", async () => {
    const { f, calls } = mockFetch(() => json({ jsonrpc: "2.0", id: 1, result: { structuredContent: { mint: SWD_MINT } } }));
    const r = await createSwdClient({ baseUrl: BASE, fetch: f }).info();
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("swd_info");
    expect(r.mint).toBe(SWD_MINT);
  });
  it("throws on a tool error", async () => {
    const { f } = mockFetch(() => json({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "bad mint" }] } }));
    await expect(createSwdClient({ baseUrl: BASE, fetch: f }).tokenInfo("sol", "x")).rejects.toMatchObject({ code: "tool_error" });
  });
});

describe("canonical JSON", () => {
  it("sorts keys, escapes non-ASCII, drops undefined", () => {
    expect(canonical({ b: 1, a: "ไทย", c: undefined, d: [null, true] })).toBe('{"a":"\\u0e44\\u0e17\\u0e22","b":1,"d":[null,true]}');
    expect(() => canonical({ x: 1.5 })).toThrow();
  });
});

// A real Ed25519 signature (node:crypto) and a placeholder ML-DSA key/signature, checked with a stand-in verifier.
function makeAttestation() {
  const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const edPub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const mlPub = randomBytes(1312);
  const mlSig = randomBytes(2420);
  const payload = {
    kind: "contract",
    chain: "sol",
    subject: SWD_MINT,
    reader: "neuro",
    engine: "neuro@test report-v1 verdict-v1",
    reportHash: "0x" + "ab".repeat(32),
    verdict: "0x" + "cd".repeat(32),
    level: "low",
    observedAt: "2026-11-07T00:00:00.000Z",
    site: "https://swd-zetaphy.sawasdeecoin.com",
    url: `https://swd-zetaphy.sawasdeecoin.com/audit/sol/${SWD_MINT}`,
  };
  const payloadHash = "0x" + sha(canonical(payload)).toString("hex");
  const mlId = "mldsa44-" + sha(mlPub).toString("hex").slice(0, 16);
  const edId = "ed25519-" + sha(edPub).toString("hex").slice(0, 16);
  const msg = Buffer.from(`swd.audit-attestation.v1\n${payloadHash}\nml-dsa-44:${mlId}\ned25519:${edId}`);
  const att = {
    format: "swd.audit-attestation.v1",
    payload,
    payloadHash,
    id: "0x" + sha(msg).toString("hex"),
    sigs: {
      mldsa44: { keyId: mlId, publicKey: mlPub.toString("base64"), sig: mlSig.toString("base64") },
      ed25519: { keyId: edId, publicKey: edPub.toString("base64"), sig: sign(null, msg, privateKey).toString("base64") },
    },
  };
  const keys = [
    { alg: "ML-DSA-44" as const, keyId: mlId, publicKey: mlPub.toString("base64"), status: "current" as const },
    { alg: "Ed25519" as const, keyId: edId, publicKey: edPub.toString("base64"), status: "current" as const },
  ];
  return { att, keys, mlSig };
}

describe("verifyAttestation", () => {
  it("checks hashes, ids and Ed25519; stays incomplete without an ML-DSA verifier", async () => {
    const { att } = makeAttestation();
    const r = await verifyAttestation(att);
    expect(r.problems).toEqual([]);
    expect(r.ed25519).toBe(true);
    expect(r.mldsa44).toBeNull();
    expect(r.complete).toBe(false);
    expect(r.ok).toBe(false);
  });
  it("is ok and trusted with an ML-DSA verifier and the published keys", async () => {
    const { att, keys, mlSig } = makeAttestation();
    const r = await verifyAttestation(JSON.stringify(att), { keys, mldsaVerify: (_pk, _m, sig) => Buffer.from(sig).equals(mlSig) });
    expect(r.ok).toBe(true);
    expect(r.complete).toBe(true);
    expect(r.signer).toBe("current");
    expect(r.trusted).toBe(true);
  });
  it("catches a changed payload", async () => {
    const { att } = makeAttestation();
    att.payload.level = "info";
    const r = await verifyAttestation(att, { mldsaVerify: () => true });
    expect(r.ok).toBe(false);
    expect(r.problems).toContain("payload_hash");
  });
  it("catches a forged Ed25519 signature and an unknown signer", async () => {
    const { att } = makeAttestation();
    const other = makeAttestation();
    att.sigs.ed25519.sig = other.att.sigs.ed25519.sig;
    const r = await verifyAttestation(att, { keys: other.keys, mldsaVerify: () => true });
    expect(r.problems).toContain("ed25519_sig");
    expect(r.problems).toContain("key_unknown");
    expect(r.trusted).toBe(false);
  });
  it("never throws on junk", async () => {
    expect((await verifyAttestation("{not json")).problems).toEqual(["not_json"]);
    expect((await verifyAttestation(null)).ok).toBe(false);
  });
});
