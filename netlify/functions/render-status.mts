import type { Config, Context } from '@netlify/functions'
import { eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { renderJobs } from '../../db/schema.js'
import { currentUser, unauthorized } from '../lib/auth.mts'

/** What the workspace polls while a clip renders. */
export default async (_req: Request, context: Context) => {
  const user = await currentUser()
  if (!user) return unauthorized()

  const jobId = String(context.params.jobId ?? '')
  const [job] = await db.select().from(renderJobs).where(eq(renderJobs.id, jobId)).limit(1)

  if (!job || job.userId !== user.id) {
    return Response.json({ error: 'Unknown render job.' }, { status: 404 })
  }

  return Response.json({
    id: job.id,
    projectId: job.projectId,
    shot: job.shotNumber,
    status: job.status,
    provider: job.provider,
    error: job.error,
    clipUrl: job.clipKey ? `/api/clip/${job.clipKey}` : null,
    updatedAt: job.updatedAt,
  })
}

export const config: Config = {
  path: '/api/render/:jobId',
  method: 'GET',
}
