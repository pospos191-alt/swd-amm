//! Constant-product pool helpers (initialize / add / remove / swap).
#![allow(dead_code)]

use super::*;

pub struct CpPool {
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub dec_a: u8,
    pub dec_b: u8,
    pub pool: Pubkey,
    pub vault_a: Pubkey,
    pub vault_b: Pubkey,
    pub lp_mint: Pubkey,
    pub price_a: Pubkey,
    pub price_b: Pubkey,
    pub feed_a: [u8; 32],
    pub feed_b: [u8; 32],
}

pub struct CpParams {
    pub dec_a: u8,
    pub dec_b: u8,
    /// Pyth prices, expo -8 (USD * 1e8)
    pub usd_a_e8: i64,
    pub usd_b_e8: i64,
    pub fee_bps: u16,
    pub max_fee_bps: u16,
    pub deviation_bps: u16,
    pub staleness: u32,
}

impl Default for CpParams {
    fn default() -> Self {
        CpParams { dec_a: 6, dec_b: 6, usd_a_e8: 100_000_000, usd_b_e8: 100_000_000, fee_bps: 30, max_fee_bps: 100, deviation_bps: 500, staleness: 300 }
    }
}

pub fn pdas(mint_a: &Pubkey, mint_b: &Pubkey) -> (Pubkey, Pubkey, Pubkey, Pubkey) {
    let pid = swd_amm::ID;
    let pool = Pubkey::find_program_address(&[b"pool", mint_a.as_ref(), mint_b.as_ref()], &pid).0;
    let va = Pubkey::find_program_address(&[b"vault_a", pool.as_ref()], &pid).0;
    let vb = Pubkey::find_program_address(&[b"vault_b", pool.as_ref()], &pid).0;
    let lp = Pubkey::find_program_address(&[b"lp_mint", pool.as_ref()], &pid).0;
    (pool, va, vb, lp)
}

impl Env {
    /// Two fresh allowlisted mints, Pyth prices, and an initialised (empty) pool.
    pub async fn cp_pool(&mut self, p: &CpParams) -> CpPool {
        let mint_a = self.mint(p.dec_a).await;
        let mint_b = self.mint(p.dec_b).await;
        self.allow_mint(&mint_a).await;
        self.allow_mint(&mint_b).await;
        let (feed_a, feed_b) = (feed_id(1), feed_id(2));
        self.register_feed(&mint_a, feed_a).await;
        self.register_feed(&mint_b, feed_b).await;
        let (price_a, price_b) = (Pubkey::new_unique(), Pubkey::new_unique());
        self.set_price(&price_a, feed_a, p.usd_a_e8, -8).await;
        self.set_price(&price_b, feed_b, p.usd_b_e8, -8).await;
        let (pool, vault_a, vault_b, lp_mint) = pdas(&mint_a, &mint_b);
        let cp = CpPool { mint_a, mint_b, dec_a: p.dec_a, dec_b: p.dec_b, pool, vault_a, vault_b, lp_mint, price_a, price_b, feed_a, feed_b };
        let ix = self.ix_init_cp(&cp, p);
        self.send(&[ix], &[]).await.expect("initialize_pool");
        cp
    }

    pub fn ix_init_cp(&self, cp: &CpPool, p: &CpParams) -> Instruction {
        Instruction {
            program_id: swd_amm::ID,
            accounts: swd_amm::accounts::InitializePool {
                payer: self.payer(),
                mint_a: cp.mint_a,
                mint_b: cp.mint_b,
                config: self.config(),
                allowed_mint_a: Self::allowed_mint_pda(&cp.mint_a),
                allowed_mint_b: Self::allowed_mint_pda(&cp.mint_b),
                mint_feed_a: Self::mint_feed_pda(&cp.mint_a),
                mint_feed_b: Self::mint_feed_pda(&cp.mint_b),
                pool: cp.pool,
                vault_a: cp.vault_a,
                vault_b: cp.vault_b,
                lp_mint: cp.lp_mint,
                token_program_a: spl_token::ID,
                token_program_b: spl_token::ID,
                token_program: spl_token::ID,
                system_program: anchor_lang::system_program::ID,
                rent: sysvar::rent::ID,
            }
            .to_account_metas(None),
            data: swd_amm::instruction::InitializePool {
                fee_bps: p.fee_bps,
                pyth_feed_id_a: cp.feed_a,
                pyth_feed_id_b: cp.feed_b,
                oracle_max_staleness_secs: p.staleness,
                oracle_max_deviation_bps: p.deviation_bps,
                max_fee_bps: p.max_fee_bps,
            }
            .data(),
        }
    }

