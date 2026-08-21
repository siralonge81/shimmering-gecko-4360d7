import type { Config, Context } from '@netlify/functions'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { renderJobs } from '../../db/schema.js'
import {
  currentUser,
  readAnonymousSession,
  unauthorized,
} from '../lib/auth.mts'
import { CREDIT_COSTS, InsufficientCreditsError, grant, spend } from '../lib/credits.mts'
import { loadProject } from '../lib/projects.mts'
import { activeProvider } from '../lib/video.mts'
import { checkRateLimit, sweepRateBuckets } from '../lib/rate-limit.mts'

/**
 * Queues a clip. The provider call itself happens in the background function,
 * because a render outlives the 60 seconds a synchronous function gets.
 *
 * A signed-in director pays credits; an anonymous visitor renders for free as
 * part of their trial (the allowance is bounded by the story-generation limit,
 * since every render hangs off a project the trial already paid for).
 */
export default async (req: Request, context: Context) => {
  const user = await currentUser()
  const anonymousSession = await readAnonymousSession(context)

  if (!user && !anonymousSession) return unauthorized('Sign in to render video.')

  const limited = await checkRateLimit(req, 'video', user?.identityId ?? null)
  if (limited) return limited
  void sweepRateBuckets()

  const projectId = String(context.params.projectId ?? '')
  let body: { shot?: unknown }
  try {
    body = await req.json()
  } catch {
    body = {}
  }

  const shotNumber = Number(body.shot)
  if (!Number.isInteger(shotNumber)) {
    return Response.json({ error: 'A shot number is required.' }, { status: 400 })
  }

  const project = await loadProject(projectId)
  if (!project) return Response.json({ error: 'Unknown project.' }, { status: 404 })

  const ownsAsUser = Boolean(user && project.ownerId === user.id)
  const ownsAsAnon = Boolean(
    anonymousSession && project.anonymousSessionId === anonymousSession.id,
  )
  if (!ownsAsUser && !ownsAsAnon) {
    return Response.json({ error: 'That project belongs to another director.' }, { status: 403 })
  }

  const shot = project.shots.find((candidate) => candidate.number === shotNumber)
  if (!shot) return Response.json({ error: 'Unknown shot.' }, { status: 404 })
  if (!shot.frameKey) {
    return Response.json(
      { error: 'Generate the still for this shot first — the clip is animated from it.' },
      { status: 409 },
    )
  }

  // Checked before charging: nobody should pay for a render that cannot start.
  const provider = activeProvider()
  if (!provider) {
    return Response.json(
      {
        error:
          'No video provider is connected to this build. Set REPLICATE_API_TOKEN or FAL_KEY to enable rendering.',
        providerConfigured: false,
      },
      { status: 503 },
    )
  }

  // One open job per shot, so a double click cannot pay twice.
  const [existing] = await db
    .select({ id: renderJobs.id, status: renderJobs.status })
    .from(renderJobs)
    .where(
      and(
        eq(renderJobs.projectId, projectId),
        eq(renderJobs.shotNumber, shotNumber),
        inArray(renderJobs.status, ['queued', 'running']),
      ),
    )
    .limit(1)

  if (existing) {
    return Response.json({ jobId: existing.id, status: existing.status, reused: true })
  }

  let balance: number | null = null
  if (user) {
    try {
      balance = await spend(
        user.id,
        CREDIT_COSTS.video,
        'video',
        `Video clip — shot ${shotNumber}`,
        projectId,
      )
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        return Response.json(
          {
            error: `That costs ${error.required} credits and you have ${error.balance}.`,
            insufficientCredits: true,
            required: error.required,
            balance: error.balance,
          },
          { status: 402 },
        )
      }
      throw error
    }
  }

  const [job] = await db
    .insert(renderJobs)
    .values({
      projectId,
      userId: user?.id ?? null,
      anonymousSessionId: anonymousSession?.id ?? null,
      shotNumber,
      status: 'queued',
      provider,
      // Anonymous renders hold no credits, so nothing is held against a refund.
      creditsHeld: user ? CREDIT_COSTS.video : 0,
    })
    // render_jobs_open_shot_key admits one unfinished job per shot, so a second
    // request that slipped past the check above inserts nothing and is refunded.
    .onConflictDoNothing()
    .returning({ id: renderJobs.id })

  if (!job) {
    const refunded = user
      ? await grant(
          user.id,
          CREDIT_COSTS.video,
          'refund',
          'Refund — this shot was already rendering',
          projectId,
        )
      : null
    const [open] = await db
      .select({ id: renderJobs.id, status: renderJobs.status })
      .from(renderJobs)
      .where(
        and(
          eq(renderJobs.projectId, projectId),
          eq(renderJobs.shotNumber, shotNumber),
          inArray(renderJobs.status, ['queued', 'running']),
        ),
      )
      .limit(1)

    return Response.json({
      jobId: open?.id ?? null,
      status: open?.status ?? 'queued',
      reused: true,
      balance: refunded,
    })
  }

  // Fire-and-forget: the background function answers 202 immediately and the
  // browser follows the job through /api/render/:jobId.
  const origin = new URL(req.url).origin
  try {
    await fetch(`${origin}/.netlify/functions/render-run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: job.id }),
    })
  } catch (error) {
    console.error('Could not start the background render:', error)
    await db
      .update(renderJobs)
      .set({ status: 'failed', error: 'Could not start the render worker.' })
      .where(eq(renderJobs.id, job.id))
    if (user) {
      const refunded = await grant(
        user.id,
        CREDIT_COSTS.video,
        'refund',
        'Refund — render worker did not start',
        job.id,
      )
      return Response.json(
        { error: 'Could not start the render. Your credits were refunded.', balance: refunded },
        { status: 502 },
      )
    }
    return Response.json({ error: 'Could not start the render.' }, { status: 502 })
  }

  return Response.json({ jobId: job.id, status: 'queued', provider, balance }, { status: 202 })
}

export const config: Config = {
  path: '/api/render/:projectId',
  method: 'POST',
}
