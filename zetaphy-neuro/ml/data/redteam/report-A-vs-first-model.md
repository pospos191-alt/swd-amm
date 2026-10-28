# Neuro red-team report

Seed `neuro-redteam-A`, model `nml-d5c12269aadf`. 160 scam variants built, compiled and read by Neuro (rules + buy/sell simulation on an in-memory EVM) and the model.
An **evasion** is a scam whose shown level stays below "medium".

| | caught by rules + simulation | caught with the model |
|---|---:|---:|
| all | 51% | 58% |
| family:blacklist-trap (19) | 58% | 68% |
| family:dormant-fee (21) | 43% | 48% |
| family:drain (21) | 19% | 38% |
| family:hidden-mint (20) | 25% | 35% |
| family:high-tax (16) | 100% | 100% |
| family:honeypot (12) | 100% | 100% |
| family:max-sell (15) | 100% | 100% |
| family:seize (16) | 13% | 25% |
| family:stealth (20) | 40% | 40% |
| mutation:block-ramp (5) | 60% | 60% |
| mutation:fake-renounce (29) | 48% | 48% |
| mutation:hashed-owner (34) | 44% | 44% |
| mutation:noise (70) | 49% | 56% |
| mutation:origin-owner (40) | 60% | 60% |
| mutation:proxy (27) | 100% | 100% |
| mutation:rename (120) | 43% | 53% |
| mutation:sim-aware (8) | 63% | 63% |
| mutation:split-guard (20) | 70% | 70% |
| mutation:timebomb (7) | 0% | 0% |
| mutation:xor-owner (31) | 55% | 55% |
| tell:coinbase (3) | 33% | 33% |
| tell:gasleft (1) | 100% | 100% |
| tell:gasprice (1) | 100% | 100% |
| tell:iscontract (1) | 0% | 0% |
| tell:nobalance (2) | 100% | 100% |

## Evasions (67)