    pub fn ix_add_cp(&self, cp: &CpPool, depositor: &Pubkey, ta: &Pubkey, tb: &Pubkey, a: u64, b: u64, min_lp: u64) -> Instruction {
        Instruction {
            program_id: swd_amm::ID,
            accounts: swd_amm::accounts::AddLiquidity {
                depositor: *depositor,
                pool: cp.pool,
                vault_a: cp.vault_a,
                vault_b: cp.vault_b,
                lp_mint: cp.lp_mint,
                mint_a: cp.mint_a,
                mint_b: cp.mint_b,
                depositor_token_a: *ta,
                depositor_token_b: *tb,
                depositor_lp: Env::ata(depositor, &cp.lp_mint),
                pool_lp_lock: Env::ata(&cp.pool, &cp.lp_mint),
                token_program_a: spl_token::ID,
                token_program_b: spl_token::ID,
                token_program: spl_token::ID,
                associated_token_program: spl_associated_token_account::ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: swd_amm::instruction::AddLiquidity { amount_a_desired: a, amount_b_desired: b, min_lp_out: min_lp }.data(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn ix_remove_cp(&self, cp: &CpPool, owner: &Pubkey, owner_lp: &Pubkey, ta: &Pubkey, tb: &Pubkey, lp: u64, min_a: u64, min_b: u64) -> Instruction {
        Instruction {
            program_id: swd_amm::ID,
            accounts: swd_amm::accounts::RemoveLiquidity {
                owner: *owner,
                pool: cp.pool,
                vault_a: cp.vault_a,
                vault_b: cp.vault_b,
                lp_mint: cp.lp_mint,
                mint_a: cp.mint_a,
                mint_b: cp.mint_b,
                owner_lp: *owner_lp,
                owner_token_a: *ta,
                owner_token_b: *tb,
                token_program_a: spl_token::ID,
                token_program_b: spl_token::ID,
                token_program: spl_token::ID,
            }
            .to_account_metas(None),
            data: swd_amm::instruction::RemoveLiquidity { lp_amount: lp, min_a_out: min_a, min_b_out: min_b }.data(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn ix_swap_cp(&self, cp: &CpPool, trader: &Pubkey, t_in: &Pubkey, t_out: &Pubkey, amount_in: u64, min_out: u64, a_to_b: bool) -> Instruction {
        Instruction {
            program_id: swd_amm::ID,
            accounts: swd_amm::accounts::Swap {
                trader: *trader,
                pool: cp.pool,
                vault_a: cp.vault_a,
                vault_b: cp.vault_b,
                mint_a: cp.mint_a,
                mint_b: cp.mint_b,
                trader_token_in: *t_in,
                trader_token_out: *t_out,
                token_program_a: spl_token::ID,
                token_program_b: spl_token::ID,
                price_update_a: cp.price_a,
                price_update_b: cp.price_b,
            }
            .to_account_metas(None),
            data: swd_amm::instruction::Swap { amount_in, min_amount_out: min_out, a_to_b }.data(),
        }
    }

    /// A funded wallet with token accounts for both sides of `cp`.
    pub async fn trader(&mut self, cp: &CpPool, a: u64, b: u64) -> (Keypair, Pubkey, Pubkey) {
        let w = self.wallet().await;
        let ta = self.fund(&w.pubkey(), &cp.mint_a, a).await;
        let tb = self.fund(&w.pubkey(), &cp.mint_b, b).await;
        (w, ta, tb)
    }

    /// Seeds the pool with a first deposit from a dedicated LP wallet.
    pub async fn seed_cp(&mut self, cp: &CpPool, a: u64, b: u64) -> (Keypair, Pubkey, Pubkey) {
        let (lp, ta, tb) = self.trader(cp, a, b).await;
        let ix = self.ix_add_cp(cp, &lp.pubkey(), &ta, &tb, a, b, 0);
        self.send(&[ix], &[&lp]).await.expect("seed liquidity");
        (lp, ta, tb)
    }

    pub async fn reserves(&mut self, cp: &CpPool) -> (u64, u64) {
        let p: swd_amm::Pool = self.anchor_account(&cp.pool).await;
        (p.reserve_a, p.reserve_b)
    }
}
