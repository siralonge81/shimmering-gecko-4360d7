import type { Config } from '@netlify/functions'
import { eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { renderJobs } from '../../db/schema.js'
import { finishJob, storeClipAndFinish } from '../lib/renders.mts'

/**
 * Providers call this when a render completes, which usually beats the poll
 * loop. Jobs are matched by the provider's own id and closed out exactly once,
 * so a webhook arriving after the poller already finished is harmless.
 */
export default async (req: Request) => {
  let payload: { id?: string; request_id?: string; status?: string; output?: unknown; error?: unknown }
  try {
    payload = await req.json()
  } catch {
    return new Response('Expected a JSON body.', { status: 400 })
  }

  const providerJobId = String(payload.id ?? payload.request_id ?? '')
  if (!providerJobId) {
    return new Response('No provider job id.', { status: 400 })
  }

  const [job] = await db
    .select()
    .from(renderJobs)
    .where(eq(renderJobs.providerJobId, providerJobId))
    .limit(1)

  if (!job) {
    // Not ours, or already cleaned up. Acknowledge so the provider stops retrying.
    return new Response('No matching job.', { status: 202 })
  }

  const status = String(payload.status ?? '').toLowerCase()
  const output = Array.isArray(payload.output) ? payload.output[0] : payload.output
  const videoUrl =
    typeof output === 'string'
      ? output
      : typeof (output as { url?: string })?.url === 'string'
        ? (output as { url: string }).url
        : ''

  if ((status === 'succeeded' || status === 'completed' || status === 'ok') && videoUrl) {
    await storeClipAndFinish(job.id, job.projectId, job.shotNumber ?? 1, videoUrl)
    return new Response('Stored.', { status: 200 })
  }

  if (status === 'failed' || status === 'canceled' || status === 'error') {
    await finishJob(job.id, {
      status: 'failed',
      error: typeof payload.error === 'string' ? payload.error : 'The provider reported a failure.',
    })
    return new Response('Recorded.', { status: 200 })
  }

  // Any other state is progress — the poll loop keeps watching.
  return new Response('Ignored.', { status: 202 })
}

export const config: Config = {
  path: '/api/render-webhook',
  method: 'POST',
}
