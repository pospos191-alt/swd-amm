//! Pure logic of the SWD mining program: no accounts, no syscalls other
//! than SHA-256 (`hashv`, a syscall on-chain and plain Rust in `cargo test`).
//! Everything that decides "is this proof worth a reward, and may it be
//! paid" lives here so it can be unit-tested without a validator; the
//! instruction handlers in lib.rs only load accounts and call these.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::hash::hashv;

use crate::MineError;

type R<T> = core::result::Result<T, MineError>;

/// Domain tag at the start of every challenge message the website signs.
/// Changing the message layout means changing this tag.
pub const CHALLENGE_TAG: &[u8; 8] = b"SWDMINE1";
/// tag (8) || program id (32) || wallet (32) || seq (u64 LE) || bits (u8) || expires_at (i64 LE)
pub const CHALLENGE_MSG_LEN: usize = 8 + 32 + 32 + 8 + 1 + 8;
/// Bytes the miner searches in front of its 8-byte nonce. 60 + 8 = 68 bytes,
/// the same message shape as the website's existing Web Worker search
/// (lib/mine/hub/mine-core.js on the site), so its fast midstate search can
/// be reused unchanged — only the 60-byte prefix is derived differently.
pub const POW_PREFIX_LEN: usize = 60;

pub const SECONDS_PER_DAY: i64 = 86_400;

/// Difficulty bounds (same range as the site's MINE_POW_BITS).
pub const MIN_DIFFICULTY_BITS: u8 = 16;
pub const MAX_DIFFICULTY_BITS: u8 = 40;
/// A challenge may not be valid for longer than this (and not less than
/// MIN_CHALLENGE_TTL_SECS as a configured maximum).
pub const MIN_CHALLENGE_TTL_SECS: u32 = 60;
pub const MAX_CHALLENGE_TTL_SECS: u32 = 86_400;

/// The exact bytes the challenge signer (the website) signs with Ed25519.
pub fn challenge_message(
    program_id: &Pubkey,
    wallet: &Pubkey,
    seq: u64,
    bits: u8,
    expires_at: i64,
) -> [u8; CHALLENGE_MSG_LEN] {
    let mut m = [0u8; CHALLENGE_MSG_LEN];
    m[0..8].copy_from_slice(CHALLENGE_TAG);
    m[8..40].copy_from_slice(program_id.as_ref());
    m[40..72].copy_from_slice(wallet.as_ref());
    m[72..80].copy_from_slice(&seq.to_le_bytes());
    m[80] = bits;
    m[81..89].copy_from_slice(&expires_at.to_le_bytes());
    m
}

/// prefix = sha256("SWDMINE1\0" || challenge || wallet)
///       || sha256("SWDMINE1\1" || challenge || wallet)[0..28]
pub fn pow_prefix(challenge: &[u8], wallet: &Pubkey) -> [u8; POW_PREFIX_LEN] {
    let a = hashv(&[CHALLENGE_TAG, &[0u8], challenge, wallet.as_ref()]).to_bytes();
    let b = hashv(&[CHALLENGE_TAG, &[1u8], challenge, wallet.as_ref()]).to_bytes();
    let mut out = [0u8; POW_PREFIX_LEN];
    out[..32].copy_from_slice(&a);
    out[32..].copy_from_slice(&b[..28]);
    out
}

/// The proof hash: sha256(prefix || nonce as 8 bytes big-endian). Together
/// with `pow_prefix` this is sha256 over (challenge, wallet, nonce).
pub fn pow_hash(prefix: &[u8; POW_PREFIX_LEN], nonce: u64) -> [u8; 32] {
    hashv(&[prefix, &nonce.to_be_bytes()]).to_bytes()
}

/// Number of leading zero BITS of a byte string (MSB first).
pub fn leading_zero_bits(bytes: &[u8]) -> u32 {
    let mut n = 0u32;
    for b in bytes {
        if *b == 0 {
            n += 8;
        } else {
            return n + b.leading_zeros();
        }
    }
    n
}

