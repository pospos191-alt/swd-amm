//! Attacks on the constant-product pool (lib.rs) and the governance gate in
//! front of it. Every test plays the attacker; it passes only when the
//! program rejects the attack (or the attack gains nothing).

mod common;
use common::cp::*;
use common::*;

use anchor_lang::{prelude::Pubkey, solana_program::instruction::Instruction, InstructionData, ToAccountMetas};
use solana_sdk::{account::Account, signer::Signer};
use swd_amm::{GovernanceError, OracleError, SwdAmmError};

const M: u64 = 1_000_000; // 1 token at 6 decimals

async fn std_pool(env: &mut Env) -> CpPool {
    let cp = env.cp_pool(&CpParams::default()).await;
    env.seed_cp(&cp, 1_000 * M, 1_000 * M).await;
    cp
}

// ------------------------------------------------------------- baseline

#[tokio::test]
async fn baseline_honest_swap_and_withdraw_work() {
    let mut env = Env::new().await;
    let cp = std_pool(&mut env).await;
    let (t, ta, tb) = env.trader(&cp, 10 * M, 0).await;
    let ix = env.ix_swap_cp(&cp, &t.pubkey(), &ta, &tb, 5 * M, 1, true);
    env.send(&[ix], &[&t]).await.expect("honest swap");
    let got = env.balance(&tb).await;
    assert!(got > 4 * M && got < 5 * M, "got {got}");
}

// ------------------------------------------------- governance bootstrap

#[tokio::test]
async fn attack_frontrun_global_config_bootstrap() {
    // Fresh deploy, config not initialised yet; an outsider races the
    // deployer to make itself governance authority.
    let mut env = Env::bare().await;
    let attacker = env.wallet().await;
    let ix = env.ix_init_global_config(&attacker.pubkey(), &attacker.pubkey(), &Pubkey::new_unique());
    let r = env.send_as(&attacker, &[ix], &[]).await;
    assert_rejected_with(&r, code(GovernanceError::Unauthorized), "outsider initialises global config");

    // Same, but passing a ProgramData of a program the attacker controls
    // (loader-owned, attacker as upgrade authority) at another address.
    let fake_pd = Pubkey::new_unique();
    let mut data = 3u32.to_le_bytes().to_vec();
    data.extend_from_slice(&0u64.to_le_bytes());
    data.push(1);
    data.extend_from_slice(attacker.pubkey().as_ref());
    env.ctx.set_account(&fake_pd, &Account { lamports: 1_000_000_000, data, owner: BPF_UPGRADEABLE_LOADER, executable: false, rent_epoch: 0 }.into());
    let mut ix = env.ix_init_global_config(&attacker.pubkey(), &attacker.pubkey(), &Pubkey::new_unique());
    ix.accounts[2].pubkey = fake_pd; // program_data
    let r = env.send_as(&attacker, &[ix], &[]).await;
    assert_rejected_with(&r, code(GovernanceError::Unauthorized), "outsider initialises with its own program's ProgramData");

    // The real upgrade authority still can.
    let (g, e) = (Pubkey::new_unique(), Pubkey::new_unique());
    let ix = env.ix_init_global_config(&env.payer(), &g, &e);
    env.send(&[ix], &[]).await.expect("deployer initialises");
}

#[tokio::test]
async fn attack_reinitialise_global_config() {
    let mut env = Env::new().await;
    let ix = env.ix_init_global_config(&env.payer(), &Pubkey::new_unique(), &Pubkey::new_unique());
    let r = env.send(&[ix], &[]).await;
    assert_rejected(&r, "second initialize_global_config overwrites authorities");
}

