//! Attacks on the DLMM pool (dlmm.rs).

mod common;
use common::dlmm::*;
use common::*;

use anchor_lang::prelude::Pubkey;
use solana_sdk::signer::Signer;
use swd_amm::{DlmmError, SwdAmmError};

const M: u64 = 1_000_000;

// The bin array holds `u128`s: 8-byte aligned on SBF, but a native x86_64
// build needs 16, which the test runtime's account buffers don't give. So
// these are #[ignore]d natively and run against the real SBF build:
//   anchor build
//   BPF_OUT_DIR=<repo>/target/deploy cargo test -- --include-ignored
// (CI does exactly that.)

/// Pool around bin 0 with 10 tokens per bin in [-5, 5]: B below the price,
/// A above, both in the active bin.
async fn seeded(env: &mut Env) -> (Dlmm, solana_sdk::signature::Keypair, Pubkey, Pubkey) {
    let d = env.dlmm_pool(&DlmmParams::default()).await;
    let (lp, ta, tb) = env.dlmm_trader(&d, 1_000 * M, 1_000 * M).await;
    let amounts = (-5..=5).map(|id| if id < 0 { (0, 10 * M) } else if id > 0 { (10 * M, 0) } else { (10 * M, 10 * M) }).collect();
    let ix = env.ix_add_dlmm(&d, &lp.pubkey(), &ta, &tb, -5, 5, amounts);
    env.send(&[ix], &[&lp]).await.expect("seed DLMM liquidity");
    (d, lp, ta, tb)
}

fn in_needed(reserve_out: u64, bin_id: i32, step: u16, a_to_b: bool) -> u64 {
    swd_amm::amount_in_for_output(reserve_out, swd_amm::bin_price_q64(bin_id, step).unwrap(), a_to_b).unwrap()
}

#[tokio::test]
#[ignore = "needs the SBF build: BPF_OUT_DIR=target/deploy, --include-ignored"]
async fn baseline_honest_dlmm_swap_works() {
    let mut env = Env::new().await;
    let (d, ..) = seeded(&mut env).await;
    let (t, ta, tb) = env.dlmm_trader(&d, 5 * M, 0).await;
    let ix = env.ix_swap_dlmm(&d, &t.pubkey(), &ta, &tb, M, 1, true);
    env.send(&[ix], &[&t]).await.expect("honest swap");
    assert!(env.balance(&tb).await > 0);
}

#[tokio::test]
#[ignore = "needs the SBF build: BPF_OUT_DIR=target/deploy, --include-ignored"]
async fn attack_excess_b_donated_to_active_bin_holders() {
    // Depositing into the active bin with more B than its ratio needs used
    // to take ALL of it while minting shares only for the needed part.
    let mut env = Env::new().await;
    let (d, ..) = seeded(&mut env).await;
    let (victim, va, vb) = env.dlmm_trader(&d, 10 * M, 10 * M).await;
    let ix = env.ix_add_dlmm(&d, &victim.pubkey(), &va, &vb, 0, 0, vec![(M, 3 * M)]);
    env.send(&[ix], &[&victim]).await.expect("deposit into active bin");
    let paid_b = 10 * M - env.balance(&vb).await;
    assert!(paid_b <= M + 1, "ATTACK SUCCEEDED: depositor paid {paid_b} raw B for shares worth ~{M}");
    // and withdrawing everything returns no more than was paid
    let pos = position_pda(&d.pool, &victim.pubkey(), 0, 0);
    let shares = env.dlmm_position(&pos).await.shares[0];
    let ix = env.ix_remove_dlmm(&d, &victim.pubkey(), &va, &vb, pos, vec![shares], 0, 0);
    env.send(&[ix], &[&victim]).await.unwrap();
    assert!(env.balance(&va).await <= 10 * M && env.balance(&vb).await <= 10 * M, "round trip created tokens");
}

