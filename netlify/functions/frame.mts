import type { Config, Context } from '@netlify/functions'
import { FRAME_PREFIX, frameStore } from '../lib/stores.mts'

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
}

export default async (_req: Request, context: Context) => {
  const key = String(context.params.key ?? '')
  const extension = key.split('.').pop() ?? ''
  const contentType = CONTENT_TYPES[extension]

  if (!contentType) {
    return new Response('Not found', { status: 404 })
  }

  const image = await frameStore().get(`${FRAME_PREFIX}${key}`, { type: 'arrayBuffer' })
  if (!image) {
    return new Response('Not found', { status: 404 })
  }

  // Keys are unique per generation, so the bytes behind one never change.
  return new Response(image, {
    headers: {
      'content-type': contentType,
      'cache-control': 'public, max-age=31536000, immutable',
    },
  })
}

export const config: Config = {
  path: '/api/frame/:key',
  method: 'GET',
}
