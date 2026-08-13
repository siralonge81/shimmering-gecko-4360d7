import type { Config, Context } from '@netlify/functions'
import { currentUser, unauthorized } from '../lib/auth.mts'
import { balanceFor, grant } from '../lib/credits.mts'

/** Server-side so the amount granted can never be set by the client. */
const PACKS = {
  starter: { credits: 500, label: 'Starter pack', price: '$19' },
  creator: { credits: 1500, label: 'Creator plan', price: '$49/mo' },
  studio: { credits: 5000, label: 'Studio plan', price: '$149/mo' },
} as const

type PackId = keyof typeof PACKS

/**
 * No payment processor is connected to this build. Rather than pretend, the
 * endpoint reports that it is unpaid and records the entry as such, so the
 * ledger stays honest and swapping in a real checkout is a contained change:
 * take the payment, then call `grant` on the confirmed webhook.
 */
export default async (req: Request, _context: Context) => {
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

  const processorConfigured = Boolean(Netlify.env.get('STRIPE_SECRET_KEY'))
  if (processorConfigured) {
    // A real integration would create a checkout session here and only grant
    // credits from its webhook, never from this request.
    return Response.json(
      { error: 'Payment processing is configured but not implemented yet.' },
      { status: 501 },
    )
  }

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
    price: pack.price,
    balance,
    paid: false,
    notice: 'No payment was taken. This build has no payment processor connected.',
  })
}

export const config: Config = {
  path: '/api/credits/checkout',
  method: 'POST',
}
