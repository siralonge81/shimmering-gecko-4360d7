import type { Config, Context } from '@netlify/functions'
import { AuthError, updateUser, verifyRequestOrigin } from '@netlify/identity'
import { eq } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { users } from '../../db/schema.js'
import { currentUser, unauthorized } from '../lib/auth.mts'

/**
 * Self-service account: update display name (and email via Identity), change
 * password, or delete the account entirely. Every branch mutates Identity, so
 * each one verifies the request origin first.
 */
export default async (req: Request, context: Context) => {
  const user = await currentUser()
  if (!user) return unauthorized('Sign in to manage your account.')

  try {
    verifyRequestOrigin(req)
  } catch {
    return Response.json({ error: 'Request refused: unexpected origin.' }, { status: 403 })
  }

  let body: { name?: unknown; password?: unknown; email?: unknown; confirm?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  const intent = String(context.params.action ?? '')

  if (intent === 'profile') {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) {
      return Response.json({ error: 'A display name is required.' }, { status: 400 })
    }

    await db.update(users).set({ displayName: name }).where(eq(users.id, user.id))
    try {
      await updateUser({ data: { full_name: name } })
    } catch (error) {
      // The DB row is the source of truth for the display name; Identity
      // metadata is best-effort.
      console.error('Could not sync display name to Identity:', error)
    }

    return Response.json({ user: { ...user, displayName: name } })
  }

  if (intent === 'password') {
    const password = typeof body.password === 'string' ? body.password : ''
    if (password.length < 8) {
      return Response.json({ error: 'Use a password of at least 8 characters.' }, { status: 400 })
    }
    try {
      await updateUser({ password })
    } catch (error) {
      if (error instanceof AuthError) {
        return Response.json({ error: error.message }, { status: error.status ?? 400 })
      }
      throw error
    }
    return Response.json({ ok: true })
  }

  if (intent === 'delete') {
    const confirm = typeof body.confirm === 'string' ? body.confirm.trim() : ''
    if (confirm.toUpperCase() !== 'DELETE') {
      return Response.json({ error: 'Type DELETE to confirm account deletion.' }, { status: 400 })
    }
    // Cascading foreign keys remove projects, scenes, shots, votes, the ledger,
    // and render jobs. Identity owns the credential; there is no SDK delete for
    // self-service, so the row stays as an empty shell that can never sign in
    // again once the user clears their session.
    await db.delete(users).where(eq(users.id, user.id))
    return Response.json({ ok: true, deleted: true })
  }

  return Response.json({ error: 'Unknown account action.' }, { status: 404 })
}

export const config: Config = {
  path: '/api/account/:action',
  method: 'POST',
}
