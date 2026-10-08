//! Shared harness for the attack suite: boots solana-program-test with the
//! REAL swd_amm program compiled natively (same Rust code `anchor build`
//! compiles for SBF), plus the bundled SPL Token / ATA programs, and gives
//! each test helpers to create mints, wallets, Pyth price accounts and
//! pools. No validator, no network: `cargo test` runs it.
#![allow(dead_code)]
#![allow(deprecated)] // solana_program::system_instruction re-export

use anchor_lang::{
    prelude::{AccountInfo, Pubkey},
    solana_program::entrypoint::ProgramResult,
    solana_program::{instruction::Instruction, program_pack::Pack, system_instruction, sysvar},
    AccountDeserialize, AnchorSerialize, InstructionData, ToAccountMetas,
};
use solana_program_test::{processor, BanksClientError, ProgramTest, ProgramTestContext};
use solana_sdk::{
    account::Account,
    instruction::InstructionError,
    signature::{Keypair, Signer},
    transaction::{Transaction, TransactionError},
};

pub mod cp;
pub mod dlmm;
pub mod v2;

pub const PYTH_RECEIVER: Pubkey = anchor_lang::solana_program::pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
pub const BPF_UPGRADEABLE_LOADER: Pubkey = anchor_lang::solana_program::bpf_loader_upgradeable::ID;
const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];

/// Anchor's generated entrypoint, adapted to the lifetime-free signature
/// solana-program-test's `processor!` expects.
fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    // SAFETY: the runtime keeps `accounts` alive for the whole call;
    // Anchor's `entry` only needs them to share one lifetime.
    let accounts: &[AccountInfo] = unsafe { std::mem::transmute(accounts) };
    swd_amm::entry(program_id, accounts, data)
}

pub struct Env {
    pub ctx: ProgramTestContext,
    pub gov: Keypair,
    pub emergency: Keypair,
}

pub fn feed_id(n: u8) -> [u8; 32] {
    let mut f = [0u8; 32];
    f[0] = 0xfe;
    f[31] = n;
    f
}

impl Env {
    /// Program booted, global config initialised by the (fake) upgrade
    /// authority = the test payer.
    pub async fn new() -> Env {
        let mut env = Env::bare().await;
        let ix = env.ix_init_global_config(&env.payer(), &env.gov.pubkey(), &env.emergency.pubkey());
        env.send(&[ix], &[]).await.expect("initialize_global_config");
        // governance authority pays for its own allowlist entries in tests
        env.airdrop(&env.gov.pubkey(), 10_000_000_000).await;
        env
    }

    /// Program booted, upgrade authority = test payer, nothing initialised.
    pub async fn bare() -> Env {
        // Native by default; with BPF_OUT_DIR (or SBF_OUT_DIR) pointing at
        // `anchor build`'s target/deploy, the real swd_amm.so runs instead.
        let pt = ProgramTest::new("swd_amm", swd_amm::ID, processor!(process));
        let ctx = pt.start_with_context().await;
        let mut env = Env { ctx, gov: Keypair::new(), emergency: Keypair::new() };
        env.install_program_data(env.payer());
        env
    }

    /// True when the real SBF build is under test (see `bare`).
    pub fn is_sbf() -> bool {
        std::env::var("BPF_OUT_DIR").is_ok() || std::env::var("SBF_OUT_DIR").is_ok()
    }

    pub fn payer(&self) -> Pubkey {
        self.ctx.payer.pubkey()
    }

    /// A deployed upgradeable program has a ProgramData account holding its
    /// upgrade authority; a native test program has none, so write one.
    pub fn install_program_data(&mut self, authority: Pubkey) {
        let (pd, _) = Pubkey::find_program_address(&[swd_amm::ID.as_ref()], &BPF_UPGRADEABLE_LOADER);
        // UpgradeableLoaderState::ProgramData { slot, upgrade_authority_address }
        let mut data = Vec::new();
        data.extend_from_slice(&3u32.to_le_bytes()); // enum tag: ProgramData
        data.extend_from_slice(&0u64.to_le_bytes()); // slot
        data.push(1); // Some(
        data.extend_from_slice(authority.as_ref()); // authority)
        self.ctx.set_account(&pd, &Account { lamports: 1_000_000_000, data, owner: BPF_UPGRADEABLE_LOADER, executable: false, rent_epoch: 0 }.into());
    }

    pub fn program_data(&self) -> Pubkey {
        Pubkey::find_program_address(&[swd_amm::ID.as_ref()], &BPF_UPGRADEABLE_LOADER).0
    }

    pub fn config(&self) -> Pubkey {
        Pubkey::find_program_address(&[b"global-config"], &swd_amm::ID).0
    }

