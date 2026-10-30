**English** | [ภาษาไทย](browser-ai.th.md)

# Browser AI: registry, verified distribution, P2P, pipeline split, on-chain knowledge

Status: **testnet prototype**. Everything below runs with no server of ours, no API key and no new dependency.
Nothing here moves money. Each part says what is built, how to use it, its limits, and what is still missing.

| Item | Status |
|---|---|
| (1) On-chain model registry | **Done** (contract, deploy/propose script, tests). Not deployed: needs the timelock owners |
| (2) Chunked, verified distribution + P2P | **Done**: mirrors, manual codes, and **automatic peer discovery through the ZETAPHY chain** (SignalBoard contract, tested end to end in Chromium). Not live yet: SignalBoard must be deployed (one command, no owner) and its address set in `config.js`. Optional WebTorrent-tracker board built but off |
| (7) Model split across browsers | **Done for a real (tiny) language model**: a 0.34M-parameter Llama-architecture model trained here, split layer-wise across two browsers that found each other on chain, **same tokens as one browser** (bit-exact, any JS engine). Small and slow by design: not a useful assistant; big models still need WebGPU |
| (8) On-chain knowledge for RAG | **Done** (reader, local index, context integration, panel option) |
| In-browser provider | **Done, with a tiny model**: Neuro's learned risk score (75 KB) + path checks + templates; no LLM runtime vendored |

## (1) ModelRegistry — `zetaphy-network/contracts/ModelRegistry.sol`

