import type { Config, Context } from '@netlify/functions'
import { AuthError, getSettings, login, logout, signup, verifyRequestOrigin } from '@netlify/identity'
import { currentUser } from '../lib/auth.mts'
import { balanceFor } from '../lib/credits.mts'
import { getAnonIdFromRequest, linkAnonToUser } from '../lib/usage.mts'

/**
 * Auth runs server-side so the page stays a plain static document with no
 * bundler: the Identity library sets the `nf_jwt` cookie through the functions
 * runtime, and the browser reloads into a signed-in session.
 */
export default async (req: Request, context: Context) => {
  const action = String(context.params.action ?? '')

  if (action === 'settings') {
    try {
      const settings = await getSettings()
      return Response.json({
        autoconfirm: Boolean(settings.autoconfirm),
        disableSignup: Boolean(settings.disableSignup),
        providers: settings.providers,
      })
    } catch {
      return Response.json({
        autoconfirm: false,
        disableSignup: false,
        providers: { google: false, github: false, gitlab: false, bitbucket: false, facebook: false, email: true },
      })
    }
  }

  // Every branch below mutates the session, so it needs the same-origin check
  // this runtime does not perform for us.
  try {
    verifyRequestOrigin(req)
  } catch {
    return Response.json({ error: 'Request refused: unexpected origin.' }, { status: 403 })
  }

  if (action === 'logout') {
    await logout()
    return Response.json({ ok: true })
  }

  let body: { email?: unknown; password?: unknown; name?: unknown; anonId?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  const email = typeof body.email === 'string' ? body.email.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  if (!email || !password) {
    return Response.json({ error: 'Email and password are required.' }, { status: 400 })
  }

  try {
    if (action === 'signup') {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const created = await signup(email, password, name ? { full_name: name } : undefined)

      if (!created.confirmedAt) {
        // Autoconfirm is off, so no cookies were set and there is no session yet.
        return Response.json({ pendingConfirmation: true, email: created.email })
      }
    } else if (action === 'login') {
      await login(email, password)
    } else {
      return Response.json({ error: 'Unknown action.' }, { status: 404 })
    }

    // The account row and its opening credit grant are created on first read.
    const user = await currentUser()
    if (!user) {
      return Response.json({ error: 'Signed in, but the session did not stick.' }, { status: 500 })
    }

    const anonId = getAnonIdFromRequest(req) || (typeof body.anonId === 'string' ? body.anonId.trim() : null)
    if (anonId) {
      await linkAnonToUser(anonId, user.id)
    }

    return Response.json({
      user: { id: user.id, email: user.email, displayName: user.displayName },
      balance: await balanceFor(user.id),
    })
  } catch (error) {
    if (error instanceof AuthError) {
      const message =
        error.status === 401
          ? 'Invalid email or password.'
          : error.status === 403
            ? 'Signups are not open on this site.'
            : error.status === 422
              ? 'Check the email address and use a longer password.'
              : error.message
      return Response.json({ error: message }, { status: error.status ?? 400 })
    }

    console.error(`auth/${action} failed:`, error)
    return Response.json({ error: 'Authentication is unavailable right now.' }, { status: 502 })
  }
}

export const config: Config = {
  path: '/api/auth/:action',
  method: ['POST', 'GET'],
}
