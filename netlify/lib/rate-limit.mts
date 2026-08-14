import { and, eq, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { rateBuckets } from '../../db/schema.js'

/**
 * Generation endpoints call a model that costs real money and time, so they are
 * metered per user (and per IP for the anonymous edge). The window is short and
 * the limit generous — enough for a director working fast, low enough to stop a
 * script from burning credits or hammering the image model.
 */
export type MeteredAction = 'story' | 'frame' | 'video'

export const RATE_LIMITS: Record<MeteredAction, { window: number; max: number }> = {
  // 60-second sliding window. Story is heavy; frames are batched but each is a
  // model call, so the per-window ceiling is the same shape.
  story: { window: 60_000, max: 4 },
  frame: { window: 60_000, max: 20 },
  video: { window: 60_000, max: 3 },
}

export class RateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('Slow down — too many requests in a short window.')
    this.name = 'RateLimitError'
  }
}

function clientIp(req: Request): string {
  // The CDN sets the viewer's address; fall back to a constant so anonymous
  // traffic still shares a bucket.
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    '0.0.0.0'
  )
}

function windowStart(now: number, window: number): Date {
  return new Date(Math.floor(now / window) * window)
}

/**
 * Returns the rate-limit response the endpoint should send when the caller has
 * exceeded its bucket, or null when the request is allowed (and the bucket has
 * been incremented). Anonymous callers are keyed by IP only.
 */
export async function checkRateLimit(
  req: Request,
  action: MeteredAction,
  identityId: string | null,
): Promise<Response | null> {
  const limit = RATE_LIMITS[action]
  const now = Date.now()
  const start = windowStart(now, limit.window)
  const ip = clientIp(req)

  // Upsert the bucket for this window in one statement. A composite key over
  // (identity_id, ip, action, window_start) makes a conflict bump the count
  // atomically. NULL identity_id is part of the key, so anonymous traffic is
  // its own bucket.
  try {
    await db.execute(
      sql`
        insert into rate_buckets (identity_id, ip, action, window_start, count, updated_at)
        values (${identityId}, ${ip}, ${action}, ${start}, 1, now())
        on conflict (identity_id, ip, action, window_start)
        do update set count = rate_buckets.count + 1, updated_at = now()
      `,
    )
  } catch {
    // If the store is unavailable, fail open — generation still costs credits,
    // which is the primary guard against abuse.
    return null
  }

  const [row] = await db
    .select({ count: rateBuckets.count })
    .from(rateBuckets)
    .where(
      and(
        identityId
          ? eq(rateBuckets.identityId, identityId)
          : sql`${rateBuckets.identityId} is null`,
        eq(rateBuckets.ip, ip),
        eq(rateBuckets.action, action),
        eq(rateBuckets.windowStart, start),
      ),
    )
    .limit(1)

  const count = Number(row?.count ?? 0)
  if (count <= limit.max) return null

  const retryAfterMs = limit.window - (now - start.getTime())
  return Response.json(
    {
      error: `Too many ${action} requests. Try again in ${Math.ceil(Math.max(retryAfterMs, 0) / 1000)} seconds.`,
      rateLimited: true,
      retryAfter: Math.max(Math.ceil(retryAfterMs / 1000), 1),
    },
    {
      status: 429,
      headers: { 'retry-after': String(Math.max(Math.ceil(retryAfterMs / 1000), 1)) },
    },
  )
}

/** Periodic cleanup hook: drop buckets older than the longest window. Keeps
 * the table from growing without bound. Called opportunistically from the
 * generation path rather than by a scheduled job. */
export async function sweepRateBuckets(): Promise<void> {
  const oldest = new Date(Date.now() - 5 * 60_000)
  try {
    await db.delete(rateBuckets).where(sql`${rateBuckets.windowStart} < ${oldest}`)
  } catch {
    // Best-effort: a failed sweep must not break generation.
  }
}