#[tokio::test]
async fn attack_outsider_calls_governance_instructions() {
    let mut env = Env::new().await;
    let attacker = env.wallet().await;
    let mint = env.mint(6).await;
    // allowlist its own mint
    let ix = Instruction {
        program_id: swd_amm::ID,
        accounts: swd_amm::accounts::SetAllowedMint {
            config: env.config(),
            governance_authority: attacker.pubkey(),
            mint,
            allowed_mint: Env::allowed_mint_pda(&mint),
            payer: attacker.pubkey(),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: swd_amm::instruction::SetAllowedMint { enabled: true }.data(),
    };
    let r = env.send_as(&attacker, &[ix], &[]).await;
    assert_rejected_with(&r, code(GovernanceError::Unauthorized), "outsider allowlists a mint");
    // take over authorities
    let gov_only = swd_amm::accounts::GovernanceOnly { config: env.config(), governance_authority: attacker.pubkey() }.to_account_metas(None);
    let ix = Instruction {
        program_id: swd_amm::ID,
        accounts: gov_only.clone(),
        data: swd_amm::instruction::SetAuthorities { new_governance_authority: attacker.pubkey(), new_emergency_authority: Pubkey::new_unique() }.data(),
    };
    let r = env.send_as(&attacker, &[ix], &[]).await;
    assert_rejected_with(&r, code(GovernanceError::Unauthorized), "outsider rotates authorities to itself");
    let ix = Instruction { program_id: swd_amm::ID, accounts: gov_only, data: swd_amm::instruction::SetPoolCreationPaused { paused: true }.data() };
    let r = env.send_as(&attacker, &[ix], &[]).await;
    assert_rejected_with(&r, code(GovernanceError::Unauthorized), "outsider pauses pool creation");
}

#[tokio::test]
async fn attack_outsider_pauses_pool() {
    let mut env = Env::new().await;
    let cp = std_pool(&mut env).await;
    let attacker = env.wallet().await;
    let ix = Instruction {
        program_id: swd_amm::ID,
        accounts: swd_amm::accounts::EmergencyPausePool { config: env.config(), emergency_authority: attacker.pubkey(), pool: cp.pool }.to_account_metas(None),
        data: swd_amm::instruction::EmergencyPausePool { pause_swap: true, pause_deposit: true, pause_withdraw: true }.data(),
    };
    let r = env.send_as(&attacker, &[ix], &[]).await;
    assert_rejected_with(&r, code(GovernanceError::Unauthorized), "outsider freezes a pool");
}

#[tokio::test]
async fn attack_pool_with_non_allowlisted_mint_and_reinit() {
    let mut env = Env::new().await;
    let cp = std_pool(&mut env).await;
    // re-initialise the same pool (would reset reserves / steal vaults)
    let ix = env.ix_init_cp(&cp, &CpParams::default());
    let r = env.send(&[ix], &[]).await;
    assert_rejected(&r, "re-initialise an existing pool");
    // pool for a mint governance never allowlisted
    let rogue = env.mint(6).await;
    let (pool, va, vb, lp) = pdas(&cp.mint_a, &rogue);
    let fake = CpPool { mint_b: rogue, pool, vault_a: va, vault_b: vb, lp_mint: lp, ..cp };
    let ix = env.ix_init_cp(&fake, &CpParams::default());
    let r = env.send(&[ix], &[]).await;
    assert_rejected(&r, "pool with a non-allowlisted mint");
}

// ---------------------------------------------------- account spoofing

#[tokio::test]
async fn attack_swap_with_substituted_vault() {
    let mut env = Env::new().await;
    let cp = std_pool(&mut env).await;
    let (t, ta, tb) = env.trader(&cp, 10 * M, 0).await;
    // attacker's own token account in place of the pool's vault_b
    let fake_vault = env.fund(&t.pubkey(), &cp.mint_b, 0).await;
    let mut ix = env.ix_swap_cp(&cp, &t.pubkey(), &ta, &tb, 5 * M, 0, true);
    ix.accounts[3].pubkey = fake_vault; // vault_b
    let r = env.send(&[ix], &[&t]).await;
    assert_rejected(&r, "swap against a substituted vault");
}

#[tokio::test]
async fn attack_swap_mixing_two_pools() {
    let mut env = Env::new().await;
    let cp1 = std_pool(&mut env).await;
    let cp2 = std_pool(&mut env).await;
    let (t, ta, tb) = env.trader(&cp1, 10 * M, 0).await;
    // pool 1's account but pool 2's vaults
    let mut ix = env.ix_swap_cp(&cp1, &t.pubkey(), &ta, &tb, 5 * M, 0, true);
    ix.accounts[2].pubkey = cp2.vault_a;
    ix.accounts[3].pubkey = cp2.vault_b;
    let r = env.send(&[ix], &[&t]).await;
    assert_rejected(&r, "swap with another pool's vaults");
}

#[tokio::test]
async fn attack_spend_victims_tokens() {
    let mut env = Env::new().await;
    let cp = std_pool(&mut env).await;
    let (_victim, victim_a, _vb) = env.trader(&cp, 100 * M, 0).await;
    let (att, _aa, att_b) = env.trader(&cp, 0, 0).await;
    // swap paid from the victim's account, output to the attacker
    let ix = env.ix_swap_cp(&cp, &att.pubkey(), &victim_a, &att_b, 50 * M, 0, true);
    let r = env.send(&[ix], &[&att]).await;
    assert_rejected_with(&r, code(SwdAmmError::InvalidTokenAccountOwner), "swap paid with the victim's tokens");
    // deposit paid from the victim's accounts
    let (_v2, va2, vb2) = env.trader(&cp, 100 * M, 100 * M).await;
    let ix = env.ix_add_cp(&cp, &att.pubkey(), &va2, &vb2, 10 * M, 10 * M, 0);
    let r = env.send(&[ix], &[&att]).await;
    assert_rejected(&r, "deposit paid with the victim's tokens");
}

#[tokio::test]
async fn attack_withdraw_with_victims_lp() {
    let mut env = Env::new().await;
    let cp = std_pool(&mut env).await;
    let (victim, va, vb) = env.trader(&cp, 100 * M, 100 * M).await;
    let ix = env.ix_add_cp(&cp, &victim.pubkey(), &va, &vb, 100 * M, 100 * M, 0);
    env.send(&[ix], &[&victim]).await.unwrap();
    let victim_lp = Env::ata(&victim.pubkey(), &cp.lp_mint);
    let lp = env.balance(&victim_lp).await;
    let (att, aa, ab) = env.trader(&cp, 0, 0).await;
    let ix = env.ix_remove_cp(&cp, &att.pubkey(), &victim_lp, &aa, &ab, lp, 0, 0);
    let r = env.send(&[ix], &[&att]).await;
    assert_rejected(&r, "burn the victim's LP to the attacker");
    assert_eq!(env.balance(&victim_lp).await, lp);
}

#[tokio::test]
async fn attack_withdraw_more_lp_than_owned() {
    let mut env = Env::new().await;
    let cp = env.cp_pool(&CpParams::default()).await;
    let (lp, ta, tb) = env.seed_cp(&cp, 100 * M, 100 * M).await;
    let lp_acc = Env::ata(&lp.pubkey(), &cp.lp_mint);
    let have = env.balance(&lp_acc).await;
    let ix = env.ix_remove_cp(&cp, &lp.pubkey(), &lp_acc, &ta, &tb, have + 1, 0, 0);
    let r = env.send(&[ix], &[&lp]).await;
    assert_rejected(&r, "remove more LP than owned");
    // everything it owns comes out, the locked MINIMUM_LIQUIDITY stays
    let ix = env.ix_remove_cp(&cp, &lp.pubkey(), &lp_acc, &ta, &tb, have, 0, 0);
    env.send(&[ix], &[&lp]).await.unwrap();
    let (ra, rb) = env.reserves(&cp).await;
    assert!(ra > 0 && rb > 0, "pool emptied below the locked minimum");
}

// --------------------------------------------------------- economics

#[tokio::test]
async fn attack_rounding_drain_with_dust_swaps() {
    // Cheap 9-decimal token A ($0.001) against an expensive 6-decimal token
    // B ($1000): one raw B is worth 1e9 raw A. If the payout rounds up, a
    // 2-raw-unit swap pays out 1 whole raw B — repeat many times per tx.
    let mut env = Env::new().await;
    let p = CpParams { dec_a: 9, dec_b: 6, usd_a_e8: 100_000, usd_b_e8: 100_000_000_000, ..Default::default() };
    let cp = env.cp_pool(&p).await;
    env.seed_cp(&cp, 2_000_000_000_000_000, 2 * M).await; // $2000 per side
    let (att, ta, tb) = env.trader(&cp, 1_000, 0).await;
    let ixs: Vec<Instruction> = (0..20).map(|_| env.ix_swap_cp(&cp, &att.pubkey(), &ta, &tb, 2, 0, true)).collect();
    let r = env.send(&ixs, &[&att]).await;
    let spent_a = 1_000 - env.balance(&ta).await;
    let got_b = env.balance(&tb).await;
    // value in raw-A units: 1 raw B = 1e9 raw A
    let value_out = got_b as u128 * 1_000_000_000;
    assert!(
        r.is_err() || value_out <= spent_a as u128,
        "ATTACK SUCCEEDED: paid {spent_a} raw A (~$2e-12 each), received {got_b} raw B (~$0.001 each)"
    );
}

#[tokio::test]
async fn attack_donation_does_not_move_price_or_steal_from_next_lp() {
    // Classic first-depositor inflation: seed the minimum, donate straight
    // into the vaults, hope the next depositor's shares round to nothing.
    let mut env = Env::new().await;
    let cp = env.cp_pool(&CpParams::default()).await;
    let (att, ata_a, ata_b) = env.trader(&cp, 2_000 * M, 2_000 * M).await;
    let ix = env.ix_add_cp(&cp, &att.pubkey(), &ata_a, &ata_b, M, M, 0);
    env.send(&[ix], &[&att]).await.unwrap();
    let before = env.reserves(&cp).await;
    let donate = [
        spl_token::instruction::transfer(&spl_token::ID, &ata_a, &cp.vault_a, &att.pubkey(), &[], 1_000 * M).unwrap(),
        spl_token::instruction::transfer(&spl_token::ID, &ata_b, &cp.vault_b, &att.pubkey(), &[], 1_000 * M).unwrap(),
    ];
    env.send(&donate, &[&att]).await.unwrap();
    assert_eq!(env.reserves(&cp).await, before, "a donation changed the tracked reserves");
    // victim deposits and immediately withdraws: gets (almost) all back
    let (victim, va, vb) = env.trader(&cp, 100 * M, 100 * M).await;
    let ix = env.ix_add_cp(&cp, &victim.pubkey(), &va, &vb, 100 * M, 100 * M, 1);
    env.send(&[ix], &[&victim]).await.expect("victim deposit");
    let vlp = Env::ata(&victim.pubkey(), &cp.lp_mint);
    let lp = env.balance(&vlp).await;
    let ix = env.ix_remove_cp(&cp, &victim.pubkey(), &vlp, &va, &vb, lp, 0, 0);
    env.send(&[ix], &[&victim]).await.unwrap();
    let (ga, gb) = (env.balance(&va).await, env.balance(&vb).await);
    assert!(ga >= 100 * M - 2 && gb >= 100 * M - 2, "victim lost value to the donation: {ga} / {gb}");
}

#[tokio::test]
async fn attack_sandwich_is_bounded_by_min_out() {
    let mut env = Env::new().await;
    let cp = std_pool(&mut env).await;
    let (victim, va, vb) = env.trader(&cp, 10 * M, 0).await;
    let (att, aa, ab) = env.trader(&cp, 15 * M, 0).await;
    // victim's quote at the current price, with 0.5% slippage tolerance
    let (ra, rb) = env.reserves(&cp).await;
    let in_net = 10 * M as u128 * 9_970 / 10_000;
    let quote = (rb as u128 * in_net / (ra as u128 + in_net)) as u64;
    let min_out = quote * 995 / 1000;
    // attacker front-runs in the same direction (~3% price move, inside
    // the 5% oracle guard)
    let ix = env.ix_swap_cp(&cp, &att.pubkey(), &aa, &ab, 15 * M, 0, true);
    env.send(&[ix], &[&att]).await.unwrap();
    let ix = env.ix_swap_cp(&cp, &victim.pubkey(), &va, &vb, 10 * M, min_out, true);
    let r = env.send(&[ix], &[&victim]).await;
    assert_rejected_with(&r, code(SwdAmmError::SlippageExceeded), "sandwiched victim filled below min_out");
    assert_eq!(env.balance(&va).await, 10 * M, "victim paid anyway");
}

#[tokio::test]
async fn attack_price_manipulation_beyond_oracle_guard() {
    // pool price may not be pushed more than oracle_max_deviation (5%)
    // away from the Pyth price, whatever the attacker's budget
    let mut env = Env::new().await;
    let cp = std_pool(&mut env).await;
    let (att, aa, ab) = env.trader(&cp, 200 * M, 0).await;
    let ix = env.ix_swap_cp(&cp, &att.pubkey(), &aa, &ab, 200 * M, 0, true);
    let r = env.send(&[ix], &[&att]).await;
    assert_rejected(&r, "push the pool price 20%+ away from the oracle");
    assert_eq!(env.balance(&aa).await, 200 * M);
}

#[tokio::test]
async fn attack_overflow_amounts() {
    let mut env = Env::new().await;
    let cp = std_pool(&mut env).await;
    let (att, aa, ab) = env.trader(&cp, u64::MAX - 2_000 * M, 0).await;
    let before = env.reserves(&cp).await;
    let ix = env.ix_swap_cp(&cp, &att.pubkey(), &aa, &ab, u64::MAX - 2_000 * M, 0, true);
    let r = env.send(&[ix], &[&att]).await;
    assert_rejected(&r, "u64::MAX-sized swap");
    let ix = env.ix_add_cp(&cp, &att.pubkey(), &aa, &ab, u64::MAX - 2_000 * M, u64::MAX, 0);
    let r = env.send(&[ix], &[&att]).await;
    assert_rejected(&r, "u64::MAX-sized deposit");
    assert_eq!(env.reserves(&cp).await, before);
}

#[tokio::test]
async fn attack_zero_amounts() {
    let mut env = Env::new().await;
    let cp = std_pool(&mut env).await;
    let (att, aa, ab) = env.trader(&cp, 10 * M, 10 * M).await;
    let r = { let ix = env.ix_swap_cp(&cp, &att.pubkey(), &aa, &ab, 0, 0, true); env.send(&[ix], &[&att]).await };
    assert_rejected_with(&r, code(SwdAmmError::ZeroAmount), "zero-input swap");
    let r = { let ix = env.ix_swap_cp(&cp, &att.pubkey(), &aa, &ab, 1, 0, true); env.send(&[ix], &[&att]).await };
    assert_rejected(&r, "1-raw-unit swap that rounds to zero output after the fee");
}

// ------------------------------------------------------------- oracle

async fn swap_with_prices(env: &mut Env, cp: &CpPool, a: Pubkey, b: Pubkey) -> Result<(), solana_program_test::BanksClientError> {
    let (t, ta, tb) = env.trader(cp, 10 * M, 0).await;
    let mut ix = env.ix_swap_cp(cp, &t.pubkey(), &ta, &tb, M, 0, true);
    ix.accounts[10].pubkey = a; // price_update_a
    ix.accounts[11].pubkey = b; // price_update_b
    env.send(&[ix], &[&t]).await
}

#[tokio::test]
async fn attack_oracle_spoofing() {
    let mut env = Env::new().await;
    let cp = std_pool(&mut env).await;
    let now = env.now().await;

    // forged account with the right layout, owned by the attacker's program
    let forged = Pubkey::new_unique();
    env.set_price_raw(&forged, cp.feed_a, 100_000_000, -8, now, true, Pubkey::new_unique());
    let r = swap_with_prices(&mut env, &cp, forged, cp.price_b).await;
    assert_rejected(&r, "price account not owned by the Pyth receiver");

    // genuine owner, but only partially verified
    let partial = Pubkey::new_unique();
    env.set_price_raw(&partial, cp.feed_a, 100_000_000, -8, now, false, PYTH_RECEIVER);
    let r = swap_with_prices(&mut env, &cp, partial, cp.price_b).await;
    assert_rejected_with(&r, code(OracleError::PriceVerificationNotFull), "partially verified price");

    // a real update for some other asset
    let other = Pubkey::new_unique();
    env.set_price_raw(&other, feed_id(99), 100_000_000, -8, now, true, PYTH_RECEIVER);
    let r = swap_with_prices(&mut env, &cp, other, cp.price_b).await;
    assert_rejected_with(&r, code(OracleError::PriceFeedMismatch), "price of another asset");

    // A and B swapped
    let r = swap_with_prices(&mut env, &cp, cp.price_b, cp.price_a).await;
    assert_rejected_with(&r, code(OracleError::PriceFeedMismatch), "A/B price accounts swapped");

    // stale
    let stale = Pubkey::new_unique();
    env.set_price_raw(&stale, cp.feed_a, 100_000_000, -8, now - 10_000, true, PYTH_RECEIVER);
    let r = swap_with_prices(&mut env, &cp, stale, cp.price_b).await;
    assert_rejected_with(&r, code(OracleError::PriceTooStale), "stale price");
}

#[tokio::test]
async fn attack_trade_while_oracle_disagrees() {
    // the market moved 20% (oracle) but the pool did not: arbitrage that
    // would leave the pool even further from the oracle is refused
    let mut env = Env::new().await;
    let cp = std_pool(&mut env).await;
    env.set_price(&cp.price_a.clone(), cp.feed_a, 120_000_000, -8).await;
    let (t, ta, tb) = env.trader(&cp, 10 * M, 0).await;
    let ix = env.ix_swap_cp(&cp, &t.pubkey(), &ta, &tb, M, 0, true); // sells A: pool price of A drops further
    let r = env.send(&[ix], &[&t]).await;
    assert_rejected(&r, "trade that widens a 20% oracle gap");
}

// -------------------------------------------------------------- pause

#[tokio::test]
async fn attack_trade_while_paused() {
    let mut env = Env::new().await;
    let cp = std_pool(&mut env).await;
    let em = env.emergency.insecure_clone();
    env.airdrop(&em.pubkey(), 1_000_000_000).await;
    let ix = Instruction {
        program_id: swd_amm::ID,
        accounts: swd_amm::accounts::EmergencyPausePool { config: env.config(), emergency_authority: em.pubkey(), pool: cp.pool }.to_account_metas(None),
        data: swd_amm::instruction::EmergencyPausePool { pause_swap: true, pause_deposit: true, pause_withdraw: false }.data(),
    };
    env.send(&[ix], &[&em]).await.expect("emergency pause");
    let (t, ta, tb) = env.trader(&cp, 10 * M, 10 * M).await;
    let r = { let ix = env.ix_swap_cp(&cp, &t.pubkey(), &ta, &tb, M, 0, true); env.send(&[ix], &[&t]).await };
    assert_rejected_with(&r, code(SwdAmmError::SwapPaused), "swap on a paused pool");
    let r = { let ix = env.ix_add_cp(&cp, &t.pubkey(), &ta, &tb, M, M, 0); env.send(&[ix], &[&t]).await };
    assert_rejected_with(&r, code(SwdAmmError::DepositPaused), "deposit on a paused pool");
    // the emergency key cannot unpause by itself (needs the timelock)
    let ix = Instruction {
        program_id: swd_amm::ID,
        accounts: swd_amm::accounts::GovernancePausePool { config: env.config(), governance_authority: em.pubkey(), pool: cp.pool }.to_account_metas(None),
        data: swd_amm::instruction::GovernedUnpausePool { unpause_swap: true, unpause_deposit: true, unpause_withdraw: true }.data(),
    };
    let r = env.send(&[ix], &[&em]).await;
    assert_rejected(&r, "emergency key unpauses");
}
