//! SWDMM v2 pool + governance-timelock helpers.
#![allow(dead_code)]

use super::*;

pub const TIMELOCK_SECS: i64 = 60;

pub struct V2 {
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub pool: Pubkey,
    pub vault_a: Pubkey,
    pub vault_b: Pubkey,
    pub floor_fee: u16,
}

pub fn settings_pda() -> Pubkey {
    Pubkey::find_program_address(&[b"gov_settings"], &swd_amm::ID).0
}
pub fn mint_policy_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"mint_policy", mint.as_ref()], &swd_amm::ID).0
}
pub fn action_pda(id: u64) -> Pubkey {
    Pubkey::find_program_address(&[b"gov_action", &id.to_le_bytes()], &swd_amm::ID).0
}
pub fn v2_position_pda(pool: &Pubkey, index: u64) -> Pubkey {
    Pubkey::find_program_address(&[b"swdmm_v2_position", pool.as_ref(), &index.to_le_bytes()], &swd_amm::ID).0
}

pub fn fixed_fee_params(fee_bps: u16, activation_ts: i64) -> swd_amm::InitializeV2PoolParams {
    swd_amm::InitializeV2PoolParams {
        base_fee: swd_amm::BaseFeeParams { mode: 0, decay: 0, cliff_fee_bps: fee_bps, floor_fee_bps: fee_bps, number_of_periods: 0, period_frequency: 0, reduction_factor: 0 },
        dynamic_fee: swd_amm::DynamicFeeParams { enabled: false, max_dynamic_fee_bps: 0, variable_fee_control: 0, filter_period: 0, decay_period: 0, reduction_factor: 0, max_volatility_accumulator: 0 },
        collect_fee_mode: 0,
        activation_ts,
        max_price_impact_bps: 5_000,
        oracle: swd_amm::OracleGuardParams { enabled: false, pyth_feed_id_a: [0; 32], pyth_feed_id_b: [0; 32], max_staleness_secs: 0, max_deviation_bps: 0 },
    }
}

