import { getUser } from '@netlify/identity'
import { eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { users } from '../../db/schema.js'
import { SIGNUP_GRANT, grant } from './credits.mts'

export type AppUser = {
  id: string
  identityId: string
  email: string
  displayName: string | null
}

/**
 * Identity is the source of truth for credentials; this returns the matching
 * application row, creating it (and its opening credit grant) the first time a
 * confirmed account makes an authenticated request.
 */
export async function currentUser(): Promise<AppUser | null> {
  const identity = await getUser()
  if (!identity?.id || !identity.email) return null

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.identityId, identity.id))
    .limit(1)

  if (existing.length) {
    return existing[0] as AppUser
  }

  const displayName =
    (typeof identity.name === 'string' && identity.name.trim()) || identity.email.split('@')[0]

  try {
    const [created] = await db
      .insert(users)
      .values({ identityId: identity.id, email: identity.email, displayName })
      .returning()

    await grant(created.id, SIGNUP_GRANT, 'signup_grant', 'Welcome credits for a new account')
    return created as AppUser
  } catch {
    // Two first requests can race; whichever lost re-reads the winner's row.
    const [raced] = await db
      .select()
      .from(users)
      .where(eq(users.identityId, identity.id))
      .limit(1)
    return (raced as AppUser) ?? null
  }
}

/** 401 body shared by every endpoint that needs a signed-in viewer. */
export function unauthorized(message = 'Sign in to continue.') {
  return Response.json({ error: message, requiresAuth: true }, { status: 401 })
}
