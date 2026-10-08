//! Attacks on the 2026-10-08 hardening: oracle feeds bound to mints,
//! oracle confidence, the SWDMM v2 per-slot impact cap, owner-bound v2
//! position addresses and distinct error-code ranges.

mod common;
use common::cp::*;
use common::v2::*;
use common::*;

use anchor_lang::prelude::Pubkey;
use solana_sdk::{account::Account, signer::Signer};
use swd_amm::{DlmmError, GovernanceError, OracleError, SwdAmmError, SwdmmV2Error, TimelockError};

const M: u64 = 1_000_000;

#[tokio::test]
async fn attack_pool_bound_to_the_wrong_oracle_feed() {
    let mut env = Env::new().await;
    let mint_a = env.mint(6).await;
    let mint_b = env.mint(6).await;
    env.allow_mint(&mint_a).await;
    env.allow_mint(&mint_b).await;
    let (pool, vault_a, vault_b, lp_mint) = pdas(&mint_a, &mint_b);
    let cp = CpPool { mint_a, mint_b, dec_a: 6, dec_b: 6, pool, vault_a, vault_b, lp_mint, price_a: Pubkey::new_unique(), price_b: Pubkey::new_unique(), feed_a: feed_id(1), feed_b: feed_id(2) };

    // no feed registered yet: creation is impossible
    let r = { let ix = env.ix_init_cp(&cp, &CpParams::default()); env.send(&[ix], &[]).await };
    assert_rejected(&r, "pool for mints with no registered feed");

    // governance registers the real feeds; a squatter names other ones
    env.register_feed(&mint_a, feed_id(1)).await;
    env.register_feed(&mint_b, feed_id(2)).await;
    let squat = CpPool { feed_a: feed_id(66), ..cp };
    let r = { let ix = env.ix_init_cp(&squat, &CpParams::default()); env.send(&[ix], &[]).await };
    assert_rejected_with(&r, code(SwdAmmError::OracleFeedNotRegistered), "pool squatted with another asset's feed");

    // the right feeds work
    let ok = CpPool { feed_a: feed_id(1), ..squat };
    let ix = env.ix_init_cp(&ok, &CpParams::default());
    env.send(&[ix], &[]).await.expect("pool with the registered feeds");
}

#[tokio::test]
async fn attack_outsider_registers_a_feed() {
    let mut env = Env::new().await;
    let att = env.wallet().await;
    let mint = env.mint(6).await;
    let ix = env.ix_set_mint_feed(&att.pubkey(), &mint, feed_id(9));
    let r = env.send_as(&att, &[ix], &[]).await;
    assert_rejected_with(&r, code(GovernanceError::Unauthorized), "outsider sets a mint's feed");
    let gov = env.gov.insecure_clone();
    let ix = env.ix_set_mint_feed(&gov.pubkey(), &mint, [0; 32]);
    let r = env.send(&[ix], &[&gov]).await;
    assert_rejected_with(&r, code(GovernanceError::InvalidFeedId), "all-zero feed id");
}

#[tokio::test]
async fn attack_trade_on_a_low_confidence_price() {
    let mut env = Env::new().await;
    let cp = env.cp_pool(&CpParams::default()).await;
    env.seed_cp(&cp, 1_000 * M, 1_000 * M).await;
    // genuine, fresh, fully verified update — but conf = 10% of the price
    let now = env.now().await;
    let mut d = Vec::new();
    d.extend_from_slice(&[34, 241, 35, 99, 157, 126, 244, 205]);
    d.extend_from_slice(Pubkey::new_unique().as_ref());
    d.push(1);
    d.extend_from_slice(&cp.feed_a);
    d.extend_from_slice(&100_000_000i64.to_le_bytes());
    d.extend_from_slice(&10_000_000u64.to_le_bytes()); // conf
    d.extend_from_slice(&(-8i32).to_le_bytes());
    d.extend_from_slice(&now.to_le_bytes());
    d.extend_from_slice(&(now - 1).to_le_bytes());
    d.extend_from_slice(&100_000_000i64.to_le_bytes());
    d.extend_from_slice(&10_000_000u64.to_le_bytes());
    d.extend_from_slice(&1u64.to_le_bytes());
    env.ctx.set_account(&cp.price_a, &Account { lamports: 10_000_000, data: d, owner: PYTH_RECEIVER, executable: false, rent_epoch: 0 }.into());
    let (t, ta, tb) = env.trader(&cp, 10 * M, 0).await;
    let ix = env.ix_swap_cp(&cp, &t.pubkey(), &ta, &tb, M, 0, true);
    let r = env.send(&[ix], &[&t]).await;
    assert_rejected_with(&r, code(OracleError::PriceConfidenceTooWide), "swap priced off a 10%-wide confidence interval");
}

