//! Attacks on SWDMM v2 pools (swdmm_v2.rs) and the governance timelock
//! (timelock.rs).

mod common;
use common::v2::*;
use common::*;

use anchor_lang::prelude::Pubkey;
use solana_sdk::{signature::Keypair, signer::Signer};
use swd_amm::{GovAction, GovernanceError, SwdmmV2Error, TimelockError};

const M: u64 = 1_000_000;

struct Setup {
    env: Env,
    v: V2,
    lp: Keypair,
    lp_pos: Pubkey,
    lp_a: Pubkey,
    lp_b: Pubkey,
    treasury: Keypair,
}

/// 1% fixed-fee pool, 1000:1000 seeded by its creator.
async fn setup() -> Setup {
    let mut env = Env::new().await;
    let treasury = Keypair::new();
    env.init_gov_settings(&treasury.pubkey()).await;
    let lp = env.wallet().await;
    let v = env.v2_pool(&lp, fixed_fee_params(100, 0)).await;
    let lp_a = env.fund(&lp.pubkey(), &v.mint_a, 2_000 * M).await;
    let lp_b = env.fund(&lp.pubkey(), &v.mint_b, 2_000 * M).await;
    let lp_pos = env.v2_new_position(&v, &lp).await;
    let ix = env.ix_v2_add(&v, &lp.pubkey(), &lp_pos, &lp_a, &lp_b, 1_000 * M, 1_000 * M);
    env.send(&[ix], &[&lp]).await.expect("creator's first deposit");
    Setup { env, v, lp, lp_pos, lp_a, lp_b, treasury }
}

#[tokio::test]
async fn baseline_honest_v2_flow_works() {
    let mut s = setup().await;
    let (t, ta, tb) = s.env.v2_wallet(&s.v, 10 * M, 0).await;
    let ix = s.env.ix_v2_swap(&s.v, &t.pubkey(), &ta, &tb, 5 * M, 1, true);
    s.env.send(&[ix], &[&t]).await.expect("honest swap");
    assert!(s.env.balance(&tb).await > 4 * M);
    let ix = s.env.ix_v2_claim(&s.v, &s.lp.pubkey(), &s.lp_pos, &s.lp_a, &s.lp_b);
    s.env.send(&[ix], &[&s.lp]).await.expect("LP claims fees");
}

#[tokio::test]
async fn attack_take_over_someone_elses_position() {
    let mut s = setup().await;
    let (att, aa, ab) = s.env.v2_wallet(&s.v, 0, 0).await;
    let pos = s.lp_pos;
    let cases = [
        ("withdraw", s.env.ix_v2_remove(&s.v, &att.pubkey(), &pos, &aa, &ab, 1)),
        ("claim fees", s.env.ix_v2_claim(&s.v, &att.pubkey(), &pos, &aa, &ab)),
        ("lock", s.env.ix_v2_lock(&s.v, &att.pubkey(), &pos, 1)),
        ("transfer to self", s.env.ix_v2_transfer(&att.pubkey(), &pos, &att.pubkey())),
        ("close", s.env.ix_v2_close(&s.v, &att.pubkey(), &pos)),
    ];
    for (what, ix) in cases {
        let r = s.env.send(&[ix], &[&att]).await;
        assert_rejected_with(&r, code(SwdmmV2Error::NotPositionOwner), &format!("{what} on the victim's position"));
    }
    assert_eq!(s.env.v2_position_state(&pos).await.owner, s.lp.pubkey());
}

#[tokio::test]
async fn attack_non_creator_sets_first_price() {
    let mut env = Env::new().await;
    env.init_gov_settings(&Pubkey::new_unique()).await;
    let creator = env.wallet().await;
    let v = env.v2_pool(&creator, fixed_fee_params(100, 0)).await;
    let (att, aa, ab) = env.v2_wallet(&v, 10 * M, 1_000 * M).await;
    let pos = env.v2_new_position(&v, &att).await;
    let ix = env.ix_v2_add(&v, &att.pubkey(), &pos, &aa, &ab, 10 * M, 1_000 * M);
    let r = env.send(&[ix], &[&att]).await;
    assert_rejected_with(&r, code(SwdmmV2Error::OnlyCreatorFirstDeposit), "outsider seeds the pool at a skewed price");
}

#[tokio::test]
async fn attack_swap_with_substituted_vault() {
    let mut s = setup().await;
    let (t, ta, tb) = s.env.v2_wallet(&s.v, 10 * M, 0).await;
    let fake = s.env.fund(&t.pubkey(), &s.v.mint_b, 0).await;
    let mut ix = s.env.ix_v2_swap(&s.v, &t.pubkey(), &ta, &tb, 5 * M, 0, true);
    ix.accounts[6].pubkey = fake; // vault_b
    let r = s.env.send(&[ix], &[&t]).await;
    assert_rejected(&r, "swap against a substituted vault");
}

