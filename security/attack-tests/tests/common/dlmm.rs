//! DLMM pool helpers.
#![allow(dead_code)]

use super::*;

pub struct Dlmm {
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub pool: Pubkey,
    pub bin_array: Pubkey,
    pub vault_a: Pubkey,
    pub vault_b: Pubkey,
    pub price_a: Pubkey,
    pub price_b: Pubkey,
    pub feed_a: [u8; 32],
    pub feed_b: [u8; 32],
    pub bin_step: u16,
}

pub struct DlmmParams {
    pub bin_step: u16,
    pub fee_bps: u16,
    pub max_fee_bps: u16,
    pub deviation_bps: u16,
    pub active_bin: i32,
}

impl Default for DlmmParams {
    fn default() -> Self {
        DlmmParams { bin_step: 25, fee_bps: 30, max_fee_bps: 100, deviation_bps: 500, active_bin: 0 }
    }
}

pub fn dlmm_pdas(mint_a: &Pubkey, mint_b: &Pubkey) -> (Pubkey, Pubkey, Pubkey, Pubkey) {
    let pid = swd_amm::ID;
    let pool = Pubkey::find_program_address(&[b"dlmm_pool", mint_a.as_ref(), mint_b.as_ref()], &pid).0;
    let ba = Pubkey::find_program_address(&[b"dlmm_bin_array", pool.as_ref()], &pid).0;
    let va = Pubkey::find_program_address(&[b"dlmm_vault_a", pool.as_ref()], &pid).0;
    let vb = Pubkey::find_program_address(&[b"dlmm_vault_b", pool.as_ref()], &pid).0;
    (pool, ba, va, vb)
}

pub fn position_pda(pool: &Pubkey, owner: &Pubkey, lo: i32, hi: i32) -> Pubkey {
    Pubkey::find_program_address(&[b"dlmm_position", pool.as_ref(), owner.as_ref(), &lo.to_le_bytes(), &hi.to_le_bytes()], &swd_amm::ID).0
}

impl Env {
    /// 6/6-decimal mints priced 1:1, so bin 0 is the oracle price.
    pub async fn dlmm_pool(&mut self, p: &DlmmParams) -> Dlmm {
        let mint_a = self.mint(6).await;
        let mint_b = self.mint(6).await;
        self.allow_mint(&mint_a).await;
        self.allow_mint(&mint_b).await;
        let (feed_a, feed_b) = (feed_id(11), feed_id(12));
        self.register_feed(&mint_a, feed_a).await;
        self.register_feed(&mint_b, feed_b).await;
        let (price_a, price_b) = (Pubkey::new_unique(), Pubkey::new_unique());
        self.set_price(&price_a, feed_a, 100_000_000, -8).await;
        self.set_price(&price_b, feed_b, 100_000_000, -8).await;
        let (pool, bin_array, vault_a, vault_b) = dlmm_pdas(&mint_a, &mint_b);
        let d = Dlmm { mint_a, mint_b, pool, bin_array, vault_a, vault_b, price_a, price_b, feed_a, feed_b, bin_step: p.bin_step };
        let ix = self.ix_init_dlmm(&d, p);
        self.send(&[ix], &[]).await.expect("initialize_dlmm_pool");
        d
    }

