# Creator Travel Storefront — Netlify Edition

White-label travel storefront for a creator/influencer, designed for Netlify.

## Features

- Public creator storefront
- Property pages
- Creator dashboard
- Creator can add/edit stays and paste their own Airbnb links
- Airbnb outbound click tracking
- Referral tracking (`?ref=tiktok`, `?ref=instagram`, etc.)
- Direct booking with Stripe Checkout
- Stripe webhook payment confirmation
- Creator commission calculation
- Persistent storage with Netlify Blobs
- Creator and admin roles

## Netlify structure

- Frontend: `/public`
- Functions: `/netlify/functions`
- Build config: `netlify.toml`
- Storage: Netlify Blobs

## Deploy

Connect this repository to Netlify. The included `netlify.toml` configures the build automatically.

Add these environment variables in Netlify:

```text
STORE_NAME=
CREATOR_NAME=
CREATOR_HANDLE=
CREATOR_EMAIL=
CREATOR_PASSWORD=
ADMIN_EMAIL=
ADMIN_PASSWORD=
SESSION_SECRET=
DEFAULT_COMMISSION_PERCENT=10
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
```

Stripe webhook endpoint:

```text
https://YOUR-DOMAIN/api/stripe/webhook
```

Events:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`

## Production note

Before enabling instant direct booking for properties that are also sold on Airbnb, add calendar/channel synchronization to avoid double bookings. For a future multi-creator SaaS, migrate booking/inventory data to Postgres and use Stripe Connect for automated payouts.
