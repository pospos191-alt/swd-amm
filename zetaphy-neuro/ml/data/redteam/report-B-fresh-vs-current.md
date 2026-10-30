# Neuro red-team report

Seed `neuro-redteam-B`, model `nml-3ab3cd303911`. 160 scam variants built, compiled and read by Neuro (rules + buy/sell simulation on an in-memory EVM) and the model.
An **evasion** is a scam whose shown level stays below "medium".

| | caught by rules + simulation | caught with the model |
|---|---:|---:|
| all | 56% | 97% |
| family:blacklist-trap (11) | 36% | 100% |
| family:dormant-fee (15) | 40% | 100% |
| family:drain (17) | 18% | 100% |
| family:hidden-mint (21) | 33% | 100% |
| family:high-tax (24) | 100% | 100% |
| family:honeypot (18) | 100% | 100% |
| family:max-sell (16) | 100% | 100% |
| family:seize (17) | 24% | 100% |
| family:stealth (21) | 33% | 76% |
| mutation:block-ramp (7) | 14% | 71% |
| mutation:fake-renounce (30) | 60% | 100% |
| mutation:hashed-owner (32) | 56% | 100% |
| mutation:noise (60) | 58% | 97% |
| mutation:origin-owner (31) | 45% | 90% |
| mutation:proxy (26) | 100% | 100% |
| mutation:rename (135) | 55% | 96% |
| mutation:sim-aware (6) | 67% | 83% |
| mutation:split-guard (24) | 79% | 100% |
| mutation:timebomb (8) | 25% | 75% |
| mutation:xor-owner (41) | 61% | 95% |
| tell:coinbase (1) | 0% | 0% |
| tell:gasleft (1) | 100% | 100% |
| tell:gasprice (3) | 100% | 100% |
| tell:iscontract (1) | 0% | 100% |

## Evasions (5)

- `rt-neuro_redteam_B_13` stealth [origin-owner, rename, timebomb]: rules low, shown low, p=0.4849; sim done; top: x_priv_unknown +1.254, x_tx_guard -0.86, m_sim_ok -0.643, r_ctl_owner +0.518
- `rt-neuro_redteam_B_32` stealth [block-ramp, origin-owner, rename]: rules low, shown low, p=0.6409; sim done; top: x_priv_unknown +1.248, m_sim_ok -0.619, x_tx_guard +0.505, x_fee_owner_free -0.493
- `rt-neuro_redteam_B_79` stealth [rename, timebomb, xor-owner]: rules low, shown low, p=0.3541; sim done; top: x_priv_unknown +1.189, x_tx_guard -0.835, m_sim_ok -0.713, x_fee_owner_free -0.528
- `rt-neuro_redteam_B_97` stealth [block-ramp, noise, origin-owner, rename]: rules low, shown low, p=0.4003; sim done; top: x_priv_unknown +1.216, m_sim_ok -0.666, x_tx_guard +0.576, x_fee_owner_free -0.566
- `rt-neuro_redteam_B_152` stealth [noise, rename, sim-aware, xor-owner, tell=coinbase]: rules low, shown low, p=0.544; sim done; top: x_priv_unknown +1.332, x_tx_guard -0.894, m_sim_ok -0.611, r_ctl_owner +0.518
