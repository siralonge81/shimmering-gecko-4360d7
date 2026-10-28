import type { Config, Context } from '@netlify/functions'
import { CLIP_PREFIX, clipStore } from '../lib/stores.mts'

const CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
}

// Browsers play video by asking for it in pieces (HTTP Range requests). Serving
// pieces of at most this size also keeps each response under Netlify's size limit.
const MAX_CHUNK = 4 * 1024 * 1024

export default async (req: Request, context: Context) => {
  const key = String(context.params.key ?? '')
  const contentType = CONTENT_TYPES[key.split('.').pop() ?? '']

  if (!contentType) {
    return new Response('Not found', { status: 404 })
  }

  const data = await clipStore().get(`${CLIP_PREFIX}${key}`, { type: 'arrayBuffer' })
  if (!data) {
    return new Response('Not found', { status: 404 })
  }

  const size = data.byteLength
  const headers = {
    'content-type': contentType,
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=31536000, immutable',
  }

  const range = req.headers.get('range')
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null

  if (match) {
    const startText = match[1]
    const endText = match[2]
    let start: number
    let end: number

    if (startText === '') {
      // "bytes=-N" means the last N bytes.
      start = Math.max(size - Number(endText), 0)
      end = size - 1
    } else {
      start = Number(startText)
      end = endText === '' ? size - 1 : Math.min(Number(endText), size - 1)
    }

    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) {
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'content-range': `bytes */${size}` },
      })
    }

    end = Math.min(end, start + MAX_CHUNK - 1)

    return new Response(data.slice(start, end + 1), {
      status: 206,
      headers: {
        ...headers,
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': String(end - start + 1),
      },
    })
  }

  return new Response(data, { headers: { ...headers, 'content-length': String(size) } })
}

export const config: Config = {
  path: '/api/clip/:key',
  method: 'GET',
}
