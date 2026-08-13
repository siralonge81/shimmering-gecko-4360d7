import type { Config, Context } from '@netlify/functions'
import { currentUser, unauthorized } from '../lib/auth.mts'
import { CREDIT_COSTS, InsufficientCreditsError, grant, spend } from '../lib/credits.mts'
import { buildFramePrompt } from '../lib/film.mts'
import { generateImage } from '../lib/images.mts'
import { loadProject, setFrameKey } from '../lib/projects.mts'
import { FRAME_PREFIX, frameStore } from '../lib/stores.mts'

export default async (req: Request, _context: Context) => {
  const user = await currentUser()
  if (!user) return unauthorized('Sign in to generate frames.')

  let body: { projectId?: unknown; shot?: unknown; camera?: unknown; lighting?: unknown; mood?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  const projectId = typeof body.projectId === 'string' ? body.projectId : ''
  const shotNumber = Number(body.shot)
  if (!projectId || !Number.isInteger(shotNumber)) {
    return Response.json({ error: 'projectId and shot are required.' }, { status: 400 })
  }

  const project = await loadProject(projectId)
  if (!project) {
    return Response.json({ error: 'Unknown project.' }, { status: 404 })
  }
  if (project.ownerId !== user.id) {
    return Response.json({ error: 'That project belongs to another director.' }, { status: 403 })
  }

  const shot = project.shots.find((candidate) => candidate.number === shotNumber)
  if (!shot) {
    return Response.json({ error: 'Unknown shot.' }, { status: 404 })
  }

  // The workspace controls can override the look the story model chose.
  const directed = {
    ...shot,
    camera: typeof body.camera === 'string' && body.camera ? body.camera : shot.camera,
    lighting: typeof body.lighting === 'string' && body.lighting ? body.lighting : shot.lighting,
    mood: typeof body.mood === 'string' && body.mood ? body.mood : shot.mood,
  }

  const ref = `${projectId}:${shotNumber}`
  let balance: number
  try {
    balance = await spend(user.id, CREDIT_COSTS.frame, 'frame', `Still — shot ${shotNumber}`, ref)
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

  try {
    const image = await generateImage(buildFramePrompt(project, directed))

    // A fresh key per generation keeps regenerated frames immutably cacheable.
    const nonce = crypto.randomUUID().slice(0, 8)
    const key = `shot-${projectId}-${String(shotNumber).padStart(2, '0')}-${nonce}.${image.ext}`

    await frameStore().set(`${FRAME_PREFIX}${key}`, image.body)
    await setFrameKey(projectId, shotNumber, key)

    return Response.json({
      shot: shotNumber,
      key,
      frameUrl: `/api/frame/${key}`,
      model: image.model,
      balance,
    })
  } catch (error) {
    console.error(`generate-frame failed for ${projectId} shot ${shotNumber}:`, error)
    const refunded = await grant(
      user.id,
      CREDIT_COSTS.frame,
      'refund',
      `Refund — shot ${shotNumber} failed`,
      ref,
    )
    return Response.json(
      { error: 'Frame generation failed. Your credits were refunded.', balance: refunded },
      { status: 502 },
    )
  }
}

export const config: Config = {
  path: '/api/generate-frame',
  method: 'POST',
}
