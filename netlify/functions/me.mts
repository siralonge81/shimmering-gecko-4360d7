import type { Config, Context } from '@netlify/functions'
import {
  ANON_GENERATION_LIMIT,
  currentUser,
  readAnonymousSession,
  remainingGenerations,
} from '../lib/auth.mts'
import { CREDIT_COSTS, balanceFor, recentLedger } from '../lib/credits.mts'
import { listProjectsForAnonymousSession, listProjectsForUser } from '../lib/projects.mts'

/**
 * One call the page can make on load: who is signed in, what they can spend,
 * and what they have made. Signed-out visitors also learn how many free trial
 * generations they have left and which projects their anonymous session owns.
 */
export default async (_req: Request, context: Context) => {
  const user = await currentUser()

  if (!user) {
    const anonymousSession = await readAnonymousSession(context)
    // A visitor with no trial cookie yet has the full allowance ahead of them;
    // only an existing session has spent any of it.
    const anonymousRemaining = anonymousSession
      ? remainingGenerations(anonymousSession)
      : ANON_GENERATION_LIMIT
    const anonymousProjects = anonymousSession
      ? await listProjectsForAnonymousSession(anonymousSession.id).catch(() => [])
      : []

    return Response.json({
      user: null,
      costs: CREDIT_COSTS,
      paymentsConfigured: Boolean(Netlify.env.get('STRIPE_SECRET_KEY')),
      anonymousRemaining,
      anonymousLimit: ANON_GENERATION_LIMIT,
      anonymousProjects,
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
