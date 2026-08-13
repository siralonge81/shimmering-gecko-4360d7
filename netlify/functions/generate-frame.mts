import type { Config, Context } from '@netlify/functions'
import { buildFramePrompt, type FilmProject } from '../lib/film.mts'
import { generateImage } from '../lib/images.mts'
import { FRAME_PREFIX, STORY_PREFIX, frameStore, storyStore } from '../lib/stores.mts'

export default async (req: Request, _context: Context) => {
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

  const stories = storyStore()
  const project = (await stories.get(`${STORY_PREFIX}${projectId}.json`, {
    type: 'json',
  })) as FilmProject | null

  if (!project) {
    return Response.json({ error: 'Unknown project.' }, { status: 404 })
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

  try {
    const image = await generateImage(buildFramePrompt(project, directed))

    // A fresh key per generation keeps regenerated frames immutably cacheable.
    const nonce = crypto.randomUUID().slice(0, 8)
    const key = `shot-${projectId}-${String(shotNumber).padStart(2, '0')}-${nonce}.${image.ext}`

    await frameStore().set(`${FRAME_PREFIX}${key}`, image.body)
    // Written per shot rather than back into the project record, so frames
    // generating in parallel cannot clobber each other.
    await stories.set(`${STORY_PREFIX}${projectId}/frames/${shotNumber}`, key)

    return Response.json({ shot: shotNumber, key, frameUrl: `/api/frame/${key}`, model: image.model })
  } catch (error) {
    console.error(`generate-frame failed for ${projectId} shot ${shotNumber}:`, error)
    return Response.json({ error: 'Frame generation failed. Try again.' }, { status: 502 })
  }
}

export const config: Config = {
  path: '/api/generate-frame',
  method: 'POST',
}
