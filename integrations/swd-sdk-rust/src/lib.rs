//! # swd-sdk
//!
//! Client for the public **SWD (SAWASDEE COIN)** APIs (`https://swd-zetaphy.sawasdeecoin.com`): SWD Audit of
//! contracts on 14 chains, transaction checks, SWD supply, and the Buy SWD Solana Action (unsigned transactions only:
//! this crate never holds or asks for a private key).
//!
//! - [`SwdClient`] — async (reqwest, any tokio runtime)
//! - [`blocking::SwdClient`] — blocking (feature `blocking`, on by default)
//! - [`registry`] — PDA derivation and a byte-layout parser for the on-chain SWD Audit Registry (feature `registry`)
//!
//! ```no_run
//! # fn main() -> Result<(), swd_sdk::SwdError> {
//! let swd = swd_sdk::blocking::SwdClient::new()?;
//! let a = swd.audit("sol", swd_sdk::SWD_MINT, "en", false)?;
//! println!("{} {}", a.level.as_str(), a.permalink);
//! # Ok(()) }
//! ```

mod client;
mod core;
mod error;
pub mod types;

#[cfg(feature = "blocking")]
pub mod blocking;
#[cfg(feature = "registry")]
pub mod registry;

pub use crate::core::{check_sol_amount, DEFAULT_BASE_URL, SWD_DECIMALS, SWD_MINT};
pub use client::SwdClient;
pub use error::SwdError;
pub use types::*;
