# swd-sdk (Rust)

Client for the public **SWD (SAWASDEE COIN)** APIs at `https://swd-zetaphy.sawasdeecoin.com`, plus a reader for the
on-chain **SWD Audit Registry** record layout. Async and blocking (reqwest + rustls), serde types, no API key, no
private keys.

ภาษาไทย: [README.th.md](README.th.md)

| Method | Endpoint |
| --- | --- |
| `audit(chain, address, lang, full)` | `GET /api/audit` — contract / token audit on 14 chains |
| `audit_tx(chain, hash, lang, full)` | `GET /api/audit/tx` — transaction check (sol, eth, bsc, base, arbitrum, zetaphy) |
| `audit_chains()` | `GET /api/audit` — accepted chains |
| `supply()` | `GET /api/supply/total` + `/api/supply/circulating` (decimal strings, no float rounding) |
| `buy_swd_transaction(account, amount_sol, slippage_bps, lang)` | `POST /api/actions/buy-swd` — an **unsigned** SOL → SWD transaction for the buyer's wallet to sign |
| `badge_url(chain, address)` | the SVG badge URL |

```toml
[dependencies]
swd-sdk = "0.1"                     # async + blocking + registry
# swd-sdk = { version = "0.1", default-features = false }   # async client only
```

```rust
// blocking
let swd = swd_sdk::blocking::SwdClient::new()?;
let a = swd.audit("sol", swd_sdk::SWD_MINT, "en", false)?;
println!("{} — {}", a.level.as_str(), a.title);

// async (tokio)
let swd = swd_sdk::SwdClient::with_base_url("https://swd-zetaphy.sawasdeecoin.com")?;
let s = swd.supply().await?;
```

Errors are `SwdError::{Http, Api { code, message, status }, BadInput, BadResponse}`; `code()` gives the API's own code
(`bad_chain`, `bad_address`, `bad_hash`, `read_failed`, ...).

## On-chain registry reader (feature `registry`)

`swd_sdk::registry` follows `docs/SWD_AUDIT_REGISTRY.md` (branch `claude/onchain-registry`):

- `record_pda(program_id, chain_id, address)` / `config_pda(program_id)` — PDA derivation with no Solana SDK
  (checked against `@solana/web3.js` in the tests). EVM addresses are lowercased first.
- `Record::parse(data)` / `Config::parse(data)` — the fixed byte layout (discriminator, level at offset 12,
  revoked at 13, ..., address at 146), with the address hash checked.
- `evaluate(config, record)` — the program's own trust rule: trusted only if not revoked and signed by an
  active or retired attestor.
- `decide(...)`, `lookup(...)` (async) and `lookup_blocking(...)` — read both accounts through **your** Solana RPC
  and return `NotFound` / `Untrusted(record)` / `Trusted(record)`; a forged account is an error, never "not found".

> The registry program is an **unaudited draft and not deployed**. `DRAFT_PROGRAM_ID` is its placeholder id; use the
> real program id once SWD publishes it. A missing record means "not known", never "safe".

A record proves only the classical Ed25519 half. For the full hybrid (ML-DSA-44 + Ed25519) check, fetch the
attestation (its `payload_hash` is in the record) and verify it with the site's verifier or `swd-sdk` (JS).

## Test (offline)

```bash
cd integrations/swd-sdk-rust
cargo test          # a local mock HTTP server on 127.0.0.1; no network
cargo clippy --all-targets
```

The crate is its own Cargo workspace (it is not part of the repo's Anchor workspace in `programs/`).

## Publish (maintainers)

```bash
cargo login         # an API token from https://crates.io/settings/tokens (GitHub login)
cargo publish
```
