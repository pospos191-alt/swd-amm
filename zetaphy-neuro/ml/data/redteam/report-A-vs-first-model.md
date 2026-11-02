# Neuro red-team report

Seed `rt-2026-W45`, model `nml-3ab3cd303911`. 160 scam variants built, compiled and read by Neuro (rules + buy/sell simulation on an in-memory EVM) and the model.
An **evasion** is a scam whose shown level stays below "medium".

| | caught by rules + simulation | caught with the model |
|---|---:|---:|
| all | 50% | 94% |
| family:blacklist-trap (15) | 33% | 100% |
| family:dormant-fee (16) | 44% | 100% |
| family:drain (18) | 17% | 100% |
| family:hidden-mint (23) | 48% | 100% |
| family:high-tax (15) | 100% | 100% |
| family:honeypot (19) | 100% | 100% |
| family:max-sell (11) | 100% | 100% |
| family:seize (24) | 8% | 100% |
| family:stealth (19) | 37% | 47% |
| mutation:block-ramp (6) | 33% | 50% |
| mutation:fake-renounce (33) | 55% | 100% |
| mutation:hashed-owner (27) | 56% | 93% |
| mutation:noise (62) | 47% | 94% |
| mutation:origin-owner (22) | 41% | 91% |
| mutation:proxy (33) | 100% | 100% |
| mutation:rename (125) | 46% | 93% |
| mutation:sim-aware (6) | 67% | 67% |
| mutation:split-guard (18) | 83% | 89% |
| mutation:timebomb (7) | 14% | 29% |
| mutation:xor-owner (43) | 63% | 98% |
| tell:gasprice (4) | 100% | 100% |
| tell:iscontract (2) | 0% | 0% |

## Evasions (10)

- `rt-rt_2026_W45_53` stealth [noise, rename, split-guard, timebomb]: rules low, shown low, p=0.4224; sim done; top: x_priv_unknown +1.38, m_sim_ok -0.825, x_tx_guard -0.779, x_tx_branches +0.658
- `rt-rt_2026_W45_65` stealth [block-ramp, hashed-owner, noise, rename]: rules low, shown low, p=0.7701; sim done; top: x_priv_unknown +1.303, x_tx_branches -0.682, m_sim_ok -0.642, x_tx_guard +0.537
- `rt-rt_2026_W45_130` stealth [rename, sim-aware, tell=iscontract]: rules low, shown low, p=0.2457; sim done; top: x_priv_unknown +1.405, x_tx_guard -0.917, m_sim_ok -0.797, x_tx_branches +0.528
- `rt-rt_2026_W45_139` stealth [noise, origin-owner, rename, timebomb]: rules low, shown low, p=0.641; sim done; top: x_priv_unknown +1.28, x_tx_guard -0.701, m_sim_ok -0.636, r_ctl_owner +0.518
- `rt-rt_2026_W45_13` stealth [origin-owner, rename, timebomb]: rules low, shown low, p=0.3974; sim done; top: x_priv_unknown +1.197, x_tx_guard -0.888, m_sim_ok -0.703, r_ctl_owner +0.518
- `rt-rt_2026_W45_70` stealth [noise, rename, timebomb, xor-owner]: rules low, shown low, p=0.2844; sim done; top: x_priv_unknown +1.197, x_tx_guard -0.835, m_sim_ok -0.719, r_ctl_owner +0.518
- `rt-rt_2026_W45_86` stealth [rename, split-guard, timebomb]: rules low, shown low, p=0.709; sim done; top: x_priv_unknown +1.519, x_tx_guard -0.801, m_sim_ok -0.678, x_tx_branches +0.665
- `rt-rt_2026_W45_101` stealth [block-ramp, hashed-owner, rename]: rules low, shown low, p=0.3765; sim done; top: x_priv_unknown +1.216, x_tx_guard +0.677, m_sim_ok -0.667, x_fee_owner_free -0.57
- `rt-rt_2026_W45_122` stealth [block-ramp]: rules low, shown low, p=0.606; sim done; top: x_priv_unknown +1.275, m_sim_ok -0.637, x_tx_time -0.516, x_tx_guard +0.505
- `rt-rt_2026_W45_153` stealth [rename, sim-aware, tell=iscontract]: rules low, shown low, p=0.682; sim done; top: x_priv_unknown +1.42, x_tx_guard -0.795, m_sim_ok -0.709, x_tx_branches +0.58
