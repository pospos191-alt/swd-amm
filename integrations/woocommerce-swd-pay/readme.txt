=== SWD Pay for WooCommerce (Solana Pay: SWD, USDC) ===
Contributors: sawasdeecoin
Tags: solana, solana pay, crypto, usdc, payment gateway
Requires at least: 6.2
Tested up to: 6.8
Requires PHP: 7.4
WC requires at least: 8.0
Stable tag: 0.1.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Accept SWD (SAWASDEE COIN) and USDC on Solana with Solana Pay. Payments go straight to your wallet and are verified on-chain.

== Description ==

* Customers pay by scanning a Solana Pay QR code (Phantom, Solflare, Backpack, ...) or tapping "Open in wallet".
* Each order gets its own reference key, so the payment is matched to the order automatically.
* The plugin checks the payment on-chain through your Solana RPC: the transaction succeeded, carries the order's
  reference, and sent at least the quoted amount of the right token (mint and decimals) to your wallet. Then the
  order is marked paid.
* Prices: a fixed rate you set, or the market price from Jupiter's Price API (USD, with your currency rate).
* Works with the classic and the block checkout, and with WooCommerce order tables (HPOS).
* Non-custodial: the plugin only knows your public address. It never asks for a private key.

== External services ==

* **Your Solana RPC** (default `https://api.mainnet-beta.solana.com`): `getSignaturesForAddress` and
  `getTransaction` for the order's reference key, to verify payments. Sent: the reference key and transaction
  signatures. No customer data.
* **Jupiter Price API** (`https://lite-api.jup.ag/price/v3`), only in "market price" mode: the token mint addresses.
  Terms: https://dev.jup.ag/ . No customer data.

== Frequently Asked Questions ==

= Is a payment final? =
Solana transfers cannot be reversed by the plugin. Refunds are sent manually from your wallet.

= What if the customer pays less? =
The order stays unpaid and gets a note with the transaction link. Settle it with the customer.

== Changelog ==

= 0.1.0 =
* First release.