impl Env {
    /// Governance settings (timelock + protocol fee share + treasury).
    pub async fn init_gov_settings(&mut self, treasury: &Pubkey) {
        let gov = self.gov.insecure_clone();
        let ix = Instruction {
            program_id: swd_amm::ID,
            accounts: swd_amm::accounts::InitializeGovernanceSettings {
                config: self.config(),
                governance_authority: gov.pubkey(),
                settings: settings_pda(),
                payer: gov.pubkey(),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: swd_amm::instruction::InitializeGovernanceSettings { timelock_delay_secs: TIMELOCK_SECS, protocol_fee_share_bps: 1_000, treasury: *treasury }.data(),
        };
        self.send(&[ix], &[&gov]).await.expect("initialize_governance_settings");
    }

    pub async fn set_mint_policy(&mut self, mint: &Pubkey) {
        let gov = self.gov.insecure_clone();
        let ix = Instruction {
            program_id: swd_amm::ID,
            accounts: swd_amm::accounts::SetMintPolicy {
                config: self.config(),
                governance_authority: gov.pubkey(),
                mint: *mint,
                token_program: spl_token::ID,
                mint_policy: mint_policy_pda(mint),
                payer: gov.pubkey(),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: swd_amm::instruction::SetMintPolicy { enabled: true, token_2022_reviewed: false }.data(),
        };
        self.send(&[ix], &[&gov]).await.expect("set_mint_policy");
    }

    pub fn ix_init_v2(&self, creator: &Pubkey, v: &V2, params: swd_amm::InitializeV2PoolParams) -> Instruction {
        Instruction {
            program_id: swd_amm::ID,
            accounts: swd_amm::accounts::InitializeV2Pool {
                creator: *creator,
                config: self.config(),
                settings: settings_pda(),
                mint_a: v.mint_a,
                mint_b: v.mint_b,
                mint_policy_a: mint_policy_pda(&v.mint_a),
                mint_policy_b: mint_policy_pda(&v.mint_b),
                pool: v.pool,
                vault_a: v.vault_a,
                vault_b: v.vault_b,
                token_program_a: spl_token::ID,
                token_program_b: spl_token::ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: swd_amm::instruction::InitializeV2Pool { params }.data(),
        }
    }

    /// Fresh mints with policies, and an initialised (empty) v2 pool by `creator`.
    pub async fn v2_pool(&mut self, creator: &Keypair, params: swd_amm::InitializeV2PoolParams) -> V2 {
        let mint_a = self.mint(6).await;
        let mint_b = self.mint(6).await;
        self.set_mint_policy(&mint_a).await;
        self.set_mint_policy(&mint_b).await;
        let floor = params.base_fee.floor_fee_bps;
        let pool = Pubkey::find_program_address(&[b"swdmm_v2_pool", mint_a.as_ref(), mint_b.as_ref(), &floor.to_le_bytes()], &swd_amm::ID).0;
        let vault_a = Pubkey::find_program_address(&[b"swdmm_v2_vault", pool.as_ref(), mint_a.as_ref()], &swd_amm::ID).0;
        let vault_b = Pubkey::find_program_address(&[b"swdmm_v2_vault", pool.as_ref(), mint_b.as_ref()], &swd_amm::ID).0;
        let v = V2 { mint_a, mint_b, pool, vault_a, vault_b, floor_fee: floor };
        let ix = self.ix_init_v2(&creator.pubkey(), &v, params);
        self.send(&[ix], &[creator]).await.expect("initialize_v2_pool");
        v
    }

    pub async fn v2_state(&mut self, v: &V2) -> swd_amm::SwdmmV2Pool {
        self.anchor_account(&v.pool).await
    }

    pub async fn v2_position_state(&mut self, key: &Pubkey) -> swd_amm::SwdmmV2Position {
        self.anchor_account(key).await
    }

    /// Creates the next position for `owner`; returns its address.
    pub async fn v2_new_position(&mut self, v: &V2, owner: &Keypair) -> Pubkey {
        let count = self.v2_state(v).await.position_count;
        let position = v2_position_pda(&v.pool, count);
        let ix = Instruction {
            program_id: swd_amm::ID,
            accounts: swd_amm::accounts::CreateV2Position { owner: owner.pubkey(), pool: v.pool, position, system_program: anchor_lang::system_program::ID }.to_account_metas(None),
            data: swd_amm::instruction::CreateV2Position {}.data(),
        };
        self.send(&[ix], &[owner]).await.expect("create_v2_position");
        position
    }

    fn modify_accounts(&self, v: &V2, owner: &Pubkey, position: &Pubkey, ta: &Pubkey, tb: &Pubkey) -> Vec<anchor_lang::solana_program::instruction::AccountMeta> {
        swd_amm::accounts::ModifyV2Liquidity {
            owner: *owner,
            pool: v.pool,
            position: *position,
            mint_a: v.mint_a,
            mint_b: v.mint_b,
            vault_a: v.vault_a,
            vault_b: v.vault_b,
            owner_token_a: *ta,
            owner_token_b: *tb,
            token_program_a: spl_token::ID,
            token_program_b: spl_token::ID,
        }
        .to_account_metas(None)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn ix_v2_add(&self, v: &V2, owner: &Pubkey, position: &Pubkey, ta: &Pubkey, tb: &Pubkey, max_a: u64, max_b: u64) -> Instruction {
        Instruction { program_id: swd_amm::ID, accounts: self.modify_accounts(v, owner, position, ta, tb), data: swd_amm::instruction::AddV2Liquidity { max_a, max_b, min_liquidity: 0 }.data() }
    }
    #[allow(clippy::too_many_arguments)]
    pub fn ix_v2_remove(&self, v: &V2, owner: &Pubkey, position: &Pubkey, ta: &Pubkey, tb: &Pubkey, liquidity: u128) -> Instruction {
        Instruction { program_id: swd_amm::ID, accounts: self.modify_accounts(v, owner, position, ta, tb), data: swd_amm::instruction::RemoveV2Liquidity { liquidity, min_a: 0, min_b: 0 }.data() }
    }
    pub fn ix_v2_claim(&self, v: &V2, owner: &Pubkey, position: &Pubkey, ta: &Pubkey, tb: &Pubkey) -> Instruction {
        Instruction { program_id: swd_amm::ID, accounts: self.modify_accounts(v, owner, position, ta, tb), data: swd_amm::instruction::ClaimV2Fees {}.data() }
    }
    pub fn ix_v2_lock(&self, v: &V2, owner: &Pubkey, position: &Pubkey, liquidity: u128) -> Instruction {
        Instruction {
            program_id: swd_amm::ID,
            accounts: swd_amm::accounts::LockV2Liquidity { owner: *owner, pool: v.pool, position: *position }.to_account_metas(None),
            data: swd_amm::instruction::LockV2Liquidity { liquidity }.data(),
        }
    }
    pub fn ix_v2_transfer(&self, owner: &Pubkey, position: &Pubkey, new_owner: &Pubkey) -> Instruction {
        Instruction {
            program_id: swd_amm::ID,
            accounts: swd_amm::accounts::OwnV2Position { owner: *owner, position: *position }.to_account_metas(None),
            data: swd_amm::instruction::TransferV2Position { new_owner: *new_owner }.data(),
        }
    }
    pub fn ix_v2_close(&self, v: &V2, owner: &Pubkey, position: &Pubkey) -> Instruction {
        Instruction {
            program_id: swd_amm::ID,
            accounts: swd_amm::accounts::CloseV2Position { owner: *owner, pool: v.pool, position: *position }.to_account_metas(None),
            data: swd_amm::instruction::CloseV2Position {}.data(),
        }
    }
    #[allow(clippy::too_many_arguments)]
    pub fn ix_v2_swap(&self, v: &V2, trader: &Pubkey, ta: &Pubkey, tb: &Pubkey, amount_in: u64, min_out: u64, a_to_b: bool) -> Instruction {
        // Optional price accounts: Anchor reads the program id as "None".
        let mut accounts = swd_amm::accounts::SwapV2 {
            trader: *trader,
            settings: settings_pda(),
            pool: v.pool,
            mint_a: v.mint_a,
            mint_b: v.mint_b,
            vault_a: v.vault_a,
            vault_b: v.vault_b,
            trader_token_a: *ta,
            trader_token_b: *tb,
            token_program_a: spl_token::ID,
            token_program_b: spl_token::ID,
            price_update_a: None,
            price_update_b: None,
        }
        .to_account_metas(None);
        accounts.iter_mut().for_each(|_| ());
        Instruction { program_id: swd_amm::ID, accounts, data: swd_amm::instruction::SwapV2 { amount_in, min_amount_out: min_out, a_to_b }.data() }
    }
    pub fn ix_v2_pause(&self, v: &V2, signer: &Pubkey, swap: bool, deposit: bool, withdraw: bool) -> Instruction {
        Instruction {
            program_id: swd_amm::ID,
            accounts: swd_amm::accounts::EmergencyPauseV2Pool { config: self.config(), emergency_authority: *signer, pool: v.pool }.to_account_metas(None),
            data: swd_amm::instruction::EmergencyPauseV2Pool { pause_swap: swap, pause_deposit: deposit, pause_withdraw: withdraw }.data(),
        }
    }

    pub fn ix_propose(&self, signer: &Pubkey, id: u64, action: swd_amm::GovAction) -> Instruction {
        Instruction {
            program_id: swd_amm::ID,
            accounts: swd_amm::accounts::ProposeAction {
                config: self.config(),
                governance_authority: *signer,
                settings: settings_pda(),
                pending: action_pda(id),
                payer: *signer,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: swd_amm::instruction::ProposeGovAction { action }.data(),
        }
    }

    pub fn ix_exec_withdraw_fees(&self, v: &V2, id: u64, treasury_a: &Pubkey, treasury_b: &Pubkey) -> Instruction {
        Instruction {
            program_id: swd_amm::ID,
            accounts: swd_amm::accounts::ExecuteWithdrawProtocolFees {
                pending: action_pda(id),
                settings: settings_pda(),
                pool: v.pool,
                mint_a: v.mint_a,
                mint_b: v.mint_b,
                vault_a: v.vault_a,
                vault_b: v.vault_b,
                treasury_token_a: *treasury_a,
                treasury_token_b: *treasury_b,
                token_program_a: spl_token::ID,
                token_program_b: spl_token::ID,
            }
            .to_account_metas(None),
            data: swd_amm::instruction::ExecuteWithdrawProtocolFees {}.data(),
        }
    }

    pub async fn next_action_id(&mut self) -> u64 {
        let s: swd_amm::GovernanceSettings = self.anchor_account(&settings_pda()).await;
        s.next_action_id
    }

    /// A funded wallet with token accounts for both mints of `v`.
    pub async fn v2_wallet(&mut self, v: &V2, a: u64, b: u64) -> (Keypair, Pubkey, Pubkey) {
        let w = self.wallet().await;
        let ta = self.fund(&w.pubkey(), &v.mint_a, a).await;
        let tb = self.fund(&w.pubkey(), &v.mint_b, b).await;
        (w, ta, tb)
    }
}