#[tokio::test]
#[ignore = "needs the SBF build: BPF_OUT_DIR=target/deploy, --include-ignored"]
async fn attack_strand_active_bin_outside_the_array() {
    // Drain the edge bin with an exact input: the active bin must stay in
    // the array, otherwise every later swap reverts forever.
    let mut env = Env::new().await;
    let p = DlmmParams { bin_step: 1, fee_bps: 0, max_fee_bps: 0, deviation_bps: 500, active_bin: 0 };
    let d = env.dlmm_pool(&p).await;
    let (lp, la, lb) = env.dlmm_trader(&d, 0, 1_000 * M).await;
    for lo in [-100, -80, -60, -40, -20] {
        let ix = env.ix_add_dlmm(&d, &lp.pubkey(), &la, &lb, lo, lo + 19, vec![(0, 1_000); 20]);
        env.send(&[ix], &[&lp]).await.expect("B-only liquidity below the price");
    }
    let (t, ta, tb) = env.dlmm_trader(&d, 10 * M, 10 * M).await;
    // walk the price down to the edge, draining whole bins exactly
    for _ in 0..10 {
        let active = env.dlmm_state(&d).await.active_bin_id;
        if active == -100 {
            break;
        }
        let (mut amt, mut id, mut n) = (0u64, active, 0);
        while id > -100 && n < 25 {
            let (_, rb, _) = env.bin(&d, id).await;
            if rb > 0 {
                amt += in_needed(rb, id, 1, true);
            }
            id -= 1;
            n += 1;
        }
        let ix = env.ix_swap_dlmm(&d, &t.pubkey(), &ta, &tb, amt, 0, true);
        env.send(&[ix], &[&t]).await.expect("walk the price down");
    }
    assert_eq!(env.dlmm_state(&d).await.active_bin_id, -100, "test setup: price should sit at the edge bin");
    let (_, rb, _) = env.bin(&d, -100).await;
    let ix = env.ix_swap_dlmm(&d, &t.pubkey(), &ta, &tb, in_needed(rb, -100, 1, true), 0, true);
    env.send(&[ix], &[&t]).await.expect("exact drain of the edge bin");
    let st = env.dlmm_state(&d).await;
    assert!(st.active_bin_id >= st.min_bin_id && st.active_bin_id <= st.max_bin_id, "ATTACK SUCCEEDED: active bin left at {} (array {}..{})", st.active_bin_id, st.min_bin_id, st.max_bin_id);
    // the pool still trades the other way
    let ix = env.ix_swap_dlmm(&d, &t.pubkey(), &tb, &ta, 100, 1, false);
    env.send(&[ix], &[&t]).await.expect("pool must keep trading after the edge was drained");
}

#[tokio::test]
#[ignore = "needs the SBF build: BPF_OUT_DIR=target/deploy, --include-ignored"]
async fn attack_unpriceable_active_bin_at_creation() {
    // A pool whose bins cannot be priced would accept no swap, ever, and
    // squat the pair's only DLMM address.
    let mut env = Env::new().await;
    let mint_a = env.mint(6).await;
    let mint_b = env.mint(6).await;
    env.allow_mint(&mint_a).await;
    env.allow_mint(&mint_b).await;
    let (pool, bin_array, vault_a, vault_b) = dlmm_pdas(&mint_a, &mint_b);
    let d = Dlmm { mint_a, mint_b, pool, bin_array, vault_a, vault_b, price_a: Pubkey::new_unique(), price_b: Pubkey::new_unique(), feed_a: feed_id(21), feed_b: feed_id(22), bin_step: 1_000 };
    let ix = env.ix_init_dlmm(&d, &DlmmParams { bin_step: 1_000, active_bin: 5_000, ..Default::default() });
    let r = env.send(&[ix], &[]).await;
    assert_rejected(&r, "DLMM pool whose bin prices overflow");
}

#[tokio::test]
#[ignore = "needs the SBF build: BPF_OUT_DIR=target/deploy, --include-ignored"]
async fn attack_remove_someone_elses_position() {
    let mut env = Env::new().await;
    let (d, lp, ..) = seeded(&mut env).await;
    let victim_pos = position_pda(&d.pool, &lp.pubkey(), -5, 5);
    let (att, aa, ab) = env.dlmm_trader(&d, 0, 0).await;
    let ix = env.ix_remove_dlmm(&d, &att.pubkey(), &aa, &ab, victim_pos, vec![1; 11], 0, 0);
    let r = env.send(&[ix], &[&att]).await;
    assert_rejected(&r, "withdraw from another wallet's position");
    assert_eq!(env.balance(&aa).await + env.balance(&ab).await, 0);
}