/// UTC day index of a unix timestamp (floor division, also correct for
/// negative timestamps — not that the chain will produce any).
pub fn day_index(unix_ts: i64) -> i64 {
    unix_ts.div_euclid(SECONDS_PER_DAY)
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParamValues {
    pub difficulty_bits: u8,
    pub reward_per_proof: u64,
    pub wallet_daily_cap: u64,
    pub site_daily_cap: u64,
    pub total_budget: u64,
    pub max_challenge_ttl_secs: u32,
}

/// Every parameter set (initialize and set_params) goes through this.
/// `already_credited` = rewards already credited; the budget can never be
/// lowered below what has been promised to miners.
pub fn validate_params(p: &ParamValues, already_credited: u64) -> R<()> {
    if p.difficulty_bits < MIN_DIFFICULTY_BITS || p.difficulty_bits > MAX_DIFFICULTY_BITS {
        return Err(MineError::InvalidDifficulty);
    }
    if p.reward_per_proof == 0 {
        return Err(MineError::InvalidReward);
    }
    if p.wallet_daily_cap < p.reward_per_proof {
        return Err(MineError::InvalidWalletCap);
    }
    if p.site_daily_cap < p.wallet_daily_cap {
        return Err(MineError::InvalidSiteCap);
    }
    if p.total_budget < p.reward_per_proof || p.total_budget < already_credited {
        return Err(MineError::InvalidBudget);
    }
    if p.max_challenge_ttl_secs < MIN_CHALLENGE_TTL_SECS
        || p.max_challenge_ttl_secs > MAX_CHALLENGE_TTL_SECS
    {
        return Err(MineError::InvalidTtl);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Challenge + proof checks
// ---------------------------------------------------------------------------

/// Checks the challenge's own fields against the config, the clock and the
/// wallet's last used sequence number (single use). Does NOT check the
/// signature (that is the Ed25519 instruction) or the work (`check_work`).
pub fn check_challenge(
    bits: u8,
    min_bits: u8,
    expires_at: i64,
    now: i64,
    max_ttl_secs: u32,
    seq: u64,
    last_seq: u64,
) -> R<()> {
    // An operator may raise the difficulty: older challenges are honoured
    // only if they are at least as hard (same rule as the site).
    if bits < min_bits {
        return Err(MineError::ChallengeTooEasy);
    }
    if now >= expires_at {
        return Err(MineError::ChallengeExpired);
    }
    // A signed expiry far in the future is refused (bounds what a leaked
    // challenge or a misconfigured signer can do).
    let ttl = expires_at.checked_sub(now).ok_or(MineError::MathOverflow)?;
    if ttl > i64::from(max_ttl_secs) {
        return Err(MineError::ChallengeTtlTooLong);
    }
    // Single use: sequence numbers per wallet must strictly increase.
    if seq <= last_seq {
        return Err(MineError::ChallengeAlreadyUsed);
    }
    Ok(())
}

/// The work: sha256(prefix || nonce) has at least `bits` leading zero bits.
pub fn check_work(challenge: &[u8], wallet: &Pubkey, nonce: u64, bits: u8) -> R<u32> {
    let prefix = pow_prefix(challenge, wallet);
    let z = leading_zero_bits(&pow_hash(&prefix, nonce));
    if z < u32::from(bits) {
        return Err(MineError::InsufficientWork);
    }
    Ok(z)
}

// ---------------------------------------------------------------------------
// Caps + accrual
// ---------------------------------------------------------------------------

/// The counters one accepted proof changes (wallet's and site-wide).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counters {
    pub wallet_day: i64,
    pub wallet_day_credited: u64,
    pub wallet_accrued: u64,
    pub wallet_total_mined: u64,
    pub site_day: i64,
    pub site_day_credited: u64,
    pub total_credited: u64,
}

/// Applies one reward of `reward` on UTC day `today`: rolls the day buckets
/// over, then checks wallet day cap → site day cap → total budget (all
/// checked math). Returns the new counters, or the first cap that refuses;
/// on error nothing is changed (the caller only writes on Ok).
pub fn credit(c: Counters, today: i64, p: &ParamValues) -> R<Counters> {
    let mut n = c;
    if n.wallet_day != today {
        n.wallet_day = today;
        n.wallet_day_credited = 0;
    }
    if n.site_day != today {
        n.site_day = today;
        n.site_day_credited = 0;
    }
    let reward = p.reward_per_proof;
    n.wallet_day_credited = n
        .wallet_day_credited
        .checked_add(reward)
        .ok_or(MineError::MathOverflow)?;
    if n.wallet_day_credited > p.wallet_daily_cap {
        return Err(MineError::WalletDailyCapReached);
    }
    n.site_day_credited = n
        .site_day_credited
        .checked_add(reward)
        .ok_or(MineError::MathOverflow)?;
    if n.site_day_credited > p.site_daily_cap {
        return Err(MineError::SiteDailyCapReached);
    }
    n.total_credited = n
        .total_credited
        .checked_add(reward)
        .ok_or(MineError::MathOverflow)?;
    if n.total_credited > p.total_budget {
        return Err(MineError::BudgetExhausted);
    }
    n.wallet_accrued = n
        .wallet_accrued
        .checked_add(reward)
        .ok_or(MineError::MathOverflow)?;
    n.wallet_total_mined = n
        .wallet_total_mined
        .checked_add(reward)
        .ok_or(MineError::MathOverflow)?;
    Ok(n)
}

/// What `withdraw_unused` may take out of the vault. Normally only what is
/// NOT owed to miners (vault − (credited − claimed)); when claims are paused
/// too (emergency: e.g. a leaked challenge-signer key minted fake balances)
/// the whole vault can be moved to the authority.
pub fn withdrawable(
    vault_amount: u64,
    total_credited: u64,
    total_claimed: u64,
    claims_paused: bool,
) -> R<u64> {
    if claims_paused {
        return Ok(vault_amount);
    }
    let outstanding = total_credited
        .checked_sub(total_claimed)
        .ok_or(MineError::MathOverflow)?;
    Ok(vault_amount.saturating_sub(outstanding))
}

// ---------------------------------------------------------------------------
// Ed25519 precompile instruction parsing
// ---------------------------------------------------------------------------

/// Header: num_signatures (u8) + padding (u8); then 14 bytes of offsets.
const ED25519_HEADER: usize = 2;
const ED25519_OFFSETS_LEN: usize = 14;

fn read_u16(d: &[u8], at: usize) -> Option<u16> {
    let b = d.get(at..at.checked_add(2)?)?;
    Some(u16::from_le_bytes([b[0], b[1]]))
}

/// Parses the data of an Ed25519 precompile instruction carrying exactly ONE
/// signature whose public key, signature and message all live in that same
/// instruction (every instruction index = u16::MAX). Returns (public key,
/// message). The runtime has already verified the signature if the
/// transaction executes at all; this only extracts WHAT was verified.
///
/// Rejecting any instruction index other than u16::MAX is essential: an
/// index pointing at another instruction lets an attacker make the
/// precompile verify one (pubkey, message) while this parser reads another.
pub fn parse_ed25519_single(data: &[u8]) -> R<([u8; 32], &[u8])> {
    if data.len() < ED25519_HEADER + ED25519_OFFSETS_LEN || data[0] != 1 {
        return Err(MineError::BadEd25519Instruction);
    }
    let o = ED25519_HEADER;
    let f = |k: usize| read_u16(data, o + 2 * k).ok_or(MineError::BadEd25519Instruction);
    let sig_offset = f(0)? as usize;
    let sig_ix = f(1)?;
    let pk_offset = f(2)? as usize;
    let pk_ix = f(3)?;
    let msg_offset = f(4)? as usize;
    let msg_size = f(5)? as usize;
    let msg_ix = f(6)?;
    if sig_ix != u16::MAX || pk_ix != u16::MAX || msg_ix != u16::MAX {
        return Err(MineError::BadEd25519Instruction);
    }
    // the signature must be inside the data too (the precompile reads it)
    data.get(sig_offset..sig_offset.checked_add(64).ok_or(MineError::BadEd25519Instruction)?)
        .ok_or(MineError::BadEd25519Instruction)?;
    let pk = data
        .get(pk_offset..pk_offset.checked_add(32).ok_or(MineError::BadEd25519Instruction)?)
        .ok_or(MineError::BadEd25519Instruction)?;
    let msg = data
        .get(msg_offset..msg_offset.checked_add(msg_size).ok_or(MineError::BadEd25519Instruction)?)
        .ok_or(MineError::BadEd25519Instruction)?;
    let mut pubkey = [0u8; 32];
    pubkey.copy_from_slice(pk);
    Ok((pubkey, msg))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> ParamValues {
        ParamValues {
            difficulty_bits: 20,
            reward_per_proof: 100,
            wallet_daily_cap: 300,
            site_daily_cap: 500,
            total_budget: 1_000,
            max_challenge_ttl_secs: 3_600,
        }
    }

    fn pk(n: u8) -> Pubkey {
        Pubkey::new_from_array([n; 32])
    }

    // ---- leading zero bits
    #[test]
    fn lzb_basic() {
        assert_eq!(leading_zero_bits(&[]), 0);
        assert_eq!(leading_zero_bits(&[0x80]), 0);
        assert_eq!(leading_zero_bits(&[0x40]), 1);
        assert_eq!(leading_zero_bits(&[0x01]), 7);
        assert_eq!(leading_zero_bits(&[0x00, 0xff]), 8);
        assert_eq!(leading_zero_bits(&[0x00, 0x00, 0x0f]), 20);
        assert_eq!(leading_zero_bits(&[0u8; 32]), 256);
    }

    #[test]
    fn lzb_every_bit_position() {
        for i in 0..256u32 {
            let mut b = [0u8; 32];
            b[(i / 8) as usize] = 0x80 >> (i % 8);
            assert_eq!(leading_zero_bits(&b), i);
            // trailing junk after the first 1 bit never matters
            for x in b.iter_mut().skip((i / 8 + 1) as usize) {
                *x = 0xff;
            }
            assert_eq!(leading_zero_bits(&b), i);
        }
    }

    // ---- day bucketing
    #[test]
    fn day_index_boundaries() {
        assert_eq!(day_index(0), 0);
        assert_eq!(day_index(86_399), 0);
        assert_eq!(day_index(86_400), 1);
        assert_eq!(day_index(-1), -1);
        // 2026-11-06T00:00:00Z
        assert_eq!(day_index(1_793_923_200), 20_763);
        assert_eq!(day_index(1_793_923_200 - 1), 20_762);
    }

    // ---- challenge message layout
    #[test]
    fn challenge_message_layout() {
        let m = challenge_message(&pk(1), &pk(2), 0x0102030405060708, 22, -2);
        assert_eq!(m.len(), 89);
        assert_eq!(&m[0..8], b"SWDMINE1");
        assert_eq!(&m[8..40], &[1u8; 32]);
        assert_eq!(&m[40..72], &[2u8; 32]);
        assert_eq!(&m[72..80], &[8, 7, 6, 5, 4, 3, 2, 1]);
        assert_eq!(m[80], 22);
        assert_eq!(&m[81..89], &(-2i64).to_le_bytes());
    }

    // ---- proof of work
    fn find_nonce(ch: &[u8], w: &Pubkey, bits: u32) -> u64 {
        let prefix = pow_prefix(ch, w);
        (0u64..).find(|n| leading_zero_bits(&pow_hash(&prefix, *n)) >= bits).unwrap()
    }

    #[test]
    fn pow_found_nonce_verifies_and_binds_wallet() {
        let w = pk(7);
        let ch = challenge_message(&pk(1), &w, 1, 12, 1_000);
        let n = find_nonce(&ch, &w, 12);
        assert!(check_work(&ch, &w, n, 12).unwrap() >= 12);
        // the prefix (and so every hash) depends on the wallet
        assert_ne!(pow_prefix(&ch, &w), pow_prefix(&ch, &pk(8)));
        // and on every byte of the challenge
        let mut ch2 = ch;
        ch2[88] ^= 1;
        assert_ne!(pow_prefix(&ch, &w), pow_prefix(&ch2, &w));
    }

    #[test]
    fn pow_rejects_weak_nonce() {
        let w = pk(3);
        let ch = challenge_message(&pk(1), &w, 5, 16, 1_000);
        let prefix = pow_prefix(&ch, &w);
        let weak = (0u64..)
            .find(|n| leading_zero_bits(&pow_hash(&prefix, *n)) < 16)
            .unwrap();
        assert!(matches!(check_work(&ch, &w, weak, 16), Err(MineError::InsufficientWork)));
    }

    #[test]
    fn pow_prefix_matches_independent_sha256() {
        // sha256 of "abc" (FIPS 180-2 test vector) through hashv
        let h = hashv(&[b"a", b"bc"]).to_bytes();
        assert_eq!(
            h[..4],
            [0xba, 0x78, 0x16, 0xbf],
            "hashv must be plain SHA-256 over the concatenation"
        );
        let w = pk(9);
        let ch = [0xAAu8; CHALLENGE_MSG_LEN];
        let p = pow_prefix(&ch, &w);
        let a = hashv(&[b"SWDMINE1\x00", &ch, w.as_ref()]).to_bytes();
        assert_eq!(&p[..32], &a);
    }

    /// Fixed vector shared with tests/swd_mine.ts and an independent Python
    /// hashlib computation (docs/SWD_MINE.md): program id [1;32], wallet
    /// [2;32], seq 7, bits 16, expires_at 1_800_000_000 → the first nonce
    /// with >= 16 zero bits is 5562.
    #[test]
    fn pow_cross_language_vector() {
        let w = pk(2);
        let ch = challenge_message(&pk(1), &w, 7, 16, 1_800_000_000);
        assert_eq!(find_nonce(&ch, &w, 16), 5562);
        let h = pow_hash(&pow_prefix(&ch, &w), 5562);
        assert_eq!(
            h[..8],
            [0x00, 0x00, 0xdd, 0x32, 0xd4, 0x78, 0xec, 0xaf]
        );
        assert_eq!(check_work(&ch, &w, 5562, 16).unwrap(), 16);
    }

    // ---- challenge checks
    #[test]
    fn challenge_checks() {
        let ok = check_challenge(20, 20, 1_100, 1_000, 3_600, 2, 1);
        assert!(ok.is_ok());
        assert!(matches!(check_challenge(19, 20, 1_100, 1_000, 3_600, 2, 1), Err(MineError::ChallengeTooEasy)));
        assert!(check_challenge(25, 20, 1_100, 1_000, 3_600, 2, 1).is_ok());
        assert!(matches!(check_challenge(20, 20, 1_000, 1_000, 3_600, 2, 1), Err(MineError::ChallengeExpired)));
        assert!(matches!(check_challenge(20, 20, 999, 1_000, 3_600, 2, 1), Err(MineError::ChallengeExpired)));
        assert!(check_challenge(20, 20, 4_600, 1_000, 3_600, 2, 1).is_ok());
        assert!(matches!(check_challenge(20, 20, 4_601, 1_000, 3_600, 2, 1), Err(MineError::ChallengeTtlTooLong)));
        assert!(matches!(check_challenge(20, 20, 1_100, 1_000, 3_600, 1, 1), Err(MineError::ChallengeAlreadyUsed)));
        assert!(matches!(check_challenge(20, 20, 1_100, 1_000, 3_600, 0, 0), Err(MineError::ChallengeAlreadyUsed)));
        assert!(check_challenge(20, 20, i64::MAX, i64::MIN + 1, 3_600, 2, 1).is_err());
    }

    // ---- params
    #[test]
    fn params_validation() {
        assert!(validate_params(&params(), 0).is_ok());
        let mut p = params();
        p.difficulty_bits = 15;
        assert!(matches!(validate_params(&p, 0), Err(MineError::InvalidDifficulty)));
        p.difficulty_bits = 41;
        assert!(matches!(validate_params(&p, 0), Err(MineError::InvalidDifficulty)));
        p = params();
        p.reward_per_proof = 0;
        assert!(matches!(validate_params(&p, 0), Err(MineError::InvalidReward)));
        p = params();
        p.wallet_daily_cap = 99;
        assert!(matches!(validate_params(&p, 0), Err(MineError::InvalidWalletCap)));
        p = params();
        p.site_daily_cap = 299;
        assert!(matches!(validate_params(&p, 0), Err(MineError::InvalidSiteCap)));
        p = params();
        p.total_budget = 99;
        assert!(matches!(validate_params(&p, 0), Err(MineError::InvalidBudget)));
        assert!(matches!(validate_params(&params(), 1_001), Err(MineError::InvalidBudget)));
        assert!(validate_params(&params(), 1_000).is_ok());
        p = params();
        p.max_challenge_ttl_secs = 59;
        assert!(matches!(validate_params(&p, 0), Err(MineError::InvalidTtl)));
        p.max_challenge_ttl_secs = 86_401;
        assert!(matches!(validate_params(&p, 0), Err(MineError::InvalidTtl)));
    }

    // ---- caps math
    #[test]
    fn credit_wallet_cap_and_day_rollover() {
        let p = params();
        let mut c = Counters::default();
        for _ in 0..3 {
            c = credit(c, 10, &p).unwrap();
        }
        assert_eq!(c.wallet_day_credited, 300);
        assert_eq!(c.wallet_accrued, 300);
        assert!(matches!(credit(c, 10, &p), Err(MineError::WalletDailyCapReached)));
        // next day: the wallet bucket resets, accrued keeps growing
        let c2 = credit(c, 11, &p).unwrap();
        assert_eq!(c2.wallet_day, 11);
        assert_eq!(c2.wallet_day_credited, 100);
        assert_eq!(c2.wallet_accrued, 400);
        assert_eq!(c2.wallet_total_mined, 400);
        assert_eq!(c2.site_day_credited, 100);
        assert_eq!(c2.total_credited, 400);
    }

    #[test]
    fn credit_site_cap() {
        let p = params();
        // site already at 500 today from other wallets
        let c = Counters { site_day: 10, site_day_credited: 500, total_credited: 500, ..Default::default() };
        assert!(matches!(credit(c, 10, &p), Err(MineError::SiteDailyCapReached)));
        // a new day frees it
        assert!(credit(c, 11, &p).is_ok());
    }

    #[test]
    fn credit_budget() {
        let p = params();
        let c = Counters { total_credited: 950, ..Default::default() };
        assert!(matches!(credit(c, 0, &p), Err(MineError::BudgetExhausted)));
        let c = Counters { total_credited: 900, ..Default::default() };
        assert_eq!(credit(c, 0, &p).unwrap().total_credited, 1_000);
    }

    #[test]
    fn credit_overflow_is_an_error_not_a_wrap() {
        let p = ParamValues { reward_per_proof: 2, wallet_daily_cap: u64::MAX, site_daily_cap: u64::MAX, total_budget: u64::MAX, ..params() };
        let c = Counters { wallet_accrued: u64::MAX - 1, ..Default::default() };
        assert!(matches!(credit(c, 0, &p), Err(MineError::MathOverflow)));
        let c = Counters { total_credited: u64::MAX - 1, ..Default::default() };
        assert!(matches!(credit(c, 0, &p), Err(MineError::MathOverflow)));
    }

    #[test]
    fn withdrawable_keeps_miner_balances() {
        assert_eq!(withdrawable(1_000, 400, 100, false).unwrap(), 700);
        assert_eq!(withdrawable(200, 400, 100, false).unwrap(), 0);
        assert_eq!(withdrawable(200, 400, 100, true).unwrap(), 200);
        assert!(withdrawable(1, 1, 2, false).is_err());
    }

    // ---- ed25519 instruction parsing
    fn ed_ix(pk: [u8; 32], msg: &[u8]) -> Vec<u8> {
        // the layout @solana/web3.js Ed25519Program builds
        let pk_off = 16u16;
        let sig_off = 48u16;
        let msg_off = 112u16;
        let mut d = vec![1u8, 0];
        for v in [sig_off, u16::MAX, pk_off, u16::MAX, msg_off, msg.len() as u16, u16::MAX] {
            d.extend_from_slice(&v.to_le_bytes());
        }
        d.extend_from_slice(&pk);
        d.extend_from_slice(&[0u8; 64]);
        d.extend_from_slice(msg);
        d
    }

    #[test]
    fn ed25519_parse_ok() {
        let msg = challenge_message(&pk(1), &pk(2), 3, 20, 99);
        let d = ed_ix([5u8; 32], &msg);
        let (k, m) = parse_ed25519_single(&d).unwrap();
        assert_eq!(k, [5u8; 32]);
        assert_eq!(m, &msg[..]);
    }

    #[test]
    fn ed25519_parse_rejects_other_instruction_indexes() {
        let msg = [1u8; 10];
        for field in [1usize, 3, 6] {
            let mut d = ed_ix([5u8; 32], &msg);
            let at = 2 + 2 * field;
            d[at..at + 2].copy_from_slice(&0u16.to_le_bytes());
            assert!(matches!(parse_ed25519_single(&d), Err(MineError::BadEd25519Instruction)));
        }
    }

    #[test]
    fn ed25519_parse_rejects_bad_shapes() {
        let msg = [1u8; 10];
        let mut d = ed_ix([5u8; 32], &msg);
        d[0] = 2; // two signatures
        assert!(parse_ed25519_single(&d).is_err());
        d[0] = 0;
        assert!(parse_ed25519_single(&d).is_err());
        assert!(parse_ed25519_single(&[1, 0, 0]).is_err());
        let mut d = ed_ix([5u8; 32], &msg);
        let len = d.len();
        d.truncate(len - 1); // message runs past the end
        assert!(parse_ed25519_single(&d).is_err());
        let mut d = ed_ix([5u8; 32], &msg);
        d[2 + 4..2 + 6].copy_from_slice(&u16::MAX.to_le_bytes()); // pubkey offset out of range
        assert!(parse_ed25519_single(&d).is_err());
    }
}
