import type { Config, Context } from '@netlify/functions'
import { CLIP_PREFIX, clipStore } from '../lib/stores.mts'

const CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
}

/**
 * Streamed rather than buffered: a clip is comfortably larger than a still and
 * streaming keeps it under the response limit.
 */
export default async (_req: Request, context: Context) => {
  const key = String(context.params.key ?? '')
  const contentType = CONTENT_TYPES[key.split('.').pop() ?? '']

  if (!contentType) {
    return new Response('Not found', { status: 404 })
  }

  const clip = await clipStore().get(`${CLIP_PREFIX}${key}`, { type: 'stream' })
  if (!clip) {
    return new Response('Not found', { status: 404 })
  }

  return new Response(clip, {
    headers: {
      'content-type': contentType,
      'cache-control': 'public, max-age=31536000, immutable',
    },
  })
}

export const config: Config = {
  path: '/api/clip/:key',
  method: 'GET',
}
