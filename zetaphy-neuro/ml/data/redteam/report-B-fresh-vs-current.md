# Neuro red-team report

Seed `neuro-redteam-B`, model `nml-b4c35477f7b1`. 160 scam variants built, compiled and read by Neuro (rules + buy/sell simulation on an in-memory EVM) and the model.
An **evasion** is a scam whose shown level stays below "medium".

| | caught by rules + simulation | caught with the model |
|---|---:|---:|
| all | 56% | 84% |
| family:blacklist-trap (11) | 36% | 82% |
| family:dormant-fee (15) | 40% | 100% |
| family:drain (17) | 18% | 82% |
| family:hidden-mint (21) | 33% | 76% |
| family:high-tax (24) | 100% | 100% |
| family:honeypot (18) | 100% | 100% |
| family:max-sell (16) | 100% | 100% |
| family:seize (17) | 24% | 71% |
| family:stealth (21) | 33% | 48% |
| mutation:block-ramp (7) | 14% | 14% |
| mutation:fake-renounce (30) | 60% | 63% |
| mutation:hashed-owner (32) | 56% | 88% |
| mutation:noise (60) | 58% | 87% |
| mutation:origin-owner (31) | 45% | 77% |
| mutation:proxy (26) | 100% | 100% |
| mutation:rename (135) | 55% | 84% |
| mutation:sim-aware (6) | 67% | 83% |
| mutation:split-guard (24) | 79% | 88% |
| mutation:timebomb (8) | 25% | 50% |
| mutation:xor-owner (41) | 61% | 90% |
| tell:coinbase (1) | 0% | 100% |
| tell:gasleft (1) | 100% | 100% |
| tell:gasprice (3) | 100% | 100% |
| tell:iscontract (1) | 0% | 0% |

## Evasions (26)

