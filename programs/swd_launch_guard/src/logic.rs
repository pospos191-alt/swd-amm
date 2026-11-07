// Pure rules of the SWD Launch Guard (no accounts, no syscalls), so
// `cargo test -p swd_launch_guard` covers every decision the hook makes.
// lib.rs only reads accounts, calls these, and writes the result back.

/// Hard maximum of the launch window, in seconds (24 h). Enforced at
/// initialisation; no instruction can ever move `window_end` later.
pub const MAX_WINDOW_SECS: i64 = 86_400;
/// `launch_ts` may be at most this far in the future when the guard is
/// created (7 days). Together with `MAX_WINDOW_SECS` this bounds the whole
/// restricted period: nothing is ever restricted later than
/// `created_at + MAX_LAUNCH_DELAY_SECS + MAX_WINDOW_SECS` (8 days).
pub const MAX_LAUNCH_DELAY_SECS: i64 = 7 * 86_400;
/// Launch wallets (pool-vault authorities, the creator) per mint.
pub const MAX_LAUNCH_WALLETS: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    /// Most a non-launch wallet may receive in ONE transfer from a launch wallet.
    pub max_per_transfer: u64,
    /// Most it may receive from launch wallets in total during the window.
    pub max_per_wallet: u64,
    /// Seconds between two receipts (0 = no cooldown).
    pub cooldown_secs: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// before `launch_ts`: transfers out of launch wallets to outsiders are refused
    PreLaunch,
    /// `launch_ts <= now < window_end`: caps apply
    Window,
    /// `now >= window_end`: the hook does nothing, for good
    Over,
}

pub fn phase(launch_ts: i64, window_end: i64, now: i64) -> Phase {
    if now >= window_end {
        Phase::Over
    } else if now < launch_ts {
        Phase::PreLaunch
    } else {
        Phase::Window
    }
}

