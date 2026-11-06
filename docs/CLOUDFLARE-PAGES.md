# ZETAPHY sites on Cloudflare Pages

Thai: [CLOUDFLARE-PAGES.th.md](CLOUDFLARE-PAGES.th.md)

**Why.** On 2026-11-06 Vercel paused the whole team (all sites) for going over the free Hobby plan's function CPU limit (4 hours per 30 days). It unpauses on 2026-12-06. The six ZETAPHY sites are static files and need no functions, so they move to Cloudflare Pages. On its free plan, static requests are not metered. The domain is already on Cloudflare, so its DNS stays where it is.

| Site | Cloudflare Pages project | Domain |
|---|---|---|
| Hub | `zetaphy-hub` | app.sawasdeecoin.com |
| Wallet | `zetaphy-wallet` | wallet.sawasdeecoin.com |
| Swap | `zetaphy-swap` | swap.sawasdeecoin.com |
| NFT | `zetaphy-nft` | nft.sawasdeecoin.com |
| Explorer | `zetaphy-explorer` | explorer.sawasdeecoin.com |
| Neuro (pages) | `zetaphy-neuro` | neuro.sawasdeecoin.com |

**How it works.** `.github/workflows/cf-pages.yml` deploys from GitHub Actions on every push to `main` that touches a site. You can also run it by hand from the Actions tab.

- Each site's `vercel.json` stays the source of truth.
- `cloudflare/pages.mjs` turns it into Cloudflare's `_headers` and `_redirects`.
- Before any deploy, the same CSP and security headers are checked on Cloudflare's own engine (`wrangler pages dev`, `cloudflare/pages.e2e.mjs`). Cloudflare joins a header that two rules set, while Vercel replaces it, so this check matters.

## One-time setup (owner, free)

1. **API token.** In Cloudflare, go to My Profile → API Tokens → Create Token → Custom token.
   - Permission: *Account → Cloudflare Pages → Edit*. Account: yours.
   - Create the token and copy it.
   - Do not paste it in a chat or an issue.
2. **Account ID.** In Cloudflare, open Workers & Pages. The Account ID is in the right column.
3. **GitHub.** In the repo, go to Settings → Secrets and variables → Actions.
   - Secret `CLOUDFLARE_API_TOKEN` = the token.
   - Variable `CLOUDFLARE_ACCOUNT_ID` = the account id.
4. **First deploy.** In Actions, open *Cloudflare Pages* and click *Run workflow*. The first run creates the six projects.
5. **Domains.** In Workers & Pages, open each project, then Custom domains → Set up a custom domain, and enter its domain from the table.
   - Cloudflare offers to replace the old DNS record that points to Vercel. Accept.
   - Open the site and check it works before doing the next one.
6. **Optional, after the move.** Remove the same domains from the Vercel projects so the two never disagree.

## What does not move

- **Neuro's `/api`** (usage counter, early warning, Telegram bot): these are functions.
  - While Vercel is paused they are off anyway. The pages work without them.
  - Once neuro.sawasdeecoin.com points to Cloudflare, its `/api` answers 404.
  - To bring the API back, it needs its own address (for example a separate API subdomain on Vercel after 2026-12-06), or a port to Cloudflare Pages Functions. That is a separate change.
- **swd-claim-site** (swd-zetaphy.sawasdeecoin.com, Next.js) and **test-ui** stay on Vercel.

## Differences from Vercel, handled

- **`/x.html` is served at `/x`.** Every header rule for an `.html` file also names the short address.
- **Unknown paths.** Without a `404.html`, Cloudflare answers every unknown path with `index.html`. Staging adds a small `404.html`, so unknown paths are 404, as on Vercel.
- **The hub's `/api/*` rewrite.** It becomes a 307 redirect to Neuro's site. The pages call Neuro directly anyway (`zetaphy-neuro/web/api.js`).
