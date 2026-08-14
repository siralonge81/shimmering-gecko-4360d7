import type { Config, Context } from '@netlify/functions'
import { generateImage } from '../lib/images.mts'
import { POSTERS } from '../lib/posters.mts'
import { FRAME_PREFIX, frameStore, storyStore } from '../lib/stores.mts'

const POINTER_PREFIX = 'posters/'

export default async (req: Request, context: Context) => {
  const slug = String(context.params.slug ?? '')
  const preset = POSTERS[slug]

  if (!preset) {
    return Response.json({ error: 'Unknown title.' }, { status: 404 })
  }

  const pointers = storyStore()
  const existing = await pointers.get(`${POINTER_PREFIX}${slug}`, { type: 'text' })
  if (existing) {
    return Response.json({ slug, key: existing, frameUrl: `/api/frame/${existing}`, cached: true })
  }

  try {
    const image = await generateImage(preset.prompt)
    const key = `poster-${slug}.${image.ext}`

    await frameStore().set(`${FRAME_PREFIX}${key}`, image.body)
    await pointers.set(`${POINTER_PREFIX}${slug}`, key)

    return Response.json({ slug, key, frameUrl: `/api/frame/${key}`, cached: false })
  } catch (error) {
    console.error(`poster generation failed for ${slug}:`, error)
    return Response.json({ error: 'Poster generation failed.' }, { status: 502 })
  }
}

export const config: Config = {
  path: '/api/poster/:slug',
  method: 'GET',
}
