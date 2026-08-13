import type { Config, Context } from '@netlify/functions'
import type { FilmProject } from '../lib/film.mts'
import { STORY_PREFIX, storyStore } from '../lib/stores.mts'

export default async (_req: Request, context: Context) => {
  const id = String(context.params.id ?? '')
  const stories = storyStore()

  const project = (await stories.get(`${STORY_PREFIX}${id}.json`, { type: 'json' })) as FilmProject | null
  if (!project) {
    return Response.json({ error: 'Unknown project.' }, { status: 404 })
  }

  // Frame keys live one blob per shot; fold them back into the shot list.
  const framePrefix = `${STORY_PREFIX}${id}/frames/`
  const { blobs } = await stories.list({ prefix: framePrefix })

  await Promise.all(
    blobs.map(async ({ key }) => {
      const shotNumber = Number(key.slice(framePrefix.length))
      const shot = project.shots.find((candidate) => candidate.number === shotNumber)
      if (!shot) return
      shot.frameKey = await stories.get(key, { type: 'text' })
    }),
  )

  return Response.json({ project })
}

export const config: Config = {
  path: '/api/story/:id',
  method: 'GET',
}
