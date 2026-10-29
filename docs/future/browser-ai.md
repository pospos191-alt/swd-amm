**English** | [ภาษาไทย](browser-ai.th.md)

# Browser AI: registry, verified distribution, P2P, pipeline split, on-chain knowledge

Status: **testnet prototype**. Everything below runs with no server of ours, no API key and no new dependency.
Nothing here moves money. Each part says what is built, how to use it, its limits, and what is still missing.

| Item | Status |
|---|---|
| (1) On-chain model registry | **Done** (contract, deploy/propose script, tests). Not deployed: needs the timelock owners |
| (2) Chunked, verified distribution + P2P | **Done** for mirrors and manual-code WebRTC; **gap**: automatic peer discovery needs a signaling channel (see below) |
| (7) Large model split across browsers | **Prototype** on a toy MLP (mechanism proven, bit-exact); not a real LLM |
| (8) On-chain knowledge for RAG | **Done** (reader, local index, context integration, panel option) |
| In-browser provider | **Done, with a tiny model**: Neuro's learned risk score (87 KB) + templates; no LLM runtime vendored |

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

**Signaling — what is free and what is not.** Implemented: **manual codes**. One browser makes an offer code (SDP with
all ICE candidates, deflated, base64url, `ZP1.` prefix, ~0.5–1 KB), the other pastes it and returns an answer code.
Any chat app, email or a QR code can carry them; no server is involved. ICE: no STUN/TURN by default → **same machine or
same LAN only**. Passing `iceServers` (a public STUN) makes most home NATs work; **symmetric NATs / strict corporate
networks need a TURN relay, which is a server: not provided.** Automatic discovery ("find any browser that has chunk X")
needs a rendezvous channel; options considered: a public BitTorrent WebTorrent tracker or a public Nostr relay (both
third-party servers, free but not ours, and they see who is online) — **not implemented**; it would also need a
`connect-src` entry for `wss:` (today `https:` only). QR rendering is not bundled (the code is plain text).

## (7) Large model split across browsers — `pipeline.js`, `toymodel.js` (prototype)

Layers are cut into contiguous ranges with about equal parameters (`planStages`); each peer runs `serveStage` for one
range; the coordinator (`createPipeline`) cuts the batch into micro-batches and keeps several in flight so all stages
work at once (GPipe-style, forward only). Activations travel as float32 over the data channel.
Proven: the pipelined output is **bit-for-bit** the single-machine output, over in-memory channels (3 stages) and over a
**real WebRTC channel between two Chromium contexts** (`test/browserai.e2e.js`). A stage asked for another range refuses;
a lying stage is caught by the coordinator's spot check (recompute a share of micro-batches when it holds the weights).

Limits, honestly: the model is a seeded toy MLP (16→48…→8), not a language model. No autoregressive decoding loop, no KV
cache, no attention layers, no quantisation, no fault tolerance (a peer leaving stops the run), no partial download of
only one stage's chunks yet (each peer loads the whole pack), and no proof that a remote stage computed honestly
(spot checks need the weights; replicas cost double). Per-token latency would be (stages × network round trip): fine on a
LAN, slow across the internet. Running a real 7B+ model this way needs a WebGPU runtime with layer-range loading.

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
Neuro's learned risk score (`ml/model.json`, gradient-boosted trees, 87 KB, 6 chunks of 16 KiB for the demo). The engine
scores the report with it and writes the analyst JSON from fixed templates in all 9 languages, citing only `F<n>`,
`CHAIN<n>` and `ML`; it never answers "less concerned". Follow-up questions get the closest context records, not
generated text. The output passes the same validator as Anthropic/OpenAI/Ollama answers.
Why no real LLM: transformers.js / WebLLM plus even a 0.5B model is tens to hundreds of MB of runtime and weights —
too big for this repo. The path for it is ready: add a runtime to `engine.js`, pack the weights with the builder (4 MiB
chunks), publish in the registry, list GitHub Release / IPFS mirrors.

The pinned release: until ModelRegistry is deployed, `ai/browser/config.js` holds the release record (a test keeps it
equal to `release.json`) and the panel says "pinned in this page … the page itself vouches for the hashes".

Tests: `zetaphy-neuro/test/browserai.test.js` (manifests, loader vs lying mirrors/peers/cache, P2P protocol, pipeline,
engine in 9 languages, on-chain knowledge into the context), `test/browserai.e2e.js` (two Chromium contexts over real
WebRTC with manual codes; pipeline over it; the panel end to end under the real CSP), `zetaphy-network/test/modelregistry.test.js`.
