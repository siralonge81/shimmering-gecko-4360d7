import type { Config, Context } from '@netlify/functions'
import { currentUser } from '../lib/auth.mts'
import { getAnonIdFromRequest, getProjectCount, linkAnonToUser } from '../lib/usage.mts'

export default async (req: Request, _context: Context) => {
  const user = await currentUser()
  let anonId = getAnonIdFromRequest(req)

  if (req.method === 'POST') {
    let body: { anonId?: unknown; action?: unknown } = {}
    try {
      body = await req.json()
    } catch {
      // empty body
    }
    if (typeof body.anonId === 'string' && body.anonId.trim()) {
      anonId = body.anonId.trim()
    }

    if (body.action === 'link' && user && anonId) {
      await linkAnonToUser(anonId, user.id)
    }
  }

  const projectCount = await getProjectCount(anonId, user?.id ?? null)

  return Response.json({
    projectCount,
    anonId,
    user: user ? { id: user.id, email: user.email } : null,
  })
}

export const config: Config = {
  path: '/api/project-usage',
  method: ['GET', 'POST'],
}
