# Ricotta storefront administration

The storefront and the management interface use the same Netlify Blobs settings. The original six products are available on first use. Ordering starts paused.

## Netlify setup

1. Deploy this repository to the existing Ricotta Netlify project. The root `netlify.toml` configures the build directory, static files, and functions.
2. Set `RICOTTA_ADMIN_PASSWORD` in the project's environment variables. Use a new secret with at least 16 characters and give it Functions scope where available. Set it separately for Production and Deploy Previews if you want to use both. A new deploy is required after a variable changes.
3. Keep the existing production `SQUARE_ACCESS_TOKEN` and `SQUARE_LOCATION_ID`. For a preview payment test, provide `SQUARE_SANDBOX_ACCESS_TOKEN` and `SQUARE_SANDBOX_LOCATION_ID` with Deploy Preview values.
4. After the deploy, open `/admin`. Confirm the weekly pickup hours, season dates, and daily limits. Clear the pause checkbox and save when ready to accept orders.
5. Verify that `release-pickup-holds` appears as a scheduled function on the production deploy and that the function rate limits pass validation in the deploy log.

## Daily operations

- Changes take effect after saving. Customers can choose available pickup times up to 30 days ahead, grouped into one-hour windows in New York time.
- Both daily limits apply to the pickup date. A payment link holds a place for at least 15 minutes. The scheduled function releases unused places after Square confirms cancellation. Paid places remain counted, with order returns reconciled periodically.
- Messages appear on the public storefront on the chosen dates in New York time. Team reminders are dated notes in the admin interface.
- Product photos accept JPG, PNG, and WebP up to 2 MB. Hiding a product lets you restore it later.

Deploy Previews use a deploy-specific store and Square Sandbox. Netlify only runs scheduled functions automatically on production deploys.