One record per `(id, version)`: `kind` (model / skill / prompt / ruleset), `manifestHash` (sha256 of the manifest
file's exact bytes), `chunkRoot` (Merkle root of the chunks, below), `size`, `chunkSize`, `license` (SPDX id),
`author`, `status` (active / suspended / deprecated / revoked), `publishedAt`, `updatedAt`.
`id = keccak256("zetaphy.registry" ‖ uint8 kind ‖ name)` (`idOf`, also computed in JS on both sides).

Who changes what — the same split as every other ZETAPHY contract:

- **governance = ZetaphyTimelock** (48 h public delay; proposers = multisig or the gov module): `publish`, `setStatus`
  (any status), `setGuardian`, `setGovernance`. Versions of an id only go up; an id keeps its kind.
- **guardian**: `suspend(id, version)` only, at once (risk reduction). Only governance re-activates.
- `revoked` is final (a fixed model is a new version).
- Loaders ask `latest(id)` / `release(id, version)` / `isUsable(id, version, manifestHash, chunkRoot)` and refuse anything not `active`.

Use (testnet; the script never takes a key on the command line):

```sh
cd zetaphy-network
KEYFILE=~/.zetaphy/deployer.key node scripts/model-registry.js deploy --governance 0x<ZetaphyTimelock> [--guardian 0x<multisig>]
node scripts/model-registry.js propose --registry 0x… --release ../zetaphy-neuro/web/models/neuro-ml-gbdt/1/release.json --author 0x… --timelock 0x…
#   prints publish(...) calldata + the timelock schedule/execute calldata and operation id for the proposers
node scripts/model-registry.js status --registry 0x… --name neuro-ml-gbdt --version 1 --status deprecated --timelock 0x…
node scripts/model-registry.js show --registry 0x… --name neuro-ml-gbdt
```

The deploy refuses a governance address that is not a contract (outside `--devnet`); the deployer key holds no role.
`src/modelregistry.js` has the id / calldata / timelock-operation helpers.
Tests: `test/modelregistry.test.js` (roles, the timelock path, guardian suspend, revoked-is-final, record checks, the
browser reader decoding the real contract's answers, end-to-end publish → verified load → suspend → refused).

Remaining: deploy it on testnet and publish `neuro-ml-gbdt` v1 through the timelock (owners' action), then set
`modelRegistry` in `zetaphy-neuro/ai/browser/config.js`. Until then the page uses a **pinned** release (below) and says so.
The bridge monitor does not yet alert on `Published` / `StatusChanged`. Skills here are metadata; NeuroControl still
approves the skill id that jobs run.

## (2) Chunked, verified distribution — `zetaphy-neuro/ai/browser/`

**Manifest** (`manifest.js`, format `zetaphy-manifest/1`, canonical JSON, its exact bytes hashed):
`{format, kind, name, version, runtime, license, size, chunkSize, sha256, root, chunks:[sha256…], mirrors:[…], meta}`.
Chunk size default 4 MiB (1 KiB–64 MiB, same bounds as the contract). Merkle tree:
`leaf = sha256(0x00‖chunkHash)`, `node = sha256(0x01‖left‖right)`, an odd node is carried up (no duplication), so two
chunk lists never share a root. `merkleProof` / `verifyProof` let a peer prove a single chunk.

**Builder**: `node scripts/build-model-pack.js --in <file> --name <n> --version <v> --runtime <r> --license <spdx>
[--chunk-size N] [--mirror <url with {hash}> …] [--out dir]` → `manifest.json`, `<sha256>.bin` per chunk,
`release.json` (what the registry must hold). Upload the folder as is to any mirror: this site (`web/models/…`), a GitHub
Release (every file an asset: `…/releases/download/<tag>/{hash}.bin`), IPFS (`ipfs add -r`, then `…/ipfs/<cid>/{hash}.bin`).

**Loader** (`loader.js`): release from the registry (`registry.js`, plain `eth_call`, no ethers) → manifest from cache,
peers or mirrors, accepted only if `sha256(file) = manifestHash` and its Merkle root `= chunkRoot` (and size/chunk size
match) → each chunk from cache, then peers, then mirrors (start rotated per chunk to spread load), accepted only if its
length and sha256 match → whole file sha256 checked again. A mirror or peer can be slow or refuse; it cannot change a
byte. Every rejection is recorded in `stats.rejected`. Mirrors must be https (or http on localhost) or same-site paths.
**Cache** (`stores.js`): Cache API by default, IndexedDB fallback, memory in tests; cached bytes are re-hashed on every use.

**P2P** (`p2p.js`): WebRTC data channels with a request/response protocol, fragmentation (60 KiB frames; data channels
cap messages ~256 KiB), backpressure, timeouts, a cap on in-flight requests. `servePeer` answers only from the local
store; `peerSource` is a loader source (its answers are verified like any mirror's).

**Signaling, manual.** One browser makes an offer code (SDP with all ICE candidates, deflated, base64url, `ZP1.`
prefix, ~0.5–1 KB), the other pastes it and returns an answer code. Any chat app, email or a QR code can carry them; no
server is involved. QR rendering is not bundled (the code is plain text).

**Signaling, automatic: the ZETAPHY chain is the rendezvous** (`ai/browser/signal.js`, `boards.js`, `discovery.js`,
`zetaphy-network/contracts/SignalBoard.sol`). No server of ours, no third party, no CSP change (the RPC is already https):

1. Each browser makes a **session identity** in memory (WebCrypto ECDSA P-256 to sign, ECDH P-256 to receive) and posts
   a signed **announce** under a **topic** = `sha256("zetaphy-signal/1|<purpose>|<manifest hash>")` (purpose `chunks`
   for model files, `stage` for pipeline stages), with a small public `meta` (e.g. `{role: 'stage', from: 3, to: 6}`).
2. A browser that wants a peer it saw posts an **offer** to that peer id: its SDP, **encrypted to the peer** (ECDH →
   HKDF-SHA256 → AES-256-GCM, header as associated data) and signed. The lower peer id offers first (the other waits
   3 polls), and simultaneous offers resolve to one connection.
3. The peer posts the encrypted **answer**; the data channel opens. Peers only ever get a channel: chunks are still
   checked against the registry hashes, activations by the coordinator.

Envelope (binary, ≤ 2048 bytes): `"ZS" v1 | kind | topic | to (16) | expiresAt | idPub | ecdhPub | nonce | body | sig`.
The signature covers a **domain** naming the board (chain id + contract address, or the tracker URL), so an envelope
cannot be replayed onto another board; readers drop expired ones (2 min clock skew), other topics, bad signatures,
envelopes whose on-chain indexed fields disagree with their content, and repeats.

**SignalBoard** (no owner, no funds, no settings, nothing stored but a rate counter): `post(topic, to, expiresAt,
payload)` emits `Signal(topic, to, from, expiresAt, payload)`; payload 1..2048 bytes; `expiresAt` in (now, now + 600 s];
≤ 12 posts per sender per 60 s. Browsers read it with `eth_getLogs` (the last 150 blocks first, then only new ones).
Posting needs gas: the page makes a **throwaway session key** (`ai/browser/evmtx.js`: secp256k1 + RFC 6979 + legacy
EIP-155 tx in plain JS, cross-checked with `@ethereumjs/tx`; not constant-time, holds faucet coins only), asks the
testnet faucet (`zetaphy_faucet`, free, once) when it cannot pay, and signs only `SignalBoard.post`. Measured: an announce
(303-byte envelope) 56k gas, an offer (766 bytes, a typical LAN SDP) 50k gas, ≈ 0.00005 testnet ZETAPHY each at 1 gwei,
so the faucet's 10 ZETAPHY pays ~200,000 posts; a connection costs 3 posts (announce, offer, answer), ~15 s at 5 s blocks.
Deploy: `KEYFILE=… node zetaphy-network/scripts/signal-board.js deploy`, then set `signalBoard` in
`zetaphy-neuro/ai/browser/config.js`; `signal-board.js show --board 0x…` lists recent posts per topic.

**Tracker board (optional, off):** `trackerBoard({url})` speaks the WebTorrent tracker WebSocket protocol (announce
offers to random peers, `to_peer_id` answers); the tracker only forwards the same signed, encrypted envelopes. Off by
default because a public tracker is a third party that sees every peer's IP address and topic, and because the CSP
allows no `wss:` today: to use one, add its exact `wss://` URL to `connect-src` in `web/index.html` and `vercel.json`
(and the hub's, if embedded) and to `trackers` in `config.js`. Swappable for any tracker URL.

**Limits (all options of `createSwarm` / `servePeer` / `config.js`):** `maxPeers` 4 (counting half-open ones),
`maxPending` 2 offers, a post budget of 10 per minute, `offerTimeoutMs` 90 s then a cooldown before re-offering, ≤ 256
remembered peers, ≤ 4096 remembered message hashes; upload **2 MiB/s and 256 MiB per peer** (`servePeer`
`maxBytesPerSecond` / `maxBytesTotal`); the loader stops asking a peer after 3 wrong or failed answers and falls back to
**mirrors** (same verification), so a slow or lying peer costs time only.

**Privacy, honestly:** an announce is **public and permanent** on chain (session address, topic = which model, time),
even after it "expires" (expiry is enforced by readers). The SDP (IP addresses) inside offers/answers is encrypted to
the one recipient, and the session keys live only in that page, so old logs cannot be opened later from this side. But
**a peer you connect to sees your IP address**, as with any WebRTC. ICE: no STUN/TURN by default → **same machine or
same LAN only**; `iceServers` in `config.js` (a public STUN, a third party that sees the asking IP) makes most home NATs
work; **symmetric NATs / strict networks need TURN, a relay server: not provided.** The session key is kept in
localStorage (so the faucet is asked once per browser), never shown; it is not a wallet.

Tests: `zetaphy-neuro/test/signal.test.js` (envelopes: tamper/replay/domain/topic/expiry/recipient; session-key txs
verified by `@ethereumjs/tx`; the real SignalBoard on an in-memory chain: post, look up, faucet, bounds, rate limit,
mismatched logs; swarms over memory, chain and a fake WebTorrent tracker; `maxPeers`, glare, `want`, forged and replayed
posts), `zetaphy-network/test/signalboard.test.js` (contract + ABI cross-check), `zetaphy-neuro/test/swarm.e2e.js`
(two Chromium contexts discover each other through the contract with no codes and run the split model).

## (7) A language model split across browsers — `llama.js`, `tokenizer.js`, `detmath.js`, `llmload.js`, `pipeline.js`

**The model.** `ai/browser/llama.js` runs Karpathy's llama2.c architecture (MIT) in plain JS: RMSNorm, rotary position
embedding, grouped-query attention, SwiGLU, KV cache, tied or separate classifier; `tokenizer.js` is llama2.c's
tokenizer (same `encode`/`decode`, byte fallback). Any llama2.c legacy checkpoint converts (`fromLlama2c`), so
Karpathy's TinyStories models (stories260K, stories15M, MIT) run with the same code:
`node scripts/build-llm-pack.js --model stories15M.bin --tokenizer tokenizer.bin --name stories15m --license MIT`
(not in the repo: huggingface.co was not reachable from where this was built, and stories15M is 58 MiB).

The repo ships **`zetaphy-docs-tiny` v1** (`web/models/zetaphy-docs-tiny/1/`, 1.37 MB in 21 chunks of 64 KiB, pinned
as `PINNED_LLM` until ModelRegistry is deployed): **338,240 parameters** (dim 64, 6 layers, 8 heads / 4 KV heads, FFN
172, vocabulary 1024, context 256), trained here from scratch by `scripts/llm/train-tiny-llama.py` (numpy only, hand-
written backward pass with a gradient check, 3000 steps of 8 × 256 tokens, ~1 h on one CPU core) on this repository's
own English docs (prose paragraphs of the 45 `*.md` files, 219k tokens). Validation loss 3.44 nats/token (perplexity
≈ 31; training loss 2.2: it overfits a corpus this small). **What it writes, honestly:** English that sounds like these
docs and means nothing ("ZETAPHY is a new chain: the chain's address on ZETAPHY testnet…"). It is there to prove that a
real trained transformer runs split across browsers, not to answer questions; its license is the repo's (BUSL-1.1),
because its training data is the repo's docs.

**File format `zllm/1`** (layer-major): header JSON + tokenizer + embedding + final norm (+ classifier) + one contiguous
section per layer, so **a peer downloads only the chunks of its own layers** (`llmload.js`, loader option `only`):
in the shipped model the stage serving layers 3–6 fetches 10 of 21 chunks (with the header) and the coordinator (head + layers 0–3) 13.
Every fetched chunk is still checked against the manifest, the manifest against the registry release; a lying mirror
or peer is refused exactly as for whole files.

**Split across browsers.** `createStage(model, {from, to})` runs a layer range with its own KV cache per generation
("session"); `serveLlmStage(channel, stage)` serves it to one peer (sessions keyed per channel, so peers never share a
cache; positions must follow each other; another range or model is refused); `remoteLlmStage(channel, {from, to})`
is the coordinator's proxy; `chainStages([...])` joins local and remote ranges; `generate()` does the prompt in one
message (prefill), then one message per token (greedy, or top-p sampling with a seeded xorshift RNG). The coordinator
keeps the embedding and output layer. In the page (AI panel → "In this browser" → "Tiny language model, split across
browsers"): **Lend this browser** loads layers 3–6 and announces a `stage` on SignalBoard; **Write, split with another
browser** loads the head + layers 0–3, finds such a browser through the chain, generates, and says whether the tokens
equal a run with every layer here (**Write here**).

**Bit-exact, by construction.** Weights and activations are float32; every dot product is summed in float64 in a fixed
order; exp / sin / cos / pow come from `detmath.js`, built only from operations IEEE 754 fixes exactly (+ − × ÷, sqrt,
round), with fixed-bit tests. So the split gives **the same bits as one browser in any JS engine** (no reliance on
`Math.exp` being equal across V8 / SpiderMonkey / JavaScriptCore). Tests compare logits at every step and greedy and
sampled text for 2 and 3 stages (GQA, MHA, separate classifier), and in Chromium over WebRTC
(`test/swarm.e2e.js`). Against an **independent implementation** (numpy, float64, no KV cache, in the training
script's `--reference` mode) the shipped model's logits differ by at most **3.3e-6** and the greedy tokens are equal
(`test/fixtures/llm-reference.json`). Not compared with llama2.c's own C code here (running downloaded code was not
allowed in the build environment); the format and tokenizer follow run.c and the round trip to its file format is tested.

**Speed and size, honestly.** One browser: ~400–500 tokens/s for this 0.34M model on one CPU core (the cost is ~2 ×
parameters flops per token). Split: each token is one round trip per remote stage: measured **7–11 ms per hop** between
two Chromium contexts on one machine (`test/swarm.e2e.js`, ~90–150 tokens/s), more on a real LAN, and tens to hundreds of
ms across the internet. So the split is **slower than one browser for any model that fits in one browser**, and only
pays off when a model does not fit. Finding the other browser took 5–6 s in that test (a chain that mines at once); on the
testnet expect ~15–20 s (three posts at ~5 s blocks plus polling). stories15M (15M params, 58 MiB) would run roughly
10 tokens/s per browser in this plain JS path (estimated from the flops, not measured).
Models of 1B+ parameters need a WebGPU runtime, quantised weights and a CSP with `'wasm-unsafe-eval'`: **not done**.

**Still missing:** fault tolerance (a stage that leaves ends the generation; the coordinator does not re-route),
proof that a remote stage computed honestly (the coordinator can only recompute when it holds those layers, or use a
second stage as a replica), batching several users' tokens into one hop, and a coordinator that finds several stages
for a 3+-way split by itself (the code supports any number of stages; the page wires two).

The batch prototype on a toy MLP (`toymodel.js`, `createPipeline` / `serveStage`, GPipe-style micro-batches, spot
checks) stays as it was (`test/browserai.e2e.js`).

## (8) On-chain knowledge for RAG — `zetaphy-neuro/ai/onchain.js`

`createKnowledgeIndex()` reads, with `eth_getLogs` in 500-block windows (incremental, resumable, JSON-serialisable):
ThreatRegistry `Voted` / `Flagged` / `Cleared` / `Protected` per key, and NeuroJobs `JobRequested` + `Finalized`.
`lookup(report, {code, verdict})` finds the vaccine keys of the contract on screen — code fingerprint (fp1),
`addressKey(chainId, address)`, `codeKey(extcodehash)` (computed exactly as the contract does; cross-checked against the
real contract and `src/vaccine.js` in tests) — and past network verdicts on the same target, marking whether each equals
this report's verdict.
`buildContext(report, {knowledge})` adds `facts.onchain` with `CHAIN<n>` evidence ids, labelled "retrieved context
written by runners, not Neuro's rules; may be stale; never lowers the level". Runner-written text (evidence uri) goes
only inside the untrusted fences (defanged, injection-flagged). The prompt lists `CHAIN<n>`; the schema validator accepts
only ids present in the context. Works for every provider (checkbox "Also use records from the ZETAPHY chain").
In the page the first sync reads the last 40 windows (20,000 blocks) and continues from there; the index is kept in
localStorage (public chain data only). Remaining: a GitHub Actions job that publishes a full-history snapshot (verified
against a block hash) so a browser does not need to read history; NeuroJobs address is not configured yet (`neuroJobs: null`).

## In-browser provider — `ai/providers.js` (`browser`), `ai/browser/engine.js`, `web/browser-ai.js`

Provider `browser` in the AI panel ("In this browser (verified model, no key)"). The engine is loaded by the verified
loader and runs in plain JS: **no WASM and no eval, so the CSP is unchanged** (`script-src 'self'`). If a WASM/WebGPU LLM
runtime is vendored later, the only CSP addition allowed is `'wasm-unsafe-eval'` in `script-src` (both `web/index.html`'s
meta tag and `vercel.json`); nothing from a CDN.

What it is, said plainly: **not a language model.** The shipped pack `web/models/neuro-ml-gbdt/1/` is a frozen copy of
Neuro's learned risk score (`ml/model.json`, gradient-boosted trees, 75 KB, 5 chunks of 16 KiB for the demo). The engine
scores the report with it and writes the analyst JSON from fixed templates in all 9 languages, citing only `F<n>`,
`CHAIN<n>` and `ML`; it never answers "less concerned". Follow-up questions get the closest context records, not
generated text. The output passes the same validator as Anthropic/OpenAI/Ollama answers.
Why no real LLM: transformers.js / WebLLM plus even a 0.5B model is tens to hundreds of MB of runtime and weights —
too big for this repo. The path for it is ready: add a runtime to `engine.js`, pack the weights with the builder (4 MiB
chunks), publish in the registry, list GitHub Release / IPFS mirrors.

What the shipped model catches (`nml-3ab3cd303911`, replacing `nml-b4c35477f7b1`; synthetic held-out split of 390 rows
and fresh red-team runs never trained on; details in `zetaphy-neuro/ml/README.md`):

| | before | after |
|---|---:|---:|
| AUC / recall at 1% false alarms | 0.9975 / 0.950 | 1.000 / 1.000 |
| calibration error (ECE) / Brier | 0.026 / 0.020 | 0.010 / 0.002 |
| scams shown at medium+ (benign at medium+) | 95.0% (22.8%) | 99.5% (22.8%) |
| fresh red team caught, seeds B / C | 84% / 83% | 97% / 97% |
| unseen scam family (leave one out), worst alarmed share | 0.62 (hidden mint) | 0.71 (blacklist) |
| pack size | 87 KB, 6 chunks | 75 KB, 5 chunks |

New in it: per-function path features (`ml/flow.js`: who can call each function, does it move or create tokens, is there a
fixed cap, what `transfer()` depends on), three fixed path checks that raise the level by themselves (`ml/checks.js`: the
owner can move/create tokens with no limit, can set any fee, or hides behind `owner() = 0`), and the panel's "strongest
signals" now lists only what raised the risk, in plain words. The numbers are synthetic and optimistic for real contracts.

This is the **browser** model. The on-chain score (`NeuroScore`) and the zk circuit stay on the previous model
`nml-b4c35477f7b1` until a new public zk ceremony is run (`onchain-ml.md`), so the same token can show a different level here
than on-chain.

The pinned release: until ModelRegistry is deployed, `ai/browser/config.js` holds the release record (a test keeps it
equal to `release.json`) and the panel says "pinned in this page … the page itself vouches for the hashes".

Tests: `zetaphy-neuro/test/browserai.test.js` (manifests, loader vs lying mirrors/peers/cache, P2P protocol, pipeline,
engine in 9 languages, on-chain knowledge into the context), `test/browserai.e2e.js` (two Chromium contexts over real
WebRTC with manual codes; pipeline over it; the panel end to end under the real CSP), `zetaphy-network/test/modelregistry.test.js`.
