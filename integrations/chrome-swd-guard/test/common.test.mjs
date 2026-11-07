import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const G = createRequire(import.meta.url)("../src/common.js");

const MINT = "Cmh2tu6bt5z2a8NKsx6G5WfVmaeQ9f2fcX5VnQbVaGLL";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const SOL_SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";

test("detects the token on supported sites", () => {
  const cases = [
    [`https://solscan.io/token/${MINT}`, { chain: "sol", address: MINT }],
    [`https://solscan.io/token/${MINT}?cluster=mainnet#holders`, { chain: "sol", address: MINT }],
    [`https://jup.ag/tokens/${MINT}`, { chain: "sol", address: MINT }],
    [`https://jup.ag/swap/SOL-${MINT}`, { chain: "sol", address: MINT }],
    [`https://jup.ag/swap?sell=So11111111111111111111111111111111111111112&buy=${MINT}`, { chain: "sol", address: MINT }],
    [`https://birdeye.so/token/${MINT}?chain=solana`, { chain: "sol", address: MINT }],
    [`https://birdeye.so/token/${USDT}?chain=ethereum`, { chain: "eth", address: USDT.toLowerCase() }],
    [`https://birdeye.so/bsc/token/${USDT}`, { chain: "bsc", address: USDT.toLowerCase() }],
    [`https://pump.fun/coin/${MINT}`, { chain: "sol", address: MINT }],
    [`https://pump.fun/${MINT}`, { chain: "sol", address: MINT }],
  ];
  for (const [url, want] of cases) assert.deepEqual(G.detectToken(url), want, url);
});

test("ignores pages that are not about one token", () => {
  for (const url of ["https://solscan.io/", `https://solscan.io/account/${MINT}x`, "https://jup.ag/swap", "https://pump.fun/board", "https://birdeye.so/token/notanaddress?chain=solana", `https://birdeye.so/token/${MINT}?chain=sui`, "https://evil.example/token/" + MINT, "not a url"])
    assert.equal(G.detectToken(url), null, url);
});

test("DEX Screener: chain from the URL, token from explorer links", () => {
  assert.equal(G.dexscreenerChain("https://dexscreener.com/solana/abc"), "sol");
  assert.equal(G.dexscreenerChain("https://dexscreener.com/base/0xpair"), "base");
  assert.equal(G.dexscreenerChain("https://dexscreener.com/"), null);
  assert.deepEqual(G.tokenFromExplorerLink(`https://solscan.io/token/${MINT}`), { chain: "sol", address: MINT });
  assert.deepEqual(G.tokenFromExplorerLink(`https://basescan.org/token/${USDT}`), { chain: "base", address: USDT.toLowerCase() });
  assert.equal(G.tokenFromExplorerLink(`https://etherscan.io/address/${USDT}`), null);
});

test("classifies popup input", () => {
  assert.deepEqual(G.classifyInput(` ${MINT} `), { kind: "contract", chain: "sol", value: MINT });
  assert.deepEqual(G.classifyInput(SOL_SIG), { kind: "tx", chain: "sol", value: SOL_SIG });
  assert.deepEqual(G.classifyInput(USDT, "bsc"), { kind: "contract", chain: "bsc", value: USDT.toLowerCase() });
  assert.deepEqual(G.classifyInput("0x" + "Ab".repeat(32), "nope"), { kind: "tx", chain: "eth", value: "0x" + "ab".repeat(32) });
  assert.deepEqual(G.classifyInput(`https://jup.ag/tokens/${MINT}`), { kind: "contract", chain: "sol", value: MINT });
  assert.equal(G.classifyInput("hello"), null);
  assert.equal(G.classifyInput(""), null);
});

test("phishing list matching covers subdomains only", () => {
  const list = ["sawasdeecoin-claim.com"];
  assert.equal(G.listedDomain("sawasdeecoin-claim.com", list), "sawasdeecoin-claim.com");
  assert.equal(G.listedDomain("WWW.Sawasdeecoin-Claim.com.", list), "sawasdeecoin-claim.com");
  assert.equal(G.listedDomain("app.sawasdeecoin-claim.com", list), "sawasdeecoin-claim.com");
  assert.equal(G.listedDomain("notsawasdeecoin-claim.com", list), null);
  assert.equal(G.listedDomain("sawasdeecoin-claim.com.evil.io", list), null);
});

test("lookalike detection spares official domains", () => {
  const official = ["sawasdeecoin.com"];
  assert.equal(G.lookalike("swd-zetaphy.sawasdeecoin.com", official), false);
  assert.equal(G.lookalike("sawasdeecoin.com", official), false);
  assert.equal(G.lookalike("sawasdeecoin.app", official), true);
  assert.equal(G.lookalike("claim-sawadee.xyz", official), true);
  assert.equal(G.lookalike("swd-airdrop.io", official), true);
  assert.equal(G.lookalike("example.com", official), false);
});

test("downloaded lists are cleaned", () => {
  const d = G.cleanDomainList({ domains: ["Evil.com", "evil.com", "bad domain", "http://x.com/", "a.b", 5, "ok-site.io", "<script>.com"] });
  assert.deepEqual(d, ["evil.com", "ok-site.io"]);
  assert.deepEqual(G.cleanDomainList(null), []);
  assert.equal(G.cleanDomainList({ domains: Array.from({ length: 50 }, (_, i) => `d${i}.com`) }, 10).length, 10);
  assert.deepEqual(G.matchPatterns(["x.com"]), ["*://x.com/*", "*://*.x.com/*"]);
});

test("API language from the browser language", () => {
  assert.equal(G.apiLang("th"), "th");
  assert.equal(G.apiLang("zh-CN"), "zh");
  assert.equal(G.apiLang("pt-BR"), "en");
  assert.equal(G.API.audit("sol", MINT, "th"), `https://swd-zetaphy.sawasdeecoin.com/api/audit?chain=sol&address=${MINT}&lang=th`);
});
