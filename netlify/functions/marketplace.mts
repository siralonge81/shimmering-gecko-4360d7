import type { Config, Context } from '@netlify/functions'
import { desc, eq, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { projects, users, votes } from '../../db/schema.js'
import { currentUser } from '../lib/auth.mts'

/** Published films with their real tallies, most-voted first. */
export default async (_req: Request, _context: Context) => {
  const user = await currentUser()

  const rows = await db
    .select({
      id: projects.id,
      title: projects.title,
      logline: projects.logline,
      genres: projects.genres,
      durationSeconds: projects.durationSeconds,
      posterKey: projects.posterKey,
      createdAt: projects.createdAt,
      creator: users.displayName,
      votes: sql<number>`count(${votes.id})::int`,
      viewerVoted: user
        ? sql<boolean>`bool_or(${votes.userId} = ${user.id})`
        : sql<boolean>`false`,
    })
    .from(projects)
    .leftJoin(votes, eq(votes.projectId, projects.id))
    .leftJoin(users, eq(users.id, projects.userId))
    .where(eq(projects.published, true))
    .groupBy(projects.id, users.displayName)
    .orderBy(desc(sql`count(${votes.id})`), desc(projects.createdAt))
    .limit(24)

  return Response.json({
    films: rows.map((row) => ({
      ...row,
      genres: Array.isArray(row.genres) ? row.genres : [],
      viewerVoted: Boolean(row.viewerVoted),
      frameUrl: row.posterKey ? `/api/frame/${row.posterKey}` : null,
    })),
    signedIn: Boolean(user),
  })
}

export const config: Config = {
  path: '/api/marketplace',
  method: 'GET',
}
