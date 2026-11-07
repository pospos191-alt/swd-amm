# SWD Pay for WooCommerce

A WooCommerce payment gateway that accepts **SWD (SAWASDEE COIN)** and **USDC** on Solana through
**Solana Pay**. Non-custodial: payments go straight to the merchant's wallet; the plugin only knows the public address.

ภาษาไทย (สำหรับเจ้าของร้าน): [README.th.md](README.th.md)

## How it works

1. **Checkout** — the customer picks "Pay with SWD or USDC". The order is created as *Pending payment* with a fresh
   **reference key** (32 random bytes, base58; unique per order) and a **quote** per accepted token
   (`order total ÷ price`, rounded **up** to the token's smallest unit, exact integer math).
2. **Thank-you page** — a QR code per token (drawn in the browser with a bundled QR library; no third-party QR
   service) for the Solana Pay **transfer request**:
   `solana:<wallet>?amount=<amount>&spl-token=<mint>&reference=<reference>&label=<shop>&message=Order%20%23123`,
   plus an "Open in wallet" link for phones.
3. **Verification (server-side)** — the page polls `admin-ajax.php?action=swd_pay_status` (nonce + order key; at most
   one RPC check per order every 8 s). A WP-Cron job (every 5 min) also checks unpaid orders from the last 2 days, so a
   payment is recorded even if the customer closed the page. Each check asks **the merchant's RPC**:
   - `getSignaturesForAddress(reference)` → the transactions that carry the order's reference;
   - `getTransaction(sig, jsonParsed)` → the transaction **succeeded**, the reference is one of its accounts, and the
     token accounts **owned by the merchant wallet** gained **≥ the quoted amount** of the quoted **mint** with the
     expected **decimals** (from `pre/postTokenBalances`), within the quote's validity;
   - the signature has not already paid **another** order (one transaction can carry several references).
4. **Paid** — `payment_complete($signature)`, an order note with the Solscan link. A smaller payment leaves the order
   unpaid with a note for the merchant.

Admin → order → "Order actions" → **Check Solana Pay payment now** runs a check by hand.

## Settings (WooCommerce → Settings → Payments → SWD Pay)

| Setting | Notes |
| --- | --- |
| Wallet | the **public** Solana address that receives payments (validated) |
| RPC URL | https only. The public endpoint rate-limits; use your own (Helius, QuickNode, Triton, ...) |
| Confirmation level | `confirmed` (≈1 s) or `finalized` (≈15 s) |
| Accept SWD / USDC | SWD `Cmh2tu6bt5z2a8NKsx6G5WfVmaeQ9f2fcX5VnQbVaGLL` (5 decimals), USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (6 decimals) |
| Price conversion | **Fixed rate** (store currency per 1 token, never expires) or **Jupiter market price** (`lite-api.jup.ag/price/v3`, USD × your "store currency per 1 USD" rate; cached 60 s) |
| Quote validity | market quotes expire (default 15 min); the page shows a countdown and re-quotes on reload. The last 6 quotes stay payable until they expire. |
| Name shown in the wallet | Solana Pay `label` |
| Debug log | order ids and statuses only |

## Security notes

- No private key anywhere. The merchant's wallet is a public address; customers sign in their own wallet.
- Settings use the WooCommerce settings API (capability + nonce); every value is validated (`validate_*_field`).
- The status endpoint needs the page's nonce **and** the order key (`hash_equals`), and is rate-limited per order.
- All output is escaped (`esc_html`, `esc_attr`, `esc_url` with the `solana` protocol allowed only for the wallet link).
- RPC errors are never read as "not paid" or "paid": the check simply runs again later.
- A manual transfer (without the reference) is not detected automatically; the page says so and the merchant can
  complete the order by hand.
- Refunds are manual (send from your wallet; add a note).
- WordPress Coding Standards: `phpcs --standard=WordPress` passes (tests excluded).

## Install

1. Build the zip: `sh scripts/zip.sh` → `dist/woocommerce-swd-pay.zip` (or zip this folder).
2. WordPress → Plugins → Add New → Upload Plugin → activate (WooCommerce 8.0+ required).
3. WooCommerce → Settings → Payments → **SWD Pay** → enter the wallet, RPC, prices → enable.
4. Place a small test order and pay it (e.g. 0.10 USDC) before going live.
5. Make sure WP-Cron runs (a real cron hitting `wp-cron.php` is best on low-traffic shops).

## Test (developers)

```bash
cd integrations/woocommerce-swd-pay
php tests/run.php                 # 52 offline checks: math, quotes, Solana Pay URL, matcher, RPC flow (fake transport)
php tests/gateway-smoke.php       # the gateway with WordPress/WooCommerce stand-ins: settings, checkout, payment box, check_order
for f in $(find . -name '*.php'); do php -l "$f"; done
phpcs --standard=WordPress --extensions=php --ignore='*/tests/*' .   # needs wp-coding-standards/wpcs 3.x
```

Third-party code: `assets/js/vendor/qrcode-generator.js` — QR Code Generator for JavaScript v2.0.4, © Kazuhiko Arase,
MIT license (notice kept in the file).

## Shopify

Shopify does not allow arbitrary payment plugins: a checkout payment method must be an **approved Shopify Payments
App** (built on the Payments Apps API, reviewed by Shopify), and this WooCommerce code cannot be reused there. Options:

1. **Solana Pay for Shopify** — the official app (Solana Pay / Solana Labs, now operated with **Helio**, part of
   MoonPay). It accepts USDC (and other tokens through its converter) at Shopify checkout. Install it from the
   Shopify App Store and point it at your wallet; check its current token list and fees.
2. **Helio** checkout / pay links — Helio supports many Solana SPL tokens; ask Helio whether SWD can be enabled as a
   payment currency.
3. **A Shopify Payments App of our own** — possible but long: Shopify partner account, Payments Apps API, PCI-style
   review and onboarding. Only worth it at volume.
4. **Off-checkout** — a manual payment method ("Pay with SWD") plus a Solana Pay link sent with the order
   confirmation, marked paid by staff; or sell SWD-priced items via a Solana Pay link / Blink outside Shopify checkout.

This folder contains WooCommerce code only.
