import type { Config, Context } from '@netlify/functions'
import { currentUser, readAnonymousSession } from '../lib/auth.mts'
import { loadProject } from '../lib/projects.mts'

export default async (_req: Request, context: Context) => {
  const id = String(context.params.id ?? '')
  const project = await loadProject(id)

  if (!project) {
    return Response.json({ error: 'Unknown project.' }, { status: 404 })
  }

  const user = await currentUser()
  const anonymousSession = await readAnonymousSession(context)

  // Ownership covers both account-backed and anonymous-trial projects: a signed-
  // in director matches their user id, an anonymous visitor matches the trial
  // session the project was generated against.
  const isOwner =
    Boolean(user && project.ownerId === user.id) ||
    Boolean(anonymousSession && project.anonymousSessionId === anonymousSession.id)

  // Unpublished work is private to its director.
  if (!project.published && !isOwner) {
    return Response.json({ error: 'Unknown project.' }, { status: 404 })
  }

  return Response.json({ project, isOwner })
}

export const config: Config = {
  path: '/api/story/:id',
  method: 'GET',
}
