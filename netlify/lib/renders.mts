import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { renderJobs } from '../../db/schema.js'
import { grant } from './credits.mts'
import { CLIP_PREFIX, clipStore } from './stores.mts'
import { downloadClip } from './video.mts'

export type TerminalPatch = {
  status: 'succeeded' | 'failed'
  clipKey?: string
  error?: string
}

/**
 * A job can be finished by either the poller or the provider's webhook,
 * whichever arrives first. The update is conditional on the job still being
 * open, so the loser of that race changes nothing — and, importantly, cannot
 * issue a second refund for the same job.
 */
export async function finishJob(jobId: string, patch: TerminalPatch): Promise<boolean> {
  const updated = await db
    .update(renderJobs)
    .set({
      status: patch.status,
      clipKey: patch.clipKey ?? null,
      error: patch.error ?? null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(renderJobs.id, jobId), inArray(renderJobs.status, ['queued', 'running'])))
    .returning({ userId: renderJobs.userId, creditsHeld: renderJobs.creditsHeld })

  const [job] = updated
  if (!job) return false

  // Anonymous renders spend no credits (the trial is free), so there is nothing
  // to refund and no ledger row to write against a null user.
  if (patch.status === 'failed' && job.userId && job.creditsHeld > 0) {
    await grant(job.userId, job.creditsHeld, 'refund', 'Refund — video render failed', jobId)
  }

  return true
}

/** Pulls the provider's output into Blobs and closes the job out. */
export async function storeClipAndFinish(
  jobId: string,
  projectId: string,
  shotNumber: number,
  videoUrl: string,
): Promise<void> {
  const clip = await downloadClip(videoUrl)
  const nonce = crypto.randomUUID().slice(0, 8)
  const key = `clip-${projectId}-${String(shotNumber).padStart(2, '0')}-${nonce}.${clip.ext}`

  await clipStore().set(`${CLIP_PREFIX}${key}`, clip.body)
  await finishJob(jobId, { status: 'succeeded', clipKey: key })
}