/// The only transfers the guard ever looks at: tokens leaving a launch wallet
/// (a pool vault = a buy, or the creator = a distribution) for a wallet that
/// is NOT a launch wallet. Anything a holder sends — to a pool (a sell), to
/// another wallet, anywhere — has a non-launch source and is never restricted.
pub fn is_restricted(source_is_launch: bool, dest_is_launch: bool) -> bool {
    source_is_launch && !dest_is_launch
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Violation {
    NotOpen,
    OverPerTransfer,
    OverPerWallet,
    Cooldown,
    Overflow,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Received {
    pub received: u64,
    pub transfers: u32,
    pub last_receive_ts: i64,
}

/// Checks one restricted transfer of `amount` (in the Window phase) against the
/// limits and returns the recipient's new totals. Nothing is written on error.
pub fn check_receive(
    l: &Limits,
    r: &Received,
    amount: u64,
    now: i64,
) -> Result<Received, Violation> {
    if amount > l.max_per_transfer {
        return Err(Violation::OverPerTransfer);
    }
    let total = r.received.checked_add(amount).ok_or(Violation::Overflow)?;
    if total > l.max_per_wallet {
        return Err(Violation::OverPerWallet);
    }
    if l.cooldown_secs > 0 && r.transfers > 0 {
        let next = r.last_receive_ts.saturating_add(l.cooldown_secs);
        if now < next {
            return Err(Violation::Cooldown);
        }
    }
    Ok(Received {
        received: total,
        transfers: r.transfers.saturating_add(1),
        last_receive_ts: now,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParamError {
    WindowTooLong,
    WindowEmpty,
    LaunchTooFar,
    ZeroCap,
    WalletCapBelowTransferCap,
    BadCooldown,
    TooManyLaunchWallets,
    DuplicateLaunchWallet,
    NotLooser,
}

/// Validates the initial parameters and returns `window_end`.
pub fn validate_init(
    now: i64,
    launch_ts: i64,
    window_secs: i64,
    l: &Limits,
) -> Result<i64, ParamError> {
    if window_secs <= 0 {
        return Err(ParamError::WindowEmpty);
    }
    if window_secs > MAX_WINDOW_SECS {
        return Err(ParamError::WindowTooLong);
    }
    if launch_ts > now.saturating_add(MAX_LAUNCH_DELAY_SECS) {
        return Err(ParamError::LaunchTooFar);
    }
    validate_limits(l, window_secs)?;
    // cannot overflow: launch_ts <= now + 7d and window_secs <= 24h
    Ok(launch_ts.saturating_add(window_secs))
}

pub fn validate_limits(l: &Limits, window_secs: i64) -> Result<(), ParamError> {
    if l.max_per_transfer == 0 {
        return Err(ParamError::ZeroCap);
    }
    if l.max_per_wallet < l.max_per_transfer {
        return Err(ParamError::WalletCapBelowTransferCap);
    }
    if l.cooldown_secs < 0 || l.cooldown_secs > window_secs.max(0) {
        return Err(ParamError::BadCooldown);
    }
    Ok(())
}

/// The authority may only LOOSEN the limits after creation: caps up (or
/// equal), cooldown down (or equal). Returns the new limits.
pub fn validate_relax(old: &Limits, new: &Limits) -> Result<Limits, ParamError> {
    if new.max_per_transfer < old.max_per_transfer
        || new.max_per_wallet < old.max_per_wallet
        || new.cooldown_secs > old.cooldown_secs
        || new.cooldown_secs < 0
    {
        return Err(ParamError::NotLooser);
    }
    if new.max_per_wallet < new.max_per_transfer {
        return Err(ParamError::WalletCapBelowTransferCap);
    }
    Ok(*new)
}

/// Ending the window early: `window_end` can only move EARLIER (never later),
/// and a pending launch starts now. Returns (launch_ts, window_end).
pub fn end_early(launch_ts: i64, window_end: i64, now: i64) -> (i64, i64) {
    let end = window_end.min(now);
    (launch_ts.min(end), end)
}

pub fn validate_launch_wallets(list: &[[u8; 32]]) -> Result<(), ParamError> {
    if list.len() > MAX_LAUNCH_WALLETS {
        return Err(ParamError::TooManyLaunchWallets);
    }
    for (i, a) in list.iter().enumerate() {
        if list[..i].contains(a) {
            return Err(ParamError::DuplicateLaunchWallet);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const L: Limits = Limits {
        max_per_transfer: 100,
        max_per_wallet: 250,
        cooldown_secs: 30,
    };

    #[test]
    fn phases() {
        assert_eq!(phase(100, 200, 99), Phase::PreLaunch);
        assert_eq!(phase(100, 200, 100), Phase::Window);
        assert_eq!(phase(100, 200, 199), Phase::Window);
        assert_eq!(phase(100, 200, 200), Phase::Over);
        assert_eq!(phase(100, 200, i64::MAX), Phase::Over);
    }

    #[test]
    fn only_launch_to_outsider_is_restricted() {
        assert!(is_restricted(true, false)); // buy from a pool / creator distribution
        assert!(!is_restricted(true, true)); // creator -> pool (liquidity)
        assert!(!is_restricted(false, true)); // SELL: holder -> pool, never restricted
        assert!(!is_restricted(false, false)); // holder -> holder, never restricted
    }

    #[test]
    fn sells_never_restricted_in_any_phase() {
        // a holder is never a launch wallet; whatever the clock says
        for now in [0, 99, 100, 150, 199, 200, 10_000] {
            let _ = phase(100, 200, now);
            assert!(!is_restricted(false, true));
            assert!(!is_restricted(false, false));
        }
    }

    #[test]
    fn per_transfer_cap() {
        let r = Received::default();
        assert_eq!(
            check_receive(&L, &r, 101, 0),
            Err(Violation::OverPerTransfer)
        );
        let r = check_receive(&L, &r, 100, 0).unwrap();
        assert_eq!(
            r,
            Received {
                received: 100,
                transfers: 1,
                last_receive_ts: 0
            }
        );
    }

    #[test]
    fn cumulative_cap() {
        let mut r = Received::default();
        r = check_receive(&L, &r, 100, 0).unwrap();
        r = check_receive(&L, &r, 100, 30).unwrap();
        assert_eq!(check_receive(&L, &r, 51, 60), Err(Violation::OverPerWallet));
        r = check_receive(&L, &r, 50, 60).unwrap();
        assert_eq!(r.received, 250);
        assert_eq!(
            check_receive(&L, &r, 1, 1000),
            Err(Violation::OverPerWallet)
        );
    }

    #[test]
    fn cooldown() {
        let r = check_receive(&L, &Received::default(), 10, 100).unwrap();
        assert_eq!(check_receive(&L, &r, 10, 129), Err(Violation::Cooldown));
        assert!(check_receive(&L, &r, 10, 130).is_ok());
        let no_cd = Limits {
            cooldown_secs: 0,
            ..L
        };
        assert!(check_receive(&no_cd, &r, 10, 100).is_ok());
    }

    #[test]
    fn overflow_is_an_error() {
        let big = Limits {
            max_per_transfer: u64::MAX,
            max_per_wallet: u64::MAX,
            cooldown_secs: 0,
        };
        let r = Received {
            received: u64::MAX,
            transfers: 1,
            last_receive_ts: 0,
        };
        assert_eq!(check_receive(&big, &r, 1, 0), Err(Violation::Overflow));
    }

    #[test]
    fn max_window_enforced() {
        assert_eq!(
            validate_init(0, 0, MAX_WINDOW_SECS, &L),
            Ok(MAX_WINDOW_SECS)
        );
        assert_eq!(
            validate_init(0, 0, MAX_WINDOW_SECS + 1, &L),
            Err(ParamError::WindowTooLong)
        );
        assert_eq!(validate_init(0, 0, 0, &L), Err(ParamError::WindowEmpty));
        assert_eq!(validate_init(0, 0, -5, &L), Err(ParamError::WindowEmpty));
        assert_eq!(
            validate_init(0, MAX_LAUNCH_DELAY_SECS + 1, 60, &L),
            Err(ParamError::LaunchTooFar)
        );
        // worst case: everything ends within 8 days of creation
        let end = validate_init(1_000, 1_000 + MAX_LAUNCH_DELAY_SECS, MAX_WINDOW_SECS, &L).unwrap();
        assert_eq!(end, 1_000 + MAX_LAUNCH_DELAY_SECS + MAX_WINDOW_SECS);
        // extreme clock values do not wrap
        assert!(validate_init(i64::MAX, i64::MAX, 60, &L).is_ok());
    }

    #[test]
    fn limits_validation() {
        assert_eq!(
            validate_limits(
                &Limits {
                    max_per_transfer: 0,
                    ..L
                },
                60
            ),
            Err(ParamError::ZeroCap)
        );
        assert_eq!(
            validate_limits(
                &Limits {
                    max_per_wallet: 99,
                    ..L
                },
                60
            ),
            Err(ParamError::WalletCapBelowTransferCap)
        );
        assert_eq!(
            validate_limits(
                &Limits {
                    cooldown_secs: 61,
                    ..L
                },
                60
            ),
            Err(ParamError::BadCooldown)
        );
        assert_eq!(
            validate_limits(
                &Limits {
                    cooldown_secs: -1,
                    ..L
                },
                60
            ),
            Err(ParamError::BadCooldown)
        );
        assert!(validate_limits(&L, 60).is_ok());
    }

    #[test]
    fn relax_only_loosens() {
        assert!(validate_relax(&L, &L).is_ok());
        assert!(validate_relax(
            &L,
            &Limits {
                max_per_transfer: 200,
                max_per_wallet: 500,
                cooldown_secs: 0
            }
        )
        .is_ok());
        assert_eq!(
            validate_relax(
                &L,
                &Limits {
                    max_per_transfer: 99,
                    ..L
                }
            ),
            Err(ParamError::NotLooser)
        );
        assert_eq!(
            validate_relax(
                &L,
                &Limits {
                    max_per_wallet: 249,
                    ..L
                }
            ),
            Err(ParamError::NotLooser)
        );
        assert_eq!(
            validate_relax(
                &L,
                &Limits {
                    cooldown_secs: 31,
                    ..L
                }
            ),
            Err(ParamError::NotLooser)
        );
        assert_eq!(
            validate_relax(
                &L,
                &Limits {
                    max_per_transfer: 300,
                    max_per_wallet: 250,
                    cooldown_secs: 30
                }
            ),
            Err(ParamError::WalletCapBelowTransferCap)
        );
    }

    #[test]
    fn end_early_never_extends() {
        // in the window
        assert_eq!(end_early(100, 200, 150), (100, 150));
        // before launch: the launch starts (and ends) now
        assert_eq!(end_early(100, 200, 50), (50, 50));
        // after the end: unchanged, never later
        assert_eq!(end_early(100, 200, 500), (100, 200));
        for now in [-10, 0, 99, 100, 199, 200, 1_000_000] {
            let (l, e) = end_early(100, 200, now);
            assert!(e <= 200 && l <= e);
            assert_eq!(phase(l, e, now.max(e)), Phase::Over);
        }
    }

    #[test]
    fn launch_wallet_list() {
        assert!(validate_launch_wallets(&[[1; 32], [2; 32]]).is_ok());
        assert_eq!(
            validate_launch_wallets(&[[1; 32], [1; 32]]),
            Err(ParamError::DuplicateLaunchWallet)
        );
        assert_eq!(
            validate_launch_wallets(&[[0; 32]; 9]),
            Err(ParamError::TooManyLaunchWallets)
        );
    }
}