#[tokio::test]
#[ignore = "needs the SBF build: BPF_OUT_DIR=target/deploy, --include-ignored"]
async fn attack_position_of_another_pool() {
    let mut env = Env::new().await;
    let (d1, lp1, la, lb) = seeded(&mut env).await;
    let (d2, ..) = seeded(&mut env).await;
    // lp1's position from pool 1, presented to pool 2 (to drain pool 2's bins)
    let pos1 = position_pda(&d1.pool, &lp1.pubkey(), -5, 5);
    let la2 = env.fund(&lp1.pubkey(), &d2.mint_a, 0).await;
    let lb2 = env.fund(&lp1.pubkey(), &d2.mint_b, 0).await;
    let shares = env.dlmm_position(&pos1).await.shares;
    let ix = env.ix_remove_dlmm(&d2, &lp1.pubkey(), &la2, &lb2, pos1, shares[..11].to_vec(), 0, 0);
    let r = env.send(&[ix], &[&lp1]).await;
    assert_rejected(&r, "position from pool 1 used on pool 2");
    let _ = (la, lb);
}

#[tokio::test]
#[ignore = "needs the SBF build: BPF_OUT_DIR=target/deploy, --include-ignored"]
async fn attack_remove_more_shares_than_owned() {
    let mut env = Env::new().await;
    let (d, lp, la, lb) = seeded(&mut env).await;
    let pos = position_pda(&d.pool, &lp.pubkey(), -5, 5);
    let mut shares = env.dlmm_position(&pos).await.shares[..11].to_vec();
    shares[5] += 1;
    let ix = env.ix_remove_dlmm(&d, &lp.pubkey(), &la, &lb, pos, shares, 0, 0);
    let r = env.send(&[ix], &[&lp]).await;
    assert_rejected_with(&r, code(DlmmError::InsufficientShares), "remove one share more than owned");
}

#[tokio::test]
#[ignore = "needs the SBF build: BPF_OUT_DIR=target/deploy, --include-ignored"]
async fn attack_fake_bin_array_and_vaults() {
    let mut env = Env::new().await;
    let (d1, ..) = seeded(&mut env).await;
    let (d2, ..) = seeded(&mut env).await;
    let (t, ta, tb) = env.dlmm_trader(&d1, 5 * M, 0).await;
    let mut ix = env.ix_swap_dlmm(&d1, &t.pubkey(), &ta, &tb, M, 0, true);
    ix.accounts[2].pubkey = d2.bin_array;
    let r = env.send(&[ix], &[&t]).await;
    assert_rejected(&r, "swap with another pool's bin array");
    let mut ix = env.ix_swap_dlmm(&d1, &t.pubkey(), &ta, &tb, M, 0, true);
    ix.accounts[4].pubkey = env.fund(&t.pubkey(), &d1.mint_b, 0).await; // vault_b
    let r = env.send(&[ix], &[&t]).await;
    assert_rejected(&r, "swap with a substituted vault");
}

#[tokio::test]
#[ignore = "needs the SBF build: BPF_OUT_DIR=target/deploy, --include-ignored"]
async fn attack_bad_ranges_and_single_sided_rule() {
    let mut env = Env::new().await;
    let (d, ..) = seeded(&mut env).await;
    let (a, ta, tb) = env.dlmm_trader(&d, 100 * M, 100 * M).await;
    let r = { let ix = env.ix_add_dlmm(&d, &a.pubkey(), &ta, &tb, 1, 1, vec![(M, M)]); env.send(&[ix], &[&a]).await };
    assert_rejected_with(&r, code(DlmmError::SingleSidedViolation), "B into a bin above the price");
    let r = { let ix = env.ix_add_dlmm(&d, &a.pubkey(), &ta, &tb, -10, 10, vec![(0, 0); 21]); env.send(&[ix], &[&a]).await };
    assert_rejected_with(&r, code(DlmmError::RangeTooWide), "21-bin position");
    let r = { let ix = env.ix_add_dlmm(&d, &a.pubkey(), &ta, &tb, 95, 101, vec![(M, 0); 7]); env.send(&[ix], &[&a]).await };
    assert_rejected_with(&r, code(DlmmError::BinOutOfRange), "bin outside the array");
    let r = { let ix = env.ix_add_dlmm(&d, &a.pubkey(), &ta, &tb, 3, 2, vec![]); env.send(&[ix], &[&a]).await };
    assert_rejected(&r, "lower > upper");
    let r = { let ix = env.ix_add_dlmm(&d, &a.pubkey(), &ta, &tb, 20, 20, vec![(10, 0)]); env.send(&[ix], &[&a]).await };
    assert_rejected_with(&r, code(DlmmError::InsufficientBinLiquidity), "dust first deposit into an empty bin");
}

