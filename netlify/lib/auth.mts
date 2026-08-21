import { getUser } from '@netlify/identity'
import type { Context } from '@netlify/functions'
import { eq, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { anonymousSessions, users, projects, renderJobs } from '../../db/schema.js'
import { SIGNUP_GRANT, grant } from './credits.mts'

export type AppUser = {
  id: string
  identityId: string
  email: string
  displayName: string | null
}

/** Free generations a brand-new visitor may run before signing in. */
export const ANON_GENERATION_LIMIT = 3
const ANON_COOKIE = 'cinepay.anon'
/** Long enough to keep a trial across a short break, short enough to not last forever. */
const ANON_COOKIE_MAX_AGE = 60 * 60 * 24 * 14

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

export type AnonymousSession = {
  id: string
  generationsUsed: number
}

/**
 * Reads or creates the visitor's anonymous trial session from the `cinepay.anon`
 * cookie. A signed-in user has no anonymous session — their work is owned by
 * their account directly — so this returns null once `currentUser()` resolves.
 */
export async function getOrCreateAnonymousSession(
  context: Context,
): Promise<AnonymousSession | null> {
  // A signed-in visitor owns work through their account; no trial session.
  const user = await currentUser()
  if (user) return null

  const cookieId = context.cookies.get(ANON_COOKIE)

  if (cookieId) {
    const [existing] = await db
      .select()
      .from(anonymousSessions)
      .where(eq(anonymousSessions.id, cookieId))
      .limit(1)
    if (existing) return existing
  }

  const [created] = await db
    .insert(anonymousSessions)
    .values({})
    .returning()

  context.cookies.set({
    name: ANON_COOKIE,
    value: created.id,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: ANON_COOKIE_MAX_AGE,
  })

  return created
}

/** Returns the trial session bound to the request's cookie, without creating one. */
export async function readAnonymousSession(context: Context): Promise<AnonymousSession | null> {
  const cookieId = context.cookies.get(ANON_COOKIE)
  if (!cookieId) return null

  const [existing] = await db
    .select()
    .from(anonymousSessions)
    .where(eq(anonymousSessions.id, cookieId))
    .limit(1)
  return existing ?? null
}

/** How many free generations the visitor still has. */
export function remainingGenerations(session: AnonymousSession | null): number {
  if (!session) return 0
  return Math.max(0, ANON_GENERATION_LIMIT - session.generationsUsed)
}

/**
 * Atomically bumps the session's generation counter and returns the updated
 * row. Two parallel story requests cannot both consume the same free slot: the
 * counter is only incremented where it is still under the limit.
 *
 * Returns null when the allowance is exhausted, so the caller can surface the
 * "sign in to continue" message.
 */
export async function consumeAnonymousGeneration(
  sessionId: string,
): Promise<AnonymousSession | null> {
  const [updated] = await db
    .update(anonymousSessions)
    .set({ generationsUsed: sql`${anonymousSessions.generationsUsed} + 1` })
    .where(
      sql`${anonymousSessions.id} = ${sessionId} and ${anonymousSessions.generationsUsed} < ${ANON_GENERATION_LIMIT}`,
    )
    .returning()

  return updated ?? null
}

/**
 * Claim: the moment "save" happens. Every project and render job the visitor
 * made while signed out is re-parented onto their new account, the trial
 * session is forgotten, and the cookie is cleared. Runs after Identity has set
 * the session cookie, so the browser's next request is already authenticated.
 */
export async function claimAnonymousSession(
  context: Context,
  user: AppUser,
): Promise<{ projectsClaimed: number }> {
  const cookieId = context.cookies.get(ANON_COOKIE)
  if (!cookieId) return { projectsClaimed: 0 }

  const claimed = await db.transaction(async (tx) => {
    // Re-parent the trial's projects onto the account and clear the session
    // link so the rows are owned the same way a signed-in generation would be.
    const projectsUpdated = await tx
      .update(projects)
      .set({ userId: user.id, anonymousSessionId: null })
      .where(eq(projects.anonymousSessionId, cookieId))
      .returning({ id: projects.id })

    if (projectsUpdated.length) {
      await tx
        .update(renderJobs)
        .set({ userId: user.id, anonymousSessionId: null })
        .where(eq(renderJobs.anonymousSessionId, cookieId))
    }

    return projectsUpdated.length
  })

  // The trial is over either way; clear the cookie so a refresh does not spin
  // up a fresh anonymous session under the now-signed-in account.
  context.cookies.delete({ name: ANON_COOKIE, path: '/' })

  return { projectsClaimed: claimed }
}
