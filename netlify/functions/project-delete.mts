import type { Config, Context } from '@netlify/functions'
import { and, eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { projects, shots } from '../../db/schema.js'
import { currentUser, unauthorized } from '../lib/auth.mts'
import { loadProject } from '../lib/projects.mts'

/**
 * Deletes a director's own project and everything that depends on it. The
 * cascading foreign keys already remove scenes, shots, votes, and render jobs;
 * this also drops the stills and clips that belonged to its shots from Blobs.
 */
export default async (req: Request, context: Context) => {
  if (req.method !== 'DELETE') {
    return Response.json({ error: 'Use DELETE to remove a project.' }, { status: 405 })
  }

  const user = await currentUser()
  if (!user) return unauthorized('Sign in to delete a project.')

  const projectId = String(context.params.id ?? '')

  const project = await loadProject(projectId)
  if (!project) return Response.json({ error: 'Unknown project.' }, { status: 404 })
  if (project.ownerId !== user.id) {
    return Response.json({ error: 'That project belongs to another director.' }, { status: 403 })
  }

  // Cascading FKs handle the relational rows; remove the blobs the shots point
  // at so storage does not leak.
  try {
    const { frameStore, clipStore, FRAME_PREFIX, CLIP_PREFIX } = await import('../lib/stores.mts')
    const frames = frameStore()
    const clips = clipStore()
    for (const shot of project.shots) {
      if (shot.frameKey) await frames.delete(`${FRAME_PREFIX}${shot.frameKey}`)
      if (shot.clipKey) await clips.delete(`${CLIP_PREFIX}${shot.clipKey}`)
    }
  } catch (error) {
    // Blob cleanup is best-effort; the project row is the source of truth.
    console.error('Could not clean up blobs for deleted project:', error)
  }

  await db.delete(projects).where(eq(projects.id, projectId))

  return Response.json({ deleted: true, projectId })
}

export const config: Config = {
  path: '/api/project/:id',
  method: 'DELETE',
}
