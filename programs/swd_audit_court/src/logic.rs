// Pure rules of the SWD Audit Court (no accounts, no syscalls), covered by
// `cargo test -p swd_audit_court`. lib.rs reads accounts, calls these and
// moves tokens exactly as they say.

pub const BPS: u64 = 10_000;
pub const MAX_BADGES: usize = 8;
pub const MAX_BADGE_WEIGHT: u16 = 1_000;

/// Voting period bounds. The mainnet build refuses anything under 3 days so
/// a dispute cannot be rushed through before holders notice.
#[cfg(feature = "mainnet")]
pub const MIN_VOTING_SECS: i64 = 3 * 86_400;
#[cfg(not(feature = "mainnet"))]
pub const MIN_VOTING_SECS: i64 = 5; // localnet tests
pub const MAX_VOTING_SECS: i64 = 30 * 86_400;

/// A majority means strictly more than `pass_bps` of the cast weight.
pub const MIN_PASS_BPS: u16 = 5_000;
pub const MAX_PASS_BPS: u16 = 9_000;

pub const STATUS_VOTING: u8 = 0;
pub const STATUS_UPHELD: u8 = 1;
pub const STATUS_REJECTED: u8 = 2;
pub const STATUS_NO_QUORUM: u8 = 3;
pub const STATUS_CANCELLED: u8 = 4;

/// `claimed_level` when the opener disputes the record without naming a level.
pub const NO_CLAIM: u8 = 255;
/// Highest SWD Audit level (registry: info 0, low 1, medium 2, high 3).
pub const LEVEL_HIGH: u8 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// the dispute wins: the audit result should be corrected
    Upheld,
    /// the audit result stands
    Rejected,
    /// too little weight voted: nobody loses anything
    NoQuorum,
}

impl Outcome {
    pub fn status(self) -> u8 {
        match self {
            Outcome::Upheld => STATUS_UPHELD,
            Outcome::Rejected => STATUS_REJECTED,
            Outcome::NoQuorum => STATUS_NO_QUORUM,
        }
    }
}

