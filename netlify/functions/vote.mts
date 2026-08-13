import type { Config, Context } from '@netlify/functions'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { projects, votes } from '../../db/schema.js'
import { currentUser, unauthorized } from '../lib/auth.mts'

/**
 * Voting is free — the payout model promises that — but it is one row per
 * viewer per film, enforced by a unique index rather than by the button state.
 */
export default async (req: Request, context: Context) => {
  const user = await currentUser()
  if (!user) return unauthorized('Sign in to vote. Voting is free for registered viewers.')

  const projectId = String(context.params.projectId ?? '')

  const [film] = await db
    .select({ id: projects.id, published: projects.published })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)

  if (!film || !film.published) {
    return Response.json({ error: 'That film is not in the marketplace.' }, { status: 404 })
  }

  let voted = true
  if (req.method === 'DELETE') {
    await db.delete(votes).where(and(eq(votes.projectId, projectId), eq(votes.userId, user.id)))
    voted = false
  } else {
    // A repeat vote collides with votes_project_user_key and changes nothing.
    await db
      .insert(votes)
      .values({ projectId, userId: user.id })
      .onConflictDoNothing({ target: [votes.projectId, votes.userId] })
  }

  const [tally] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(votes)
    .where(eq(votes.projectId, projectId))

  return Response.json({ projectId, voted, votes: tally?.count ?? 0 })
}

export const config: Config = {
  path: '/api/vote/:projectId',
  method: ['POST', 'DELETE'],
}
