import type { Config, Context } from '@netlify/functions'
import { and, eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { projects, shots } from '../../db/schema.js'
import { currentUser, unauthorized } from '../lib/auth.mts'

/** Submits a director's own film to the marketplace, or withdraws it. */
export default async (req: Request, context: Context) => {
  const user = await currentUser()
  if (!user) return unauthorized('Sign in to publish a film.')

  const projectId = String(context.params.id ?? '')
  const [film] = await db
    .select({ id: projects.id, userId: projects.userId, published: projects.published })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)

  if (!film) return Response.json({ error: 'Unknown project.' }, { status: 404 })
  if (film.userId !== user.id) {
    return Response.json({ error: 'That project belongs to another director.' }, { status: 403 })
  }

  const publish = req.method !== 'DELETE'

  if (publish) {
    // A film with no imagery would show up in the grid as an empty card.
    const [firstShot] = await db
      .select({ frameKey: shots.frameKey })
      .from(shots)
      .where(and(eq(shots.projectId, projectId), eq(shots.number, 1)))
      .limit(1)

    if (!firstShot?.frameKey) {
      return Response.json(
        { error: 'Generate at least the first still before publishing.' },
        { status: 409 },
      )
    }
  }

  await db.update(projects).set({ published: publish }).where(eq(projects.id, projectId))

  return Response.json({ projectId, published: publish })
}

export const config: Config = {
  path: '/api/project/:id/publish',
  method: ['POST', 'DELETE'],
}