- `rt-neuro_redteam_B_4` stealth [fake-renounce, noise, rename, sim-aware, split-guard, tell=iscontract]: rules info, shown info, p=0.3511; sim done; top: g3_26 -1.466, r_ctl_renounced -1.395, s_unknown_share +1.311, o_rate_iszero +1.104
- `rt-neuro_redteam_B_10` drain [fake-renounce, rename]: rules info, shown low, p=0.5202; sim done; top: r_ctl_renounced -0.911, o_rate_sha3 +0.85, r_ctl_owner -0.841, r_level -0.768
- `rt-neuro_redteam_B_15` blacklist-trap [origin-owner, rename]: rules low, shown low, p=0.509; sim done; top: o_rate_log -0.967, r_ctl_owner -0.789, o_rate_iszero +0.662, g3_27 -0.643
- `rt-neuro_redteam_B_17` hidden-mint [hashed-owner, rename]: rules low, shown low, p=0.098; sim done; top: o_rate_log -0.981, r_ctl_owner -0.7, g3_27 -0.592, g3_21 -0.378
- `rt-neuro_redteam_B_21` drain [origin-owner, rename]: rules low, shown low, p=0.6711; sim done; top: r_ctl_owner -0.841, o_rate_sha3 +0.421, g3_15 -0.42, g3_27 -0.349
- `rt-neuro_redteam_B_36` stealth [block-ramp, fake-renounce, rename]: rules info, shown info, p=0.0818; sim done; top: o_rate_number -3.037, r_ctl_renounced -0.975, o_rate_cmp -0.713, o_rate_iszero +0.674
- `rt-neuro_redteam_B_44` hidden-mint [fake-renounce, noise, rename]: rules info, shown info, p=0.4273; sim done; top: s_unknown_share +1.439, r_ctl_renounced -1.104, o_rate_log -1.029, r_ctl_owner -0.793
- `rt-neuro_redteam_B_61` stealth [block-ramp, noise, origin-owner]: rules low, shown low, p=0.0607; sim done; top: o_rate_number -2.891, o_rate_cmp -0.947, g3_22 -0.829, p_time_gate -0.663
- `rt-neuro_redteam_B_63` hidden-mint [noise, origin-owner, rename]: rules low, shown low, p=0.2153; sim done; top: s_unknown_share +1.357, o_rate_log -1.048, r_ctl_owner -0.803, g3_19 -0.525
- `rt-neuro_redteam_B_102` stealth [block-ramp, fake-renounce]: rules info, shown info, p=0.0524; sim done; top: o_rate_number -2.768, r_ctl_renounced -1.187, o_rate_iszero +0.781, g3_14 +0.705
- `rt-neuro_redteam_B_103` drain [rename, xor-owner]: rules low, shown low, p=0.5553; sim done; top: o_rate_log -1.026, r_ctl_owner -0.919, o_rate_sstore +0.75, s_unknown_share +0.575
- `rt-neuro_redteam_B_126` blacklist-trap [hashed-owner, rename]: rules low, shown low, p=0.408; sim done; top: o_rate_log -0.967, r_ctl_owner -0.7, o_rate_iszero +0.662, g3_27 -0.66
- `rt-neuro_redteam_B_138` hidden-mint [fake-renounce, noise, rename]: rules info, shown info, p=0.1906; sim done; top: s_unknown_share +1.42, r_ctl_renounced -1.193, o_rate_log -1.074, r_ctl_owner -0.917
- `rt-neuro_redteam_B_145` seize [hashed-owner, rename]: rules low, shown low, p=0.7242; sim done; top: r_ctl_owner -0.903, o_rate_caller +0.443, o_rate_sha3 +0.421, g3_27 -0.349
- `rt-neuro_redteam_B_159` seize [rename, xor-owner]: rules low, shown low, p=0.7846; sim done; top: o_rate_log -1.026, r_ctl_owner -0.919, s_unknown_share +0.588, o_rate_xor +0.523
- `rt-neuro_redteam_B_13` stealth [origin-owner, rename, timebomb]: rules low, shown low, p=0.321; sim done; top: o_rate_timestamp -1.683, g3_30 -1.488, p_time_gate -0.663, o_rate_cmp +0.655
- `rt-neuro_redteam_B_32` stealth [block-ramp, origin-owner, rename]: rules low, shown low, p=0.3284; sim done; top: o_rate_number -3.114, p_time_gate -0.663, s_known +0.464, g3_21 +0.453
- `rt-neuro_redteam_B_45` seize [fake-renounce, rename]: rules info, shown low, p=0.5122; sim done; top: r_ctl_renounced -1.164, r_ctl_owner -0.954, r_level -0.842, g3_17 +0.682
- `rt-neuro_redteam_B_79` stealth [rename, timebomb, xor-owner]: rules low, shown low, p=0.0179; sim done; top: o_rate_timestamp -1.683, p_time_gate -0.663, g3_05 -0.563, r_ctl_owner -0.53
- `rt-neuro_redteam_B_87` seize [fake-renounce, noise, rename]: rules info, shown info, p=0.156; sim done; top: g3_30 -1.644, s_unknown_share +1.476, r_ctl_renounced -1.223, r_level -0.851
- `rt-neuro_redteam_B_89` stealth [block-ramp, fake-renounce]: rules info, shown info, p=0.0399; sim done; top: o_rate_number -3.243, r_ctl_renounced -1.026, r_level -0.625, g3_07 -0.538
- `rt-neuro_redteam_B_95` stealth [hashed-owner, rename, split-guard, timebomb]: rules low, shown low, p=0.4228; sim done; top: g3_30 -1.363, g3_05 -0.659, r_ctl_owner -0.62, s_known +0.535
- `rt-neuro_redteam_B_97` stealth [block-ramp, noise, origin-owner, rename]: rules low, shown low, p=0.0867; sim done; top: o_rate_number -3.243, p_time_gate -0.663, g3_07 -0.615, s_unknown_share +0.578
- `rt-neuro_redteam_B_119` stealth [rename, split-guard, timebomb, xor-owner]: rules low, shown low, p=0.4363; sim done; top: g3_05 -0.668, r_ctl_owner -0.642, o_rate_xor +0.523, o_rate_eq -0.513
- `rt-neuro_redteam_B_131` hidden-mint [fake-renounce]: rules low, shown low, p=0.7702; sim done; top: r_ctl_renounced -1.226, s_unknown_share -1.096, s_known -0.572, r_ctl_owner -0.516
- `rt-neuro_redteam_B_153` seize [fake-renounce, noise, rename]: rules info, shown low, p=0.7908; sim done; top: s_unknown_share +1.603, r_ctl_renounced -1.164, r_ctl_owner -0.912, r_level -0.783
