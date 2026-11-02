# Neuro red-team report

Seed `rt-2026-W45-fresh`, model `nml-d5cac5ccb830`. 160 scam variants built, compiled and read by Neuro (rules + buy/sell simulation on an in-memory EVM) and the model.
An **evasion** is a scam whose shown level stays below "medium".

| | caught by rules + simulation | caught with the model |
|---|---:|---:|
| all | 55% | 96% |
| family:blacklist-trap (22) | 23% | 91% |
| family:dormant-fee (19) | 32% | 100% |
| family:drain (14) | 36% | 100% |
| family:hidden-mint (15) | 27% | 100% |
| family:high-tax (21) | 100% | 100% |
| family:honeypot (23) | 100% | 100% |
| family:max-sell (15) | 100% | 100% |
| family:seize (17) | 24% | 100% |
| family:stealth (14) | 36% | 71% |
| mutation:block-ramp (5) | 20% | 60% |
| mutation:fake-renounce (28) | 57% | 100% |
| mutation:hashed-owner (35) | 46% | 94% |
| mutation:noise (74) | 51% | 96% |
| mutation:origin-owner (33) | 70% | 91% |
| mutation:proxy (29) | 100% | 100% |
| mutation:rename (138) | 51% | 96% |
| mutation:sim-aware (5) | 60% | 80% |
| mutation:split-guard (16) | 88% | 100% |
| mutation:timebomb (4) | 25% | 75% |
| mutation:xor-owner (29) | 41% | 97% |
| tell:coinbase (1) | 0% | 100% |
| tell:gasleft (1) | 100% | 100% |
| tell:gasprice (1) | 100% | 100% |
| tell:iscontract (1) | 0% | 0% |
| tell:nobalance (1) | 100% | 100% |

## Evasions (6)

- `rt-rt_2026_W45_fresh_31` blacklist-trap [hashed-owner, noise, rename]: rules low, shown low, p=0.7865; sim done; top: x_priv_unknown +0.771, x_priv_xfer_free -0.448, o_rate_sha3 -0.428, g3_11 +0.367
- `rt-rt_2026_W45_fresh_80` stealth [block-ramp, hashed-owner, rename]: rules low, shown low, p=0.5099; sim done; top: x_priv_unknown +0.779, x_priv_xfer_free -0.501, o_rate_jumpi +0.353, x_fee_owner_free -0.326
- `rt-rt_2026_W45_fresh_92` stealth [noise, rename, sim-aware, xor-owner, tell=iscontract]: rules low, shown low, p=0.3951; sim done; top: x_priv_unknown +0.857, x_priv_xfer_free -0.476, x_fee_owner_free -0.37, m_sim_ok -0.307
- `rt-rt_2026_W45_fresh_98` stealth [noise, origin-owner, rename, timebomb]: rules low, shown low, p=0.7709; sim done; top: x_priv_unknown +0.846, x_priv_xfer_free -0.488, g3_21 +0.38, o_rate_jumpi +0.344
- `rt-rt_2026_W45_fresh_114` blacklist-trap [origin-owner, rename]: rules low, shown low, p=0.1299; sim done; top: x_priv_unknown -1.195, r_level -0.942, x_priv_xfer_free -0.492, g3_11 +0.387
- `rt-rt_2026_W45_fresh_145` stealth [block-ramp, origin-owner, rename]: rules low, shown low, p=0.5593; sim done; top: x_priv_unknown +0.751, x_priv_xfer_free -0.47, g3_11 +0.432, s_dispatched +0.384