    pub fn ix_init_global_config(&self, payer: &Pubkey, gov: &Pubkey, emergency: &Pubkey) -> Instruction {
        Instruction {
            program_id: swd_amm::ID,
            accounts: swd_amm::accounts::InitializeGlobalConfig {
                config: self.config(),
                payer: *payer,
                program_data: self.program_data(),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: swd_amm::instruction::InitializeGlobalConfig { governance_authority: *gov, emergency_authority: *emergency }.data(),
        }
    }

    // ---------------------------------------------------------------- tx

    pub async fn send(&mut self, ixs: &[Instruction], extra_signers: &[&Keypair]) -> Result<(), BanksClientError> {
        let bh = self.ctx.get_new_latest_blockhash().await.unwrap();
        let mut signers: Vec<&Keypair> = vec![&self.ctx.payer];
        signers.extend_from_slice(extra_signers);
        let tx = Transaction::new_signed_with_payer(ixs, Some(&self.ctx.payer.pubkey()), &signers, bh);
        self.ctx.banks_client.process_transaction(tx).await
    }

    /// Sends with `fee_payer` as the only fee payer/signer besides `extra`.
    pub async fn send_as(&mut self, fee_payer: &Keypair, ixs: &[Instruction], extra: &[&Keypair]) -> Result<(), BanksClientError> {
        let bh = self.ctx.get_new_latest_blockhash().await.unwrap();
        let mut signers: Vec<&Keypair> = vec![fee_payer];
        signers.extend_from_slice(extra);
        let tx = Transaction::new_signed_with_payer(ixs, Some(&fee_payer.pubkey()), &signers, bh);
        self.ctx.banks_client.process_transaction(tx).await
    }

    pub async fn airdrop(&mut self, to: &Pubkey, lamports: u64) {
        let ix = system_instruction::transfer(&self.payer(), to, lamports);
        self.send(&[ix], &[]).await.unwrap();
    }

    pub async fn wallet(&mut self) -> Keypair {
        let k = Keypair::new();
        self.airdrop(&k.pubkey(), 10_000_000_000).await;
        k
    }

    pub async fn account(&mut self, key: &Pubkey) -> Option<Account> {
        self.ctx.banks_client.get_account(*key).await.unwrap()
    }

    pub async fn anchor_account<T: AccountDeserialize>(&mut self, key: &Pubkey) -> T {
        let acc = self.account(key).await.expect("account exists");
        T::try_deserialize(&mut acc.data.as_slice()).expect("deserialize")
    }

    pub async fn now(&mut self) -> i64 {
        self.ctx.banks_client.get_sysvar::<anchor_lang::solana_program::clock::Clock>().await.unwrap().unix_timestamp
    }

    /// Moves the cluster clock forward (unix_timestamp only — warping
    /// slots makes the test bank hash accounts to disk, which is slow).
    pub async fn warp_seconds(&mut self, secs: i64) {
        let mut clock = self.ctx.banks_client.get_sysvar::<anchor_lang::solana_program::clock::Clock>().await.unwrap();
        clock.unix_timestamp += secs;
        self.ctx.set_sysvar(&clock);
    }

    // -------------------------------------------------------------- tokens

    pub async fn mint(&mut self, decimals: u8) -> Pubkey {
        let mint = Keypair::new();
        let rent = self.ctx.banks_client.get_rent().await.unwrap();
        let ixs = [
            system_instruction::create_account(&self.payer(), &mint.pubkey(), rent.minimum_balance(spl_token::state::Mint::LEN), spl_token::state::Mint::LEN as u64, &spl_token::ID),
            spl_token::instruction::initialize_mint2(&spl_token::ID, &mint.pubkey(), &self.payer(), None, decimals).unwrap(),
        ];
        self.send(&ixs, &[&mint]).await.unwrap();
        mint.pubkey()
    }

    pub fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
        spl_associated_token_account::get_associated_token_address(owner, mint)
    }

    /// Creates `owner`'s ATA (if needed) and mints `amount` raw units to it.
    pub async fn fund(&mut self, owner: &Pubkey, mint: &Pubkey, amount: u64) -> Pubkey {
        let ata = Self::ata(owner, mint);
        let mut ixs = vec![spl_associated_token_account::instruction::create_associated_token_account_idempotent(&self.payer(), owner, mint, &spl_token::ID)];
        if amount > 0 {
            ixs.push(spl_token::instruction::mint_to(&spl_token::ID, mint, &ata, &self.payer(), &[], amount).unwrap());
        }
        self.send(&ixs, &[]).await.unwrap();
        ata
    }

    pub async fn balance(&mut self, token_account: &Pubkey) -> u64 {
        match self.account(token_account).await {
            Some(a) => spl_token::state::Account::unpack(&a.data).map(|t| t.amount).unwrap_or(0),
            None => 0,
        }
    }

    /// A token account at a fresh (non-ATA) address.
    pub async fn token_account(&mut self, owner: &Pubkey, mint: &Pubkey) -> Pubkey {
        let acc = Keypair::new();
        let rent = self.ctx.banks_client.get_rent().await.unwrap();
        let ixs = [
            system_instruction::create_account(&self.payer(), &acc.pubkey(), rent.minimum_balance(spl_token::state::Account::LEN), spl_token::state::Account::LEN as u64, &spl_token::ID),
            spl_token::instruction::initialize_account3(&spl_token::ID, &acc.pubkey(), mint, owner).unwrap(),
        ];
        self.send(&ixs, &[&acc]).await.unwrap();
        acc.pubkey()
    }

    // ------------------------------------------------------------- oracle

