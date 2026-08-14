import type { Config, Context } from '@netlify/functions'
import { currentUser } from '../lib/auth.mts'
import { CREDIT_COSTS, balanceFor, recentLedger } from '../lib/credits.mts'
import { listProjectsForUser } from '../lib/projects.mts'

/**
 * One call the page can make on load: who is signed in, what they can spend,
 * and what they have made. Signed-out is a 200 with a null user, not a 401 —
 * the landing page is public.
 */
export default async (_req: Request, _context: Context) => {
  const user = await currentUser()

  if (!user) {
    return Response.json({
      user: null,
      costs: CREDIT_COSTS,
      paymentsConfigured: Boolean(Netlify.env.get('STRIPE_SECRET_KEY')),
    })
  }

  const [balance, ledger, projects] = await Promise.all([
    balanceFor(user.id),
    recentLedger(user.id),
    listProjectsForUser(user.id),
  ])

  return Response.json({
    user: { id: user.id, email: user.email, displayName: user.displayName },
    balance,
    costs: CREDIT_COSTS,
    ledger,
    projects,
    paymentsConfigured: Boolean(Netlify.env.get('STRIPE_SECRET_KEY')),
  })
}

export const config: Config = {
  path: '/api/me',
  method: 'GET',
}
