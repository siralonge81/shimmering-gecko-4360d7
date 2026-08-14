import type { Config, Context } from '@netlify/functions'
import Stripe from 'stripe'
import { currentUser, unauthorized } from '../lib/auth.mts'
import { balanceFor, grant } from '../lib/credits.mts'

/** Server-side so the amount granted can never be set by the client. */
const PACKS = {
  starter: { credits: 500, label: 'Starter pack', price: 1900, display: '$19' },
  creator: { credits: 1500, label: 'Creator plan', price: 4900, display: '$49/mo' },
  studio: { credits: 5000, label: 'Studio plan', price: 14900, display: '$149/mo' },
} as const

type PackId = keyof typeof PACKS

function stripeClient(): Stripe | null {
  const key = Netlify.env.get('STRIPE_SECRET_KEY')
  if (!key) return null
  return new Stripe(key)
}

/**
 * With Stripe configured, this creates a real Checkout session and redirects
 * the browser to Stripe. Credits are granted only when Stripe confirms payment
 * through the webhook, never here.
 *
 * Without Stripe, the endpoint keeps its demo behaviour: it grants the credits
 * immediately and records the entry as an unpaid demo top-up, so the ledger
 * stays honest and the page works end to end without a processor.
 */
export default async (req: Request, context: Context) => {
  const user = await currentUser()
  if (!user) return unauthorized('Sign in to add credits.')

  let body: { pack?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  const packId = String(body.pack ?? '') as PackId
  const pack = PACKS[packId]
  if (!pack) {
    return Response.json({ error: 'Unknown credit pack.' }, { status: 400 })
  }

  const stripe = stripeClient()
  if (stripe) {
    const origin = new URL(req.url).origin
    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: pack.price,
              product_data: {
                name: `CinePay — ${pack.label}`,
                description: `${pack.credits} credits for CinePay`,
              },
            },
          },
        ],
        // The webhook grants the credits; the metadata is how it knows how many
        // and to whom. The user id is our DB row id (stable across sessions).
        metadata: {
          pack: packId,
          credits: String(pack.credits),
          user_id: user.id,
          identity_id: user.identityId,
        },
        success_url: `${origin}/?credits=paid&pack=${packId}`,
        cancel_url: `${origin}/?credits=cancelled`,
      })

      return Response.json({ checkout: true, url: session.url })
    } catch (error) {
      console.error('Stripe checkout session failed:', error)
      return Response.json(
        { error: 'Could not start checkout. Try again or contact support.' },
        { status: 502 },
      )
    }
  }

  // Demo path: no processor connected. Grant now and label it honestly.
  const balance = await grant(
    user.id,
    pack.credits,
    'topup',
    `${pack.label} — unpaid demo top-up, no payment processor connected`,
    packId,
  )

  return Response.json({
    pack: packId,
    credits: pack.credits,
    price: pack.display,
    balance,
    paid: false,
    notice: 'No payment was taken. This build has no payment processor connected.',
  })
}

export const config: Config = {
  path: '/api/credits/checkout',
  method: 'POST',
}
