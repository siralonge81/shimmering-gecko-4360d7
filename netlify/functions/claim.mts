import type { Config, Context } from '@netlify/functions'
import { claimAnonymousSession, currentUser, unauthorized } from '../lib/auth.mts'
import { balanceFor } from '../lib/credits.mts'

/**
 * Claims any anonymous trial work into the signed-in account. Email/password
 * sign-in claims inline in /api/auth, but OAuth and email-confirmation
 * callbacks land through Identity directly — the frontend calls this right
 * after it detects a fresh session so those paths save the visitor's film too.
 */
export default async (_req: Request, context: Context) => {
  const user = await currentUser()
  if (!user) return unauthorized('Sign in to save your work.')

  const { projectsClaimed } = await claimAnonymousSession(context, user)

  return Response.json({
    projectsClaimed,
    balance: await balanceFor(user.id),
  })
}

export const config: Config = {
  path: '/api/claim-anonymous',
  method: 'POST',
}