    /// Writes a PriceUpdateV2 account (Pyth Receiver layout) at `key`.
    /// `full` = VerificationLevel::Full; `owner` is normally PYTH_RECEIVER.
    #[allow(clippy::too_many_arguments)]
    pub fn set_price_raw(&mut self, key: &Pubkey, feed: [u8; 32], price: i64, expo: i32, publish_time: i64, full: bool, owner: Pubkey) {
        let mut d = Vec::with_capacity(160);
        d.extend_from_slice(&PRICE_UPDATE_V2_DISCRIMINATOR);
        d.extend_from_slice(Pubkey::new_unique().as_ref()); // write_authority
        if full {
            d.push(1); // VerificationLevel::Full
        } else {
            d.push(0); // VerificationLevel::Partial { num_signatures }
            d.push(3);
        }
        d.extend_from_slice(&feed);
        d.extend_from_slice(&price.to_le_bytes());
        d.extend_from_slice(&((price / 1000).max(1) as u64).to_le_bytes()); // conf
        d.extend_from_slice(&expo.to_le_bytes());
        d.extend_from_slice(&publish_time.to_le_bytes());
        d.extend_from_slice(&(publish_time - 1).to_le_bytes());
        d.extend_from_slice(&price.to_le_bytes()); // ema_price
        d.extend_from_slice(&((price / 1000).max(1) as u64).to_le_bytes());
        d.extend_from_slice(&1u64.to_le_bytes()); // posted_slot
        self.ctx.set_account(key, &Account { lamports: 10_000_000, data: d, owner, executable: false, rent_epoch: 0 }.into());
    }

    pub async fn set_price(&mut self, key: &Pubkey, feed: [u8; 32], price: i64, expo: i32) {
        let now = self.now().await;
        self.set_price_raw(key, feed, price, expo, now, true, PYTH_RECEIVER);
    }

    // --------------------------------------------------------- governance

    pub fn mint_feed_pda(mint: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[b"mint-feed", mint.as_ref()], &swd_amm::ID).0
    }

    pub fn ix_set_mint_feed(&self, signer: &Pubkey, mint: &Pubkey, feed: [u8; 32]) -> Instruction {
        Instruction {
            program_id: swd_amm::ID,
            accounts: swd_amm::accounts::SetMintFeed {
                config: self.config(),
                governance_authority: *signer,
                mint: *mint,
                mint_feed: Self::mint_feed_pda(mint),
                payer: *signer,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: swd_amm::instruction::SetMintFeed { pyth_feed_id: feed }.data(),
        }
    }

    /// Governance registers `feed` as the Pyth feed of `mint`.
    pub async fn register_feed(&mut self, mint: &Pubkey, feed: [u8; 32]) {
        let gov = self.gov.insecure_clone();
        let ix = self.ix_set_mint_feed(&gov.pubkey(), mint, feed);
        self.send(&[ix], &[&gov]).await.expect("set_mint_feed");
    }

    pub fn allowed_mint_pda(mint: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[b"allowed-mint", mint.as_ref()], &swd_amm::ID).0
    }

    pub async fn allow_mint(&mut self, mint: &Pubkey) {
        let gov = self.gov.insecure_clone();
        let ix = Instruction {
            program_id: swd_amm::ID,
            accounts: swd_amm::accounts::SetAllowedMint {
                config: self.config(),
                governance_authority: gov.pubkey(),
                mint: *mint,
                allowed_mint: Self::allowed_mint_pda(mint),
                payer: gov.pubkey(),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: swd_amm::instruction::SetAllowedMint { enabled: true }.data(),
        };
        self.send(&[ix], &[&gov]).await.expect("set_allowed_mint");
    }
}

// ------------------------------------------------------------- results

/// The custom error code of a failed transaction (Anchor: 6000+ for the
/// program's own errors, 2000-range for account constraints).
pub fn custom_code(r: &Result<(), BanksClientError>) -> Option<u32> {
    match r {
        Err(BanksClientError::TransactionError(TransactionError::InstructionError(_, InstructionError::Custom(c)))) => Some(*c),
        Err(BanksClientError::SimulationError { err: TransactionError::InstructionError(_, InstructionError::Custom(c)), .. }) => Some(*c),
        _ => None,
    }
}

#[track_caller]
pub fn assert_rejected(r: &Result<(), BanksClientError>, what: &str) {
    assert!(r.is_err(), "ATTACK SUCCEEDED (should have been rejected): {what}");
}

#[track_caller]
pub fn assert_rejected_with(r: &Result<(), BanksClientError>, code: u32, what: &str) {
    assert!(r.is_err(), "ATTACK SUCCEEDED (should have been rejected): {what}");
    assert_eq!(custom_code(r), Some(code), "{what}: rejected, but with an unexpected error: {r:?}");
}

/// Program error code of a variant (`#[error_code]` enums start at 6000).
pub fn code<E: Into<u32>>(e: E) -> u32 {
    e.into()
}

pub fn borsh<T: AnchorSerialize>(t: &T) -> Vec<u8> {
    t.try_to_vec().unwrap()
}

pub fn clock_id() -> Pubkey {
    sysvar::clock::ID
}