pub fn outcome(yes: u64, no: u64, quorum: u64, pass_bps: u16) -> Outcome {
    let total = yes as u128 + no as u128;
    if total == 0 || total < quorum as u128 {
        return Outcome::NoQuorum;
    }
    if (yes as u128) * (BPS as u128) > total * (pass_bps as u128) {
        Outcome::Upheld
    } else {
        Outcome::Rejected
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Payout {
    pub to_opener: u64,
    pub to_defender: u64,
    pub to_treasury: u64,
}

impl Payout {
    pub fn total(&self) -> u128 {
        self.to_opener as u128 + self.to_defender as u128 + self.to_treasury as u128
    }
}

/// Where the escrow goes. `None` = refund everyone (no quorum / cancelled).
/// The vault holds `bond` (opener) plus `bond` again if there is a defender;
/// the sum of the payout always equals exactly that.
pub fn payout(o: Option<Outcome>, bond: u64, has_defender: bool, winner_share_bps: u16) -> Payout {
    let defender_bond = if has_defender { bond } else { 0 };
    let share = |loser_bond: u64| -> u64 {
        ((loser_bond as u128) * (winner_share_bps.min(BPS as u16) as u128) / BPS as u128) as u64
    };
    match o {
        None | Some(Outcome::NoQuorum) => Payout {
            to_opener: bond,
            to_defender: defender_bond,
            to_treasury: 0,
        },
        Some(Outcome::Upheld) => {
            let s = share(defender_bond);
            Payout {
                to_opener: bond + s,
                to_defender: 0,
                to_treasury: defender_bond - s,
            }
        }
        Some(Outcome::Rejected) => {
            if has_defender {
                let s = share(bond);
                Payout {
                    to_opener: 0,
                    to_defender: defender_bond + s,
                    to_treasury: bond - s,
                }
            } else {
                Payout {
                    to_opener: 0,
                    to_defender: 0,
                    to_treasury: bond,
                }
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParamError {
    ZeroBond,
    VotingPeriod,
    ZeroQuorum,
    PassBps,
    WinnerShareBps,
    TooManyBadges,
    NoBadges,
    DuplicateBadge,
    BadgeWeight,
}

pub struct CourtParamsView<'a> {
    pub bond_amount: u64,
    pub voting_secs: i64,
    pub quorum_weight: u64,
    pub pass_bps: u16,
    pub winner_share_bps: u16,
    pub badges: &'a [([u8; 32], u16)],
}

pub fn validate_params(p: &CourtParamsView) -> Result<(), ParamError> {
    if p.bond_amount == 0 {
        return Err(ParamError::ZeroBond);
    }
    if p.voting_secs < MIN_VOTING_SECS || p.voting_secs > MAX_VOTING_SECS {
        return Err(ParamError::VotingPeriod);
    }
    if p.quorum_weight == 0 {
        return Err(ParamError::ZeroQuorum);
    }
    if p.pass_bps < MIN_PASS_BPS || p.pass_bps > MAX_PASS_BPS {
        return Err(ParamError::PassBps);
    }
    if p.winner_share_bps as u64 > BPS {
        return Err(ParamError::WinnerShareBps);
    }
    if p.badges.is_empty() {
        return Err(ParamError::NoBadges);
    }
    if p.badges.len() > MAX_BADGES {
        return Err(ParamError::TooManyBadges);
    }
    for (i, (m, w)) in p.badges.iter().enumerate() {
        if *w == 0 || *w > MAX_BADGE_WEIGHT {
            return Err(ParamError::BadgeWeight);
        }
        if p.badges[..i].iter().any(|(o, _)| o == m) {
            return Err(ParamError::DuplicateBadge);
        }
    }
    Ok(())
}

/// Sums the weights of the DISTINCT badge mints a voter proved; a mint passed
/// twice counts once. Returns 0 if none is configured.
pub fn vote_weight(badges: &[([u8; 32], u16)], proven_mints: &[[u8; 32]]) -> u64 {
    let mut seen: Vec<[u8; 32]> = Vec::with_capacity(proven_mints.len());
    let mut w = 0u64;
    for m in proven_mints {
        if seen.contains(m) {
            continue;
        }
        seen.push(*m);
        if let Some((_, bw)) = badges.iter().find(|(b, _)| b == m) {
            w += *bw as u64;
        }
    }
    w
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outcomes() {
        // quorum
        assert_eq!(outcome(0, 0, 1, 5_000), Outcome::NoQuorum);
        assert_eq!(outcome(4, 5, 10, 5_000), Outcome::NoQuorum);
        // strict majority
        assert_eq!(outcome(5, 5, 10, 5_000), Outcome::Rejected);
        assert_eq!(outcome(6, 5, 10, 5_000), Outcome::Upheld);
        assert_eq!(outcome(10, 0, 10, 5_000), Outcome::Upheld);
        assert_eq!(outcome(0, 10, 10, 5_000), Outcome::Rejected);
        // supermajority 2/3
        assert_eq!(outcome(66, 34, 10, 6_667), Outcome::Rejected);
        assert_eq!(outcome(67, 33, 10, 6_667), Outcome::Upheld);
        // no overflow
        assert_eq!(
            outcome(u64::MAX, u64::MAX, u64::MAX, 5_000),
            Outcome::Rejected
        );
        assert_eq!(outcome(u64::MAX, 0, u64::MAX, 9_000), Outcome::Upheld);
    }

    #[test]
    fn payouts_conserve_the_escrow() {
        for bond in [1u64, 7, 1_000, 123_456_789, u64::MAX / 2] {
            for share in [0u16, 1, 2_500, 5_000, 9_999, 10_000] {
                for d in [false, true] {
                    for o in [
                        None,
                        Some(Outcome::NoQuorum),
                        Some(Outcome::Upheld),
                        Some(Outcome::Rejected),
                    ] {
                        let p = payout(o, bond, d, share);
                        let escrow = bond as u128 * if d { 2 } else { 1 };
                        assert_eq!(p.total(), escrow, "{o:?} bond={bond} share={share} d={d}");
                        if !d {
                            assert_eq!(p.to_defender, 0);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn payout_cases() {
        // refund
        assert_eq!(
            payout(None, 100, true, 5_000),
            Payout {
                to_opener: 100,
                to_defender: 100,
                to_treasury: 0
            }
        );
        assert_eq!(
            payout(Some(Outcome::NoQuorum), 100, false, 5_000),
            Payout {
                to_opener: 100,
                to_defender: 0,
                to_treasury: 0
            }
        );
        // upheld: opener gets its bond back + share of the defender's
        assert_eq!(
            payout(Some(Outcome::Upheld), 100, true, 5_000),
            Payout {
                to_opener: 150,
                to_defender: 0,
                to_treasury: 50
            }
        );
        assert_eq!(
            payout(Some(Outcome::Upheld), 100, false, 5_000),
            Payout {
                to_opener: 100,
                to_defender: 0,
                to_treasury: 0
            }
        );
        // rejected: defender gets its bond back + share; with no defender the bond goes to the treasury
        assert_eq!(
            payout(Some(Outcome::Rejected), 100, true, 5_000),
            Payout {
                to_opener: 0,
                to_defender: 150,
                to_treasury: 50
            }
        );
        assert_eq!(
            payout(Some(Outcome::Rejected), 100, false, 5_000),
            Payout {
                to_opener: 0,
                to_defender: 0,
                to_treasury: 100
            }
        );
        assert_eq!(
            payout(Some(Outcome::Rejected), 100, true, 10_000),
            Payout {
                to_opener: 0,
                to_defender: 200,
                to_treasury: 0
            }
        );
        assert_eq!(
            payout(Some(Outcome::Upheld), 100, true, 0),
            Payout {
                to_opener: 100,
                to_defender: 0,
                to_treasury: 100
            }
        );
    }

    fn params(b: &[([u8; 32], u16)]) -> CourtParamsView<'_> {
        CourtParamsView {
            bond_amount: 1,
            voting_secs: MIN_VOTING_SECS,
            quorum_weight: 1,
            pass_bps: 5_000,
            winner_share_bps: 5_000,
            badges: b,
        }
    }

    #[test]
    fn params_validation() {
        let b = [([1; 32], 1u16), ([2; 32], 3)];
        assert!(validate_params(&params(&b)).is_ok());
        assert_eq!(
            validate_params(&CourtParamsView {
                bond_amount: 0,
                ..params(&b)
            }),
            Err(ParamError::ZeroBond)
        );
        assert_eq!(
            validate_params(&CourtParamsView {
                voting_secs: MIN_VOTING_SECS - 1,
                ..params(&b)
            }),
            Err(ParamError::VotingPeriod)
        );
        assert_eq!(
            validate_params(&CourtParamsView {
                voting_secs: MAX_VOTING_SECS + 1,
                ..params(&b)
            }),
            Err(ParamError::VotingPeriod)
        );
        assert_eq!(
            validate_params(&CourtParamsView {
                quorum_weight: 0,
                ..params(&b)
            }),
            Err(ParamError::ZeroQuorum)
        );
        assert_eq!(
            validate_params(&CourtParamsView {
                pass_bps: 4_999,
                ..params(&b)
            }),
            Err(ParamError::PassBps)
        );
        assert_eq!(
            validate_params(&CourtParamsView {
                pass_bps: 9_001,
                ..params(&b)
            }),
            Err(ParamError::PassBps)
        );
        assert_eq!(
            validate_params(&CourtParamsView {
                winner_share_bps: 10_001,
                ..params(&b)
            }),
            Err(ParamError::WinnerShareBps)
        );
        assert_eq!(validate_params(&params(&[])), Err(ParamError::NoBadges));
        assert_eq!(
            validate_params(&params(&[([1; 32], 1); 9])),
            Err(ParamError::TooManyBadges)
        );
        assert_eq!(
            validate_params(&params(&[([1; 32], 1), ([1; 32], 2)])),
            Err(ParamError::DuplicateBadge)
        );
        assert_eq!(
            validate_params(&params(&[([1; 32], 0)])),
            Err(ParamError::BadgeWeight)
        );
        assert_eq!(
            validate_params(&params(&[([1; 32], MAX_BADGE_WEIGHT + 1)])),
            Err(ParamError::BadgeWeight)
        );
    }

    #[test]
    fn weights() {
        let b = [([1; 32], 1u16), ([2; 32], 3)];
        assert_eq!(vote_weight(&b, &[]), 0);
        assert_eq!(vote_weight(&b, &[[1; 32]]), 1);
        assert_eq!(vote_weight(&b, &[[1; 32], [2; 32]]), 4);
        assert_eq!(vote_weight(&b, &[[2; 32], [2; 32], [2; 32]]), 3); // no double counting
        assert_eq!(vote_weight(&b, &[[9; 32]]), 0);
    }
}