#[tokio::test]
async fn attack_claim_fees_twice_or_from_before_deposit() {
    let mut s = setup().await;
    let (t, ta, tb) = s.env.v2_wallet(&s.v, 50 * M, 0).await;
    let ix = s.env.ix_v2_swap(&s.v, &t.pubkey(), &ta, &tb, 20 * M, 0, true);
    s.env.send(&[ix], &[&t]).await.unwrap();
    // a newcomer deposits AFTER the fees were earned
    let (late, la, lb) = s.env.v2_wallet(&s.v, 500 * M, 500 * M).await;
    let pos = s.env.v2_new_position(&s.v, &late).await;
    let ix = s.env.ix_v2_add(&s.v, &late.pubkey(), &pos, &la, &lb, 500 * M, 500 * M);
    s.env.send(&[ix], &[&late]).await.unwrap();
    let (a0, b0) = (s.env.balance(&la).await, s.env.balance(&lb).await);
    let ix = s.env.ix_v2_claim(&s.v, &late.pubkey(), &pos, &la, &lb);
    s.env.send(&[ix], &[&late]).await.unwrap();
    assert_eq!((s.env.balance(&la).await, s.env.balance(&lb).await), (a0, b0), "newcomer collected fees earned before its deposit");
    // the LP claims, then claims again
    let ix = s.env.ix_v2_claim(&s.v, &s.lp.pubkey(), &s.lp_pos, &s.lp_a, &s.lp_b);
    s.env.send(&[ix], &[&s.lp]).await.unwrap();
    let after_first = s.env.balance(&s.lp_a).await;
    s.env.warp_seconds(1).await;
    let ix = s.env.ix_v2_claim(&s.v, &s.lp.pubkey(), &s.lp_pos, &s.lp_a, &s.lp_b);
    let _ = s.env.send(&[ix], &[&s.lp]).await;
    assert_eq!(s.env.balance(&s.lp_a).await, after_first, "fees paid out twice");
}

#[tokio::test]
async fn attack_unlock_locked_liquidity() {
    let mut s = setup().await;
    let liq = s.env.v2_position_state(&s.lp_pos).await.liquidity;
    let ix = s.env.ix_v2_lock(&s.v, &s.lp.pubkey(), &s.lp_pos, liq);
    s.env.send(&[ix], &[&s.lp]).await.expect("lock everything");
    let r = { let ix = s.env.ix_v2_remove(&s.v, &s.lp.pubkey(), &s.lp_pos, &s.lp_a, &s.lp_b, 1); s.env.send(&[ix], &[&s.lp]).await };
    assert_rejected_with(&r, code(SwdmmV2Error::InsufficientLiquidity), "withdraw permanently locked liquidity");
    let r = { let ix = s.env.ix_v2_close(&s.v, &s.lp.pubkey(), &s.lp_pos); s.env.send(&[ix], &[&s.lp]).await };
    assert_rejected_with(&r, code(SwdmmV2Error::PositionNotEmpty), "close a position that still holds locked liquidity");
}

#[tokio::test]
async fn attack_trade_before_activation() {
    let mut env = Env::new().await;
    env.init_gov_settings(&Pubkey::new_unique()).await;
    let creator = env.wallet().await;
    let start = env.now().await + 3_600;
    let v = env.v2_pool(&creator, fixed_fee_params(100, start)).await;
    let ca = env.fund(&creator.pubkey(), &v.mint_a, 100 * M).await;
    let cb = env.fund(&creator.pubkey(), &v.mint_b, 100 * M).await;
    let pos = env.v2_new_position(&v, &creator).await;
    let ix = env.ix_v2_add(&v, &creator.pubkey(), &pos, &ca, &cb, 100 * M, 100 * M);
    env.send(&[ix], &[&creator]).await.unwrap();
    let (sniper, sa, sb) = env.v2_wallet(&v, 10 * M, 0).await;
    let ix = env.ix_v2_swap(&v, &sniper.pubkey(), &sa, &sb, M, 0, true);
    let r = env.send(&[ix], &[&sniper]).await;
    assert_rejected_with(&r, code(SwdmmV2Error::NotActivated), "snipe before the launch time");
}

#[tokio::test]
async fn attack_single_swap_beyond_impact_cap() {
    let mut s = setup().await;
    let (t, ta, tb) = s.env.v2_wallet(&s.v, 5_000 * M, 0).await;
    let ix = s.env.ix_v2_swap(&s.v, &t.pubkey(), &ta, &tb, 5_000 * M, 0, true);
    let r = s.env.send(&[ix], &[&t]).await;
    assert_rejected(&r, "one swap 5x the pool's reserve");
}

#[tokio::test]
async fn attack_dust_round_trips_gain_nothing() {
    let mut s = setup().await;
    let (t, ta, tb) = s.env.v2_wallet(&s.v, 1_000, 1_000).await;
    let ixs: Vec<_> = (0..20)
        .map(|i| if i % 2 == 0 { s.env.ix_v2_swap(&s.v, &t.pubkey(), &ta, &tb, 3, 0, true) } else { s.env.ix_v2_swap(&s.v, &t.pubkey(), &ta, &tb, 3, 0, false) })
        .collect();
    let r = s.env.send(&ixs, &[&t]).await;
    let total = s.env.balance(&ta).await + s.env.balance(&tb).await;
    assert!(r.is_err() || total <= 2_000, "ATTACK SUCCEEDED: dust round trips grew 2000 -> {total}");
}