    pub fn ix_init_dlmm(&self, d: &Dlmm, p: &DlmmParams) -> Instruction {
        Instruction {
            program_id: swd_amm::ID,
            accounts: swd_amm::accounts::InitializeDlmmPool {
                payer: self.payer(),
                mint_a: d.mint_a,
                mint_b: d.mint_b,
                config: self.config(),
                allowed_mint_a: Self::allowed_mint_pda(&d.mint_a),
                allowed_mint_b: Self::allowed_mint_pda(&d.mint_b),
                mint_feed_a: Self::mint_feed_pda(&d.mint_a),
                mint_feed_b: Self::mint_feed_pda(&d.mint_b),
                pool: d.pool,
                bin_array: d.bin_array,
                vault_a: d.vault_a,
                vault_b: d.vault_b,
                token_program: spl_token::ID,
                system_program: anchor_lang::system_program::ID,
                rent: sysvar::rent::ID,
            }
            .to_account_metas(None),
            data: swd_amm::instruction::InitializeDlmmPool {
                bin_step_bps: p.bin_step,
                fee_bps: p.fee_bps,
                active_bin_id: p.active_bin,
                pyth_feed_id_a: d.feed_a,
                pyth_feed_id_b: d.feed_b,
                oracle_max_staleness_secs: 300,
                oracle_max_deviation_bps: p.deviation_bps,
                max_fee_bps: p.max_fee_bps,
            }
            .data(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn ix_add_dlmm(&self, d: &Dlmm, dep: &Pubkey, ta: &Pubkey, tb: &Pubkey, lo: i32, hi: i32, amounts: Vec<(u64, u64)>) -> Instruction {
        Instruction {
            program_id: swd_amm::ID,
            accounts: swd_amm::accounts::AddDlmmLiquidity {
                depositor: *dep,
                pool: d.pool,
                bin_array: d.bin_array,
                vault_a: d.vault_a,
                vault_b: d.vault_b,
                depositor_token_a: *ta,
                depositor_token_b: *tb,
                position: position_pda(&d.pool, dep, lo, hi),
                token_program: spl_token::ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: swd_amm::instruction::AddDlmmLiquidity {
                bin_id_lower: lo,
                bin_id_upper: hi,
                amounts: amounts.into_iter().map(|(a, b)| swd_amm::BinLiquidityAmount { amount_a: a, amount_b: b }).collect(),
            }
            .data(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn ix_remove_dlmm(&self, d: &Dlmm, owner: &Pubkey, ta: &Pubkey, tb: &Pubkey, position: Pubkey, shares: Vec<u128>, min_a: u64, min_b: u64) -> Instruction {
        Instruction {
            program_id: swd_amm::ID,
            accounts: swd_amm::accounts::RemoveDlmmLiquidity {
                owner: *owner,
                pool: d.pool,
                bin_array: d.bin_array,
                vault_a: d.vault_a,
                vault_b: d.vault_b,
                owner_token_a: *ta,
                owner_token_b: *tb,
                position,
                token_program: spl_token::ID,
            }
            .to_account_metas(None),
            data: swd_amm::instruction::RemoveDlmmLiquidity { shares_to_remove: shares, min_a_out: min_a, min_b_out: min_b }.data(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn ix_swap_dlmm(&self, d: &Dlmm, trader: &Pubkey, t_in: &Pubkey, t_out: &Pubkey, amount_in: u64, min_out: u64, a_to_b: bool) -> Instruction {
        Instruction {
            program_id: swd_amm::ID,
            accounts: swd_amm::accounts::SwapDlmm {
                trader: *trader,
                pool: d.pool,
                bin_array: d.bin_array,
                vault_a: d.vault_a,
                vault_b: d.vault_b,
                trader_token_in: *t_in,
                trader_token_out: *t_out,
                token_program: spl_token::ID,
                price_update_a: d.price_a,
                price_update_b: d.price_b,
            }
            .to_account_metas(None),
            data: swd_amm::instruction::SwapDlmm { amount_in, min_amount_out: min_out, a_to_b }.data(),
        }
    }

    pub async fn dlmm_trader(&mut self, d: &Dlmm, a: u64, b: u64) -> (Keypair, Pubkey, Pubkey) {
        let w = self.wallet().await;
        let ta = self.fund(&w.pubkey(), &d.mint_a, a).await;
        let tb = self.fund(&w.pubkey(), &d.mint_b, b).await;
        (w, ta, tb)
    }

    pub async fn dlmm_state(&mut self, d: &Dlmm) -> swd_amm::DlmmPool {
        self.anchor_account(&d.pool).await
    }

    /// (reserve_a, reserve_b, total_shares) of one bin.
    pub async fn bin(&mut self, d: &Dlmm, bin_id: i32) -> (u64, u64, u128) {
        // Decoded field by field (BinArray: pool 32, min/max i32, bump +
        // 7 padding, then 32-byte bins); a cast would need the Vec to be
        // 16-byte aligned at offset 8, which it is not.
        let acc = self.account(&d.bin_array).await.unwrap();
        let data = &acc.data[8..];
        let min_bin_id = i32::from_le_bytes(data[32..36].try_into().unwrap());
        let off = 48 + (bin_id - min_bin_id) as usize * 32;
        let total_shares = u128::from_le_bytes(data[off..off + 16].try_into().unwrap());
        let reserve_a = u64::from_le_bytes(data[off + 16..off + 24].try_into().unwrap());
        let reserve_b = u64::from_le_bytes(data[off + 24..off + 32].try_into().unwrap());
        (reserve_a, reserve_b, total_shares)
    }

    pub async fn dlmm_position(&mut self, key: &Pubkey) -> swd_amm::Position {
        self.anchor_account(key).await
    }
}
