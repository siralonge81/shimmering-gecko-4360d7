import type { Config, Context } from '@netlify/functions'
import { currentUser } from '../lib/auth.mts'
import { loadProject } from '../lib/projects.mts'

export default async (_req: Request, context: Context) => {
  const id = String(context.params.id ?? '')
  const project = await loadProject(id)

  if (!project) {
    return Response.json({ error: 'Unknown project.' }, { status: 404 })
  }

  const user = await currentUser()
  const isOwner = Boolean(user && project.ownerId === user.id)

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