async fn v2_seeded(env: &mut Env) -> (V2, solana_sdk::signature::Keypair) {
    env.init_gov_settings(&Pubkey::new_unique()).await;
    let lp = env.wallet().await;
    let v = env.v2_pool(&lp, fixed_fee_params(100, 0)).await;
    let la = env.fund(&lp.pubkey(), &v.mint_a, 1_000 * M).await;
    let lb = env.fund(&lp.pubkey(), &v.mint_b, 1_000 * M).await;
    let pos = env.v2_new_position(&v, &lp).await;
    let ix = env.ix_v2_add(&v, &lp.pubkey(), &pos, &la, &lb, 1_000 * M, 1_000 * M);
    env.send(&[ix], &[&lp]).await.unwrap();
    (v, lp)
}

#[tokio::test]
async fn attack_split_one_big_trade_into_many_swaps_in_one_tx() {
    let mut env = Env::new().await;
    let (v, _) = v2_seeded(&mut env).await;
    let (t, ta, tb) = env.v2_wallet(&v, 2_000 * M, 0).await;
    // each swap alone is inside the 50% cap; together they are far outside
    let ixs: Vec<_> = (0..3).map(|_| env.ix_v2_swap(&v, &t.pubkey(), &ta, &tb, 400 * M, 0, true)).collect();
    let r = env.send(&ixs, &[&t]).await;
    assert_rejected_with(&r, code(SwdmmV2Error::PriceImpactTooHigh), "3 swaps in one tx past the per-swap cap");
    // one of them alone is fine, and trading back in the same slot too
    let ixs = vec![env.ix_v2_swap(&v, &t.pubkey(), &ta, &tb, 400 * M, 0, true), env.ix_v2_swap(&v, &t.pubkey(), &ta, &tb, 100 * M, 0, false)];
    env.send(&ixs, &[&t]).await.expect("one capped swap, then a swap back");
}

#[tokio::test]
async fn attack_squat_someone_elses_v2_position_address() {
    let mut env = Env::new().await;
    let (v, _) = v2_seeded(&mut env).await;
    let victim = env.wallet().await;
    let att = env.wallet().await;
    // the address the victim is about to create
    let victim_pos = v2_position_pda(&v.pool, swd_amm::v2_position_index(&victim.pubkey(), 0));
    for nonce in [0u64, 1, 7] {
        let ix = env.ix_v2_create_position(&v, &att.pubkey(), &victim_pos, nonce);
        let r = env.send(&[ix], &[&att]).await;
        assert_rejected(&r, "attacker creates the victim's position address first");
    }
    // spamming its own positions doesn't get in the victim's way either
    for nonce in 0..3u64 {
        let p = v2_position_pda(&v.pool, swd_amm::v2_position_index(&att.pubkey(), nonce));
        let ix = env.ix_v2_create_position(&v, &att.pubkey(), &p, nonce);
        env.send(&[ix], &[&att]).await.unwrap();
    }
    let ix = env.ix_v2_create_position(&v, &victim.pubkey(), &victim_pos, 0);
    env.send(&[ix], &[&victim]).await.expect("victim's create still works");
    assert_eq!(env.v2_position_state(&victim_pos).await.owner, victim.pubkey());
}

#[tokio::test]
async fn attack_v2_oracle_pool_with_unregistered_feeds() {
    let mut env = Env::new().await;
    env.init_gov_settings(&Pubkey::new_unique()).await;
    let lp = env.wallet().await;
    let mut params = fixed_fee_params(100, 0);
    params.oracle = swd_amm::OracleGuardParams { enabled: true, pyth_feed_id_a: feed_id(41), pyth_feed_id_b: feed_id(42), max_staleness_secs: 300, max_deviation_bps: 500 };
    let mint_a = env.mint(6).await;
    let mint_b = env.mint(6).await;
    env.set_mint_policy(&mint_a).await;
    env.set_mint_policy(&mint_b).await;
    let pool = Pubkey::find_program_address(&[b"swdmm_v2_pool", mint_a.as_ref(), mint_b.as_ref(), &100u16.to_le_bytes()], &swd_amm::ID).0;
    let vault_a = Pubkey::find_program_address(&[b"swdmm_v2_vault", pool.as_ref(), mint_a.as_ref()], &swd_amm::ID).0;
    let vault_b = Pubkey::find_program_address(&[b"swdmm_v2_vault", pool.as_ref(), mint_b.as_ref()], &swd_amm::ID).0;
    let v = V2 { mint_a, mint_b, pool, vault_a, vault_b, floor_fee: 100 };
    let ix = env.ix_init_v2(&lp.pubkey(), &v, params);
    let r = env.send(&[ix], &[&lp]).await;
    assert_rejected_with(&r, code(SwdmmV2Error::OracleFeedNotRegistered), "v2 oracle pool with feeds governance never registered");
}

#[test]
fn error_codes_no_longer_collide() {
    let ranges = [
        (code(SwdAmmError::FeeTooHigh), 6000, 6100),
        (code(DlmmError::InsufficientShares), 6100, 6200),
        (code(GovernanceError::Unauthorized), 6200, 6300),
        (code(OracleError::PriceTooStale), 6300, 6400),
        (code(SwdmmV2Error::NotActivated), 8000, 8500),
        (code(TimelockError::ActionNotPending), 8500, 9000),
    ];
    for (c, lo, hi) in ranges {
        assert!(c >= lo && c < hi, "error code {c} outside {lo}..{hi}");
    }
}
