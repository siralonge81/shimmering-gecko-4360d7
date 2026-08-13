import type { Config } from '@netlify/functions'
import { eq, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { renderJobs } from '../../db/schema.js'
import { buildFramePrompt } from '../lib/film.mts'
import { loadProject } from '../lib/projects.mts'
import { finishJob, storeClipAndFinish } from '../lib/renders.mts'
import { pollRender, startRender, type VideoProvider } from '../lib/video.mts'

const POLL_INTERVAL_MS = 5000
/** Well inside the 15 minutes a background function is allowed. */
const POLL_TIMEOUT_MS = 12 * 60 * 1000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Runs one clip to completion. The client never waits on this — it was handed a
 * job id and polls /api/render/:jobId. The provider's webhook may also finish
 * the job first; whichever gets there wins and the other is a no-op.
 */
export default async (req: Request) => {
  let jobId = ''
  try {
    const body = (await req.json()) as { jobId?: string }
    jobId = String(body.jobId ?? '')
  } catch {
    return new Response('Expected a JSON body.', { status: 400 })
  }

  const [job] = await db.select().from(renderJobs).where(eq(renderJobs.id, jobId)).limit(1)
  if (!job) {
    console.error(`render-run: unknown job ${jobId}`)
    return new Response('Unknown job.', { status: 404 })
  }

  const project = await loadProject(job.projectId)
  const shot = project?.shots.find((candidate) => candidate.number === job.shotNumber)
  if (!project || !shot?.frameKey) {
    await finishJob(jobId, { status: 'failed', error: 'The shot lost its still before rendering.' })
    return new Response('Missing still.', { status: 409 })
  }

  await db
    .update(renderJobs)
    .set({ status: 'running', updatedAt: sql`now()` })
    .where(eq(renderJobs.id, jobId))

  const origin = new URL(req.url).origin
  const provider = (job.provider ?? 'replicate') as VideoProvider

  try {
    const started = await startRender(provider, {
      // The provider fetches the still from the site's own image endpoint.
      imageUrl: `${origin}/api/frame/${shot.frameKey}`,
      prompt: buildFramePrompt(project, shot),
      seconds: shot.durationSeconds,
      webhookUrl: `${origin}/api/render-webhook`,
    })

    await db
      .update(renderJobs)
      .set({ providerJobId: started.providerJobId, updatedAt: sql`now()` })
      .where(eq(renderJobs.id, jobId))

    const deadline = Date.now() + POLL_TIMEOUT_MS
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS)

      // The webhook may have closed the job out while this loop was sleeping.
      const [current] = await db
        .select({ status: renderJobs.status })
        .from(renderJobs)
        .where(eq(renderJobs.id, jobId))
        .limit(1)
      if (current && current.status !== 'running' && current.status !== 'queued') return

      const poll = await pollRender(provider, started.providerJobId)

      if (poll.status === 'succeeded' && poll.videoUrl) {
        await storeClipAndFinish(jobId, job.projectId, shot.number, poll.videoUrl)
        return
      }

      if (poll.status === 'failed') {
        await finishJob(jobId, { status: 'failed', error: poll.error ?? 'The render failed.' })
        return
      }
    }

    await finishJob(jobId, { status: 'failed', error: 'The render timed out.' })
  } catch (error) {
    console.error(`render-run failed for job ${jobId}:`, error)
    await finishJob(jobId, {
      status: 'failed',
      error: error instanceof Error ? error.message : 'The render failed.',
    })
  }
}

export const config: Config = {
  background: true,
}
