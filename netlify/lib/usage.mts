import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { userProjectUsage } from '../../db/schema.js'

export function getAnonIdFromRequest(req: Request): string | null {
  const headerId = req.headers.get('x-anon-id')
  if (headerId && headerId.trim()) return headerId.trim()

  const cookieHeader = req.headers.get('cookie') || ''
  const match = cookieHeader.match(/(?:^|; )cinepay_anon_id=([^;]*)/)
  if (match && match[1]) {
    try {
      return decodeURIComponent(match[1].trim())
    } catch {
      return match[1].trim()
    }
  }

  return null
}

export async function getProjectCount(
  anonId?: string | null,
  userId?: string | null,
): Promise<number> {
  try {
    if (userId) {
      const userRows = await db
        .select()
        .from(userProjectUsage)
        .where(eq(userProjectUsage.userId, userId))
        .orderBy(desc(userProjectUsage.createdAt))
        .limit(1)

      if (userRows.length && userRows[0].projectCount !== null) {
        return userRows[0].projectCount
      }
    }

    if (anonId) {
      const anonRows = await db
        .select()
        .from(userProjectUsage)
        .where(eq(userProjectUsage.anonId, anonId))
        .orderBy(desc(userProjectUsage.createdAt))
        .limit(1)

      if (anonRows.length && anonRows[0].projectCount !== null) {
        return anonRows[0].projectCount
      }
    }
  } catch (error) {
    // If the table is pending migration, fail gracefully
    console.warn('user_project_usage query error:', error)
  }

  return 0
}

export async function incrementProjectCount(
  anonId?: string | null,
  userId?: string | null,
): Promise<number> {
  try {
    if (userId) {
      const existing = await db
        .select()
        .from(userProjectUsage)
        .where(eq(userProjectUsage.userId, userId))
        .orderBy(desc(userProjectUsage.createdAt))
        .limit(1)

      if (existing.length) {
        const current = existing[0].projectCount ?? 0
        const next = current + 1
        await db
          .update(userProjectUsage)
          .set({ projectCount: next })
          .where(eq(userProjectUsage.id, existing[0].id))
        return next
      }

      // Check if there was an anonymous record before registering
      if (anonId) {
        const anonExisting = await db
          .select()
          .from(userProjectUsage)
          .where(and(eq(userProjectUsage.anonId, anonId), isNull(userProjectUsage.userId)))
          .orderBy(desc(userProjectUsage.createdAt))
          .limit(1)

        if (anonExisting.length) {
          const next = (anonExisting[0].projectCount ?? 0) + 1
          await db
            .update(userProjectUsage)
            .set({ userId, projectCount: next })
            .where(eq(userProjectUsage.id, anonExisting[0].id))
          return next
        }
      }

      const [created] = await db
        .insert(userProjectUsage)
        .values({ userId, anonId: anonId ?? null, projectCount: 1 })
        .returning()
      return created.projectCount ?? 1
    }

    if (anonId) {
      const existing = await db
        .select()
        .from(userProjectUsage)
        .where(eq(userProjectUsage.anonId, anonId))
        .orderBy(desc(userProjectUsage.createdAt))
        .limit(1)

      if (existing.length) {
        const current = existing[0].projectCount ?? 0
        const next = current + 1
        await db
          .update(userProjectUsage)
          .set({ projectCount: next })
          .where(eq(userProjectUsage.id, existing[0].id))
        return next
      }

      const [created] = await db
        .insert(userProjectUsage)
        .values({ anonId, projectCount: 1 })
        .returning()
      return created.projectCount ?? 1
    }
  } catch (error) {
    console.warn('user_project_usage increment error:', error)
  }

  return 1
}

export async function linkAnonToUser(anonId: string, userId: string): Promise<void> {
  if (!anonId || !userId) return

  try {
    const anonRows = await db
      .select()
      .from(userProjectUsage)
      .where(and(eq(userProjectUsage.anonId, anonId), isNull(userProjectUsage.userId)))
      .limit(1)

    if (!anonRows.length) return

    const userRows = await db
      .select()
      .from(userProjectUsage)
      .where(eq(userProjectUsage.userId, userId))
      .limit(1)

    if (userRows.length) {
      // Both exist: take maximum count and delete anon row
      const merged = Math.max(userRows[0].projectCount ?? 0, anonRows[0].projectCount ?? 0)
      await db
        .update(userProjectUsage)
        .set({ projectCount: merged, anonId })
        .where(eq(userProjectUsage.id, userRows[0].id))

      await db.delete(userProjectUsage).where(eq(userProjectUsage.id, anonRows[0].id))
    } else {
      // Link anon row to user
      await db
        .update(userProjectUsage)
        .set({ userId })
        .where(eq(userProjectUsage.id, anonRows[0].id))
    }
  } catch (error) {
    console.warn('user_project_usage link error:', error)
  }
}