#[tokio::test]
async fn attack_bypass_pause_including_fee_claims() {
    let mut s = setup().await;
    let em = s.env.emergency.insecure_clone();
    s.env.airdrop(&em.pubkey(), 1_000_000_000).await;
    // an outsider cannot pause
    let (att, ..) = s.env.v2_wallet(&s.v, 0, 0).await;
    let r = { let ix = s.env.ix_v2_pause(&s.v, &att.pubkey(), true, true, true); s.env.send(&[ix], &[&att]).await };
    assert_rejected_with(&r, code(GovernanceError::Unauthorized), "outsider pauses a v2 pool");
    // earn some fees, then the emergency key pauses everything
    let (t, ta, tb) = s.env.v2_wallet(&s.v, 50 * M, 0).await;
    let ix = s.env.ix_v2_swap(&s.v, &t.pubkey(), &ta, &tb, 20 * M, 0, true);
    s.env.send(&[ix], &[&t]).await.unwrap();
    let ix = s.env.ix_v2_pause(&s.v, &em.pubkey(), true, true, true);
    s.env.send(&[ix], &[&em]).await.expect("emergency pause");
    let r = { let ix = s.env.ix_v2_swap(&s.v, &t.pubkey(), &ta, &tb, M, 0, true); s.env.send(&[ix], &[&t]).await };
    assert_rejected_with(&r, code(SwdmmV2Error::SwapPaused), "swap on a paused pool");
    let r = { let ix = s.env.ix_v2_add(&s.v, &s.lp.pubkey(), &s.lp_pos, &s.lp_a, &s.lp_b, M, M); s.env.send(&[ix], &[&s.lp]).await };
    assert_rejected_with(&r, code(SwdmmV2Error::DepositPaused), "deposit on a paused pool");
    let r = { let ix = s.env.ix_v2_remove(&s.v, &s.lp.pubkey(), &s.lp_pos, &s.lp_a, &s.lp_b, 1); s.env.send(&[ix], &[&s.lp]).await };
    assert_rejected_with(&r, code(SwdmmV2Error::WithdrawPaused), "withdraw on a paused pool");
    let r = { let ix = s.env.ix_v2_claim(&s.v, &s.lp.pubkey(), &s.lp_pos, &s.lp_a, &s.lp_b); s.env.send(&[ix], &[&s.lp]).await };
    assert_rejected_with(&r, code(SwdmmV2Error::WithdrawPaused), "fee claim while withdrawals are paused");
}

#[tokio::test]
async fn attack_governance_timelock() {
    let mut s = setup().await;
    // protocol fees accrue
    let (t, ta, tb) = s.env.v2_wallet(&s.v, 100 * M, 0).await;
    let ix = s.env.ix_v2_swap(&s.v, &t.pubkey(), &ta, &tb, 50 * M, 0, true);
    s.env.send(&[ix], &[&t]).await.unwrap();

    // outsider proposes a fee withdrawal
    let (att, aa, ab) = s.env.v2_wallet(&s.v, 0, 0).await;
    let id = s.env.next_action_id().await;
    let r = { let ix = s.env.ix_propose(&att.pubkey(), id, GovAction::WithdrawV2ProtocolFees { pool: s.v.pool }); s.env.send(&[ix], &[&att]).await };
    assert_rejected_with(&r, code(GovernanceError::Unauthorized), "outsider proposes a governance action");

    // governance proposes; nobody may execute before the delay
    let gov = s.env.gov.insecure_clone();
    let ix = s.env.ix_propose(&gov.pubkey(), id, GovAction::WithdrawV2ProtocolFees { pool: s.v.pool });
    s.env.send(&[ix], &[&gov]).await.expect("governance proposes");
    let tr_a = s.env.fund(&s.treasury.pubkey(), &s.v.mint_a, 0).await;
    let tr_b = s.env.fund(&s.treasury.pubkey(), &s.v.mint_b, 0).await;
    let r = { let ix = s.env.ix_exec_withdraw_fees(&s.v, id, &tr_a, &tr_b); s.env.send(&[ix], &[]).await };
    assert_rejected_with(&r, code(TimelockError::TimelockNotElapsed), "execute before the timelock delay");

    s.env.warp_seconds(TIMELOCK_SECS + 5).await;
    // after the delay, an outsider tries to route the fees to itself
    let r = { let ix = s.env.ix_exec_withdraw_fees(&s.v, id, &aa, &ab); s.env.send(&[ix], &[]).await };
    assert_rejected(&r, "protocol fees paid to a non-treasury account");
    // to the treasury: works once, and only once
    let ix = s.env.ix_exec_withdraw_fees(&s.v, id, &tr_a, &tr_b);
    s.env.send(&[ix], &[]).await.expect("execute to the treasury");
    assert!(s.env.balance(&tr_a).await > 0, "treasury received nothing");
    let r = { let ix = s.env.ix_exec_withdraw_fees(&s.v, id, &tr_a, &tr_b); s.env.send(&[ix], &[]).await };
    assert_rejected_with(&r, code(TimelockError::ActionNotPending), "execute the same action twice");
}