- `rt-neuro_redteam_A_1` seize [fake-renounce, noise, rename]: rules info, shown info, p=0.0038; sim done; top: r_ctl_owner -7.33, g3_21 +1.267, o_rate_log -0.596, g3_28 +0.559
- `rt-neuro_redteam_A_3` stealth [hashed-owner, rename, timebomb]: rules low, shown low, p=0; sim done; top: r_ctl_owner -5.79, o_rate_timestamp -4.221, g3_28 -0.851, g3_15 -0.692
- `rt-neuro_redteam_A_4` hidden-mint [origin-owner, rename]: rules low, shown low, p=0.0012; sim done; top: r_ctl_owner -6.913, g3_21 +1.144, o_rate_log -0.596, g3_15 -0.47
- `rt-neuro_redteam_A_6` dormant-fee [fake-renounce, noise, rename]: rules info, shown info, p=0.072; sim done; top: r_ctl_owner -7.561, o_rate_iszero +0.81, g3_21 +0.528, g3_19 +0.511
- `rt-neuro_redteam_A_7` seize [fake-renounce, noise]: rules info, shown info, p=0.0054; sim done; top: r_ctl_owner -7.211, g3_28 +0.56, g3_19 +0.454, g3_30 +0.373
- `rt-neuro_redteam_A_15` stealth [block-ramp, hashed-owner, rename]: rules low, shown low, p=0.0001; sim done; top: r_ctl_owner -6.031, o_rate_number -3.959, o_rate_iszero +0.718, g3_28 -0.557
- `rt-neuro_redteam_A_20` seize [origin-owner]: rules low, shown low, p=0.0092; sim done; top: r_ctl_owner -7.211, g3_28 +0.56, g3_19 +0.454, g3_30 +0.391
- `rt-neuro_redteam_A_25` seize [fake-renounce, noise, rename]: rules info, shown info, p=0.0078; sim done; top: r_ctl_owner -7.561, g3_28 +0.712, g3_21 +0.624, g3_19 +0.454
- `rt-neuro_redteam_A_28` hidden-mint [noise, rename, xor-owner]: rules low, shown low, p=0.053; sim done; top: r_ctl_owner -7.142, g3_21 +0.868, o_rate_iszero +0.81, o_rate_log -0.596
- `rt-neuro_redteam_A_29` drain [noise]: rules low, shown low, p=0.5608; sim done; top: g3_28 +0.833, r_ctl_owner +0.752, o_rate_log -0.596, g3_30 +0.556
- `rt-neuro_redteam_A_40` stealth [fake-renounce, rename, timebomb]: rules info, shown info, p=0.0001; sim done; top: r_ctl_owner -6.783, o_rate_timestamp -4.221, g3_21 +0.702, g3_28 +0.615
- `rt-neuro_redteam_A_52` dormant-fee [hashed-owner, noise, rename]: rules low, shown low, p=0.0036; sim done; top: r_ctl_owner -6.774, o_rate_iszero +0.81, g3_19 +0.511, g3_25 -0.342
- `rt-neuro_redteam_A_54` stealth [block-ramp, origin-owner, rename]: rules low, shown low, p=0.0002; sim done; top: r_ctl_owner -6.189, o_rate_number -4.124, o_rate_iszero +0.718, g3_19 +0.511
- `rt-neuro_redteam_A_56` drain [hashed-owner]: rules low, shown low, p=0.0054; sim done; top: r_ctl_owner -7.561, g3_21 +0.702, g3_28 +0.653, g3_19 +0.454
- `rt-neuro_redteam_A_59` seize [hashed-owner, noise, rename]: rules low, shown low, p=0.0046; sim done; top: r_ctl_owner -7.561, g3_28 +0.731, g3_21 +0.702, g3_19 +0.454
- `rt-neuro_redteam_A_63` dormant-fee [hashed-owner, rename]: rules low, shown low, p=0.0041; sim done; top: r_ctl_owner -6.616, o_rate_iszero +0.81, g3_28 -0.683, g3_19 +0.511
- `rt-neuro_redteam_A_68` hidden-mint [hashed-owner, noise, rename]: rules low, shown low, p=0.0017; sim done; top: r_ctl_owner -6.979, o_rate_log -0.596, g3_13 +0.55, g3_19 +0.454
- `rt-neuro_redteam_A_71` hidden-mint [hashed-owner, rename]: rules low, shown low, p=0.0012; sim done; top: r_ctl_owner -6.755, g3_21 +1.363, g3_28 -0.867, o_rate_log -0.596
- `rt-neuro_redteam_A_75` hidden-mint [noise, rename]: rules low, shown low, p=0.7918; sim done; top: r_ctl_owner +0.752, g3_28 +0.692, o_rate_log -0.596, g3_30 +0.574
- `rt-neuro_redteam_A_77` seize [noise, origin-owner, rename]: rules low, shown low, p=0.005; sim done; top: r_ctl_owner -6.979, o_rate_log -0.596, g3_19 +0.454, g3_28 +0.4
- `rt-neuro_redteam_A_79` blacklist-trap [fake-renounce, noise]: rules low, shown low, p=0.0191; sim done; top: r_ctl_owner -7.561, o_rate_iszero +0.81, g3_21 +0.702, g3_28 +0.656
- `rt-neuro_redteam_A_102` drain [noise, rename]: rules low, shown low, p=0.6378; sim done; top: r_ctl_owner +0.752, g3_28 +0.692, o_rate_log -0.596, g3_30 +0.556
- `rt-neuro_redteam_A_106` drain [fake-renounce, rename]: rules info, shown info, p=0.0056; sim done; top: r_ctl_owner -7.211, g3_28 +0.56, g3_19 +0.454, g3_30 +0.391
- `rt-neuro_redteam_A_108` hidden-mint [rename, xor-owner]: rules low, shown low, p=0.0039; sim done; top: r_ctl_owner -7.118, g3_21 +1.267, g3_28 +0.712, o_rate_log -0.596
- `rt-neuro_redteam_A_111` dormant-fee [noise, origin-owner, rename]: rules low, shown low, p=0.0247; sim done; top: r_ctl_owner -7.211, o_rate_iszero +0.81, g3_19 +0.511, g3_28 +0.45
- `rt-neuro_redteam_A_114` stealth [hashed-owner, rename, sim-aware, tell=coinbase]: rules low, shown low, p=0.0003; sim done; top: r_ctl_owner -6.35, g3_15 -0.877, g3_28 -0.819, g3_19 -0.367
- `rt-neuro_redteam_A_115` stealth [noise, split-guard, timebomb, xor-owner]: rules low, shown low, p=0.0044; sim done; top: r_ctl_owner -6.9, g3_21 +1.994, o_rate_iszero +1.017, g3_15 -0.679
- `rt-neuro_redteam_A_116` drain [fake-renounce, noise, rename]: rules info, shown info, p=0.0053; sim done; top: r_ctl_owner -7.33, g3_21 +1.363, o_rate_log -0.596, g3_28 +0.588
- `rt-neuro_redteam_A_119` stealth [origin-owner, sim-aware, tell=iscontract]: rules low, shown low, p=0.0052; sim done; top: r_ctl_owner -7.201, g3_21 +0.83, g3_15 -0.47, g3_19 +0.454
- `rt-neuro_redteam_A_120` drain [fake-renounce, rename]: rules info, shown info, p=0.0077; sim done; top: r_ctl_owner -7.561, g3_28 +0.731, g3_21 +0.702, g3_19 +0.454
- `rt-neuro_redteam_A_125` drain [hashed-owner, rename]: rules low, shown low, p=0.0073; sim done; top: r_ctl_owner -7.561, g3_28 +0.982, g3_21 +0.579, g3_19 +0.454
- `rt-neuro_redteam_A_136` drain [rename, xor-owner]: rules low, shown low, p=0.0055; sim done; top: r_ctl_owner -7.211, g3_28 +0.56, g3_19 +0.454, g3_30 +0.391
- `rt-neuro_redteam_A_153` stealth [noise, origin-owner, rename, sim-aware, split-guard, tell=coinbase]: rules low, shown low, p=0.002; sim done; top: r_ctl_owner -6.992, o_rate_iszero +1.166, o_rate_sstore -0.359, g3_28 +0.338
- `rt-neuro_redteam_A_154` dormant-fee [rename, xor-owner]: rules low, shown low, p=0.0142; sim done; top: r_ctl_owner -6.979, o_rate_iszero +0.81, g3_19 +0.511, o_rate_log -0.498
- `rt-neuro_redteam_A_155` hidden-mint [noise, rename, xor-owner]: rules low, shown low, p=0.0509; sim done; top: r_ctl_owner -7.561, o_rate_iszero +0.81, g3_21 +0.528, g3_19 +0.511
- `rt-neuro_redteam_A_16` dormant-fee [noise, rename, xor-owner]: rules low, shown low, p=0.0017; sim done; top: r_ctl_owner -6.992, g3_28 +0.464, g3_30 +0.46, g3_15 +0.425
- `rt-neuro_redteam_A_17` stealth [rename, split-guard, timebomb, xor-owner]: rules low, shown low, p=0.0007; sim done; top: r_ctl_owner -6.266, g3_30 -2.3, g3_21 +0.9, g3_05 -0.636
- `rt-neuro_redteam_A_19` seize [noise, origin-owner, rename]: rules low, shown low, p=0.002; sim done; top: r_ctl_owner -7.155, g3_05 +0.457, g3_19 -0.322, o_rate_timestamp +0.292
- `rt-neuro_redteam_A_24` blacklist-trap [rename, xor-owner]: rules low, shown low, p=0.001; sim done; top: r_ctl_owner -6.556, o_rate_log -0.498, g3_17 +0.485, g3_05 -0.482
- `rt-neuro_redteam_A_30` blacklist-trap [rename, xor-owner]: rules low, shown low, p=0.0057; sim done; top: r_ctl_owner -6.5, g3_30 -1.122, g3_21 +0.588, g3_15 +0.49
- `rt-neuro_redteam_A_35` dormant-fee [origin-owner, rename]: rules low, shown low, p=0.0046; sim done; top: r_ctl_owner -6.787, g3_05 +0.474, g3_30 +0.46, g3_15 +0.425
- `rt-neuro_redteam_A_37` dormant-fee [fake-renounce]: rules low, shown low, p=0.015; sim done; top: r_ctl_owner -6.762, g3_05 +0.741, g3_15 +0.736, g3_28 -0.443
- `rt-neuro_redteam_A_41` dormant-fee [fake-renounce, noise, rename]: rules info, shown info, p=0.0045; sim done; top: r_ctl_owner -6.992, g3_15 +0.484, g3_05 +0.408, g3_19 -0.322
- `rt-neuro_redteam_A_44` drain [fake-renounce, noise, rename]: rules info, shown info, p=0.0021; sim done; top: r_ctl_owner -7.337, g3_28 +0.371, g3_05 +0.35, g3_19 -0.322
- `rt-neuro_redteam_A_46` seize [fake-renounce, noise, rename]: rules info, shown info, p=0.0041; sim done; top: r_ctl_owner -7.101, g3_17 +0.485, g3_05 +0.474, g3_30 +0.46
- `rt-neuro_redteam_A_49` drain [origin-owner]: rules low, shown low, p=0.0038; sim done; top: r_ctl_owner -7.337, g3_30 +0.46, g3_05 +0.377, g3_19 -0.322
- `rt-neuro_redteam_A_57` stealth [hashed-owner, noise, rename, split-guard, timebomb]: rules low, shown low, p=0.0001; sim done; top: r_ctl_owner -6.266, g3_30 -2.3, g3_21 +1.198, g3_05 -0.636
- `rt-neuro_redteam_A_62` drain [hashed-owner, rename]: rules low, shown low, p=0.0018; sim done; top: r_ctl_owner -6.787, g3_05 +0.554, g3_17 -0.37, g3_19 -0.322
- `rt-neuro_redteam_A_73` seize [rename, xor-owner]: rules low, shown low, p=0.0029; sim done; top: r_ctl_owner -6.834, g3_30 -1.161, g3_05 +0.875, g3_21 +0.588
- `rt-neuro_redteam_A_78` blacklist-trap [hashed-owner, noise, rename]: rules low, shown low, p=0.0025; sim done; top: r_ctl_owner -6.748, g3_05 +0.741, g3_15 -0.684, g3_11 -0.448
- `rt-neuro_redteam_A_81` seize [hashed-owner, rename]: rules low, shown low, p=0.0024; sim done; top: r_ctl_owner -6.943, g3_05 +0.554, g3_26 +0.429, g3_19 -0.322
- `rt-neuro_redteam_A_96` hidden-mint [origin-owner, rename]: rules low, shown low, p=0.0008; sim done; top: r_ctl_owner -6.6, g3_30 -2.154, g3_05 +0.875, g3_21 +0.588
- `rt-neuro_redteam_A_100` hidden-mint [rename, xor-owner]: rules low, shown low, p=0.0006; sim done; top: r_ctl_owner -6.6, g3_30 -2.154, g3_05 +0.875, g3_21 +0.588
- `rt-neuro_redteam_A_101` hidden-mint [origin-owner, rename]: rules low, shown low, p=0.0153; sim done; top: r_ctl_owner -6.762, g3_05 +0.832, g3_15 +0.736, g3_28 -0.443
- `rt-neuro_redteam_A_107` dormant-fee [rename, xor-owner]: rules low, shown low, p=0.0017; sim done; top: r_ctl_owner -7.337, g3_30 +0.46, g3_15 +0.425, g3_28 +0.371
- `rt-neuro_redteam_A_113` hidden-mint [noise, origin-owner, rename]: rules low, shown low, p=0.0138; sim done; top: r_ctl_owner -6.585, g3_05 +0.741, g3_15 +0.736, g3_28 -0.443
- `rt-neuro_redteam_A_118` dormant-fee [hashed-owner, rename]: rules low, shown low, p=0.0037; sim done; top: r_ctl_owner -6.776, g3_05 +0.661, g3_15 +0.592, g3_30 +0.5
- `rt-neuro_redteam_A_122` stealth [fake-renounce, split-guard, timebomb]: rules info, shown info, p=0.0003; sim done; top: r_ctl_owner -6.266, g3_30 -2.3, g3_21 +1.198, g3_05 -0.636
- `rt-neuro_redteam_A_124` seize [hashed-owner, noise, rename]: rules low, shown low, p=0.0075; sim done; top: r_ctl_owner -6.925, g3_15 +0.578, g3_05 +0.554, g3_21 +0.438
- `rt-neuro_redteam_A_132` hidden-mint [hashed-owner, rename]: rules low, shown low, p=0.0011; sim done; top: r_ctl_owner -6.266, g3_30 -2.154, g3_05 +0.875, g3_21 +0.588
