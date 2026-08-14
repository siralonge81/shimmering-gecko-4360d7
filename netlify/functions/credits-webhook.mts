import type { Config } from '@netlify/functions'
import { and, eq } from 'drizzle-orm'
import Stripe from 'stripe'
import { db } from '../../db/index.js'
import { creditLedger } from '../../db/schema.js'
import { grant } from '../lib/credits.mts'

/**
 * Stripe calls this when a Checkout session is paid. The session's metadata
 * carries the user id and the number of credits the pack grants, so this
 * handler grants them once and records the charge id as the ledger ref —
 * which keeps a grant idempotent: a replayed webhook finds the entry already
 * present and does nothing.
 */
function stripeClient(): Stripe | null {
  const key = Netlify.env.get('STRIPE_SECRET_KEY')
  if (!key) return null
  return new Stripe(key)
}

export default async (req: Request) => {
  const stripe = stripeClient()
  if (!stripe) {
    // No processor configured — nothing to verify against.
    return new Response('Webhook not configured.', { status: 400 })
  }

  const signature = req.headers.get('stripe-signature')
  if (!signature) {
    return new Response('Missing signature.', { status: 400 })
  }

  const secret = Netlify.env.get('STRIPE_WEBHOOK_SECRET')
  if (!secret) {
    console.error('STRIPE_WEBHOOK_SECRET is not set; cannot verify webhooks.')
    return new Response('Webhook secret not configured.', { status: 500 })
  }

  const payload = await req.text()
  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(payload, signature, secret)
  } catch (error) {
    console.error('Stripe webhook signature verification failed:', error)
    return new Response('Invalid signature.', { status: 400 })
  }

  if (event.type !== 'checkout.session.completed') {
    // We only grant on completed, paid sessions.
    return new Response('Ignored.', { status: 202 })
  }

  const session = event.data.object as Stripe.Checkout.Session
  const metadata = session.metadata ?? {}
  const userId = metadata.user_id
  const credits = Number(metadata.credits)
  const packId = metadata.pack || 'starter'
  const chargeId = session.id

  if (!userId || !Number.isInteger(credits) || credits <= 0) {
    console.error('Stripe webhook missing credit metadata:', metadata)
    return new Response('Missing metadata.', { status: 202 })
  }

  if (session.payment_status !== 'paid') {
    // Wait for the payment to actually settle; Stripe sends a separate event
    // for unpaid sessions in async-payment mode, which we ignore here.
    return new Response('Payment pending.', { status: 202 })
  }

  try {
    // Idempotent: the Stripe session id is the ledger ref_id. A replayed
    // webhook produces a second grant with the same ref, so we dedupe by
    // checking whether a paid grant already exists for this charge.
    const already = await hasGrantForRef(userId, chargeId)
    if (already) {
      return new Response('Already granted.', { status: 200 })
    }

    const balance = await grant(
      userId,
      credits,
      'topup',
      `${packId} pack paid via Stripe`,
      chargeId,
    )

    console.log(`Stripe webhook granted ${credits} credits to ${userId}; balance ${balance}.`)
    return new Response('Granted.', { status: 200 })
  } catch (error) {
    console.error('Stripe webhook grant failed:', error)
    return new Response('Grant failed.', { status: 500 })
  }
}

async function hasGrantForRef(userId: string, refId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(and(eq(creditLedger.userId, userId), eq(creditLedger.refId, refId)))
    .limit(1)
  return Boolean(row)
}

export const config: Config = {
  path: '/api/credits/webhook',
  method: 'POST',
}