#[tokio::test]
#[ignore = "needs the SBF build: BPF_OUT_DIR=target/deploy, --include-ignored"]
async fn attack_spend_victims_tokens_dlmm() {
    let mut env = Env::new().await;
    let (d, ..) = seeded(&mut env).await;
    let (_v, va, vb) = env.dlmm_trader(&d, 50 * M, 50 * M).await;
    let (att, _aa, ab) = env.dlmm_trader(&d, 0, 0).await;
    let r = { let ix = env.ix_swap_dlmm(&d, &att.pubkey(), &va, &ab, 5 * M, 0, true); env.send(&[ix], &[&att]).await };
    assert_rejected_with(&r, code(SwdAmmError::InvalidTokenAccountOwner), "swap paid from the victim's account");
    let r = { let ix = env.ix_add_dlmm(&d, &att.pubkey(), &va, &vb, 6, 6, vec![(M, 0)]); env.send(&[ix], &[&att]).await };
    assert_rejected(&r, "deposit paid from the victim's accounts");
}

#[tokio::test]
#[ignore = "needs the SBF build: BPF_OUT_DIR=target/deploy, --include-ignored"]
async fn attack_dlmm_dust_swaps_gain_nothing() {
    let mut env = Env::new().await;
    let (d, ..) = seeded(&mut env).await;
    let (t, ta, tb) = env.dlmm_trader(&d, 1_000, 1_000).await;
    let mut ixs = vec![];
    for i in 0..20 {
        let ix = if i % 2 == 0 { env.ix_swap_dlmm(&d, &t.pubkey(), &ta, &tb, 3, 0, true) } else { env.ix_swap_dlmm(&d, &t.pubkey(), &tb, &ta, 3, 0, false) };
        ixs.push(ix);
    }
    let r = env.send(&ixs, &[&t]).await;
    let total = env.balance(&ta).await + env.balance(&tb).await;
    assert!(r.is_err() || total <= 2_000, "ATTACK SUCCEEDED: dust round trips grew 2000 -> {total}");
}

#[tokio::test]
#[ignore = "needs the SBF build: BPF_OUT_DIR=target/deploy, --include-ignored"]
async fn attack_dlmm_withdraw_round_trip_gains_nothing() {
    let mut env = Env::new().await;
    let (d, ..) = seeded(&mut env).await;
    let (a, ta, tb) = env.dlmm_trader(&d, 10 * M, 10 * M).await;
    let ix = env.ix_add_dlmm(&d, &a.pubkey(), &ta, &tb, 2, 4, vec![(1_234_567, 0), (7, 0), (999_999, 0)]);
    let r = env.send(&[ix], &[&a]).await;
    // 7 raw units into a non-empty bin can mint 0 shares -> rejected; retry sane
    if r.is_err() {
        let ix = env.ix_add_dlmm(&d, &a.pubkey(), &ta, &tb, 2, 4, vec![(1_234_567, 0), (777, 0), (999_999, 0)]);
        env.send(&[ix], &[&a]).await.unwrap();
    }
    let pos = position_pda(&d.pool, &a.pubkey(), 2, 4);
    let s = env.dlmm_position(&pos).await.shares;
    let ix = env.ix_remove_dlmm(&d, &a.pubkey(), &ta, &tb, pos, s[..3].to_vec(), 0, 0);
    env.send(&[ix], &[&a]).await.unwrap();
    assert!(env.balance(&ta).await <= 10 * M && env.balance(&tb).await <= 10 * M, "deposit+withdraw created tokens");
}
