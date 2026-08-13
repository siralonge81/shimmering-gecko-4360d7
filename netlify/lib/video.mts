/**
 * Video generation is the one step no model on the Netlify AI Gateway covers,
 * so it runs against an external provider. Whichever provider has credentials
 * present is used; with none configured the pipeline reports that plainly
 * instead of inventing a clip.
 *
 * Adding a provider means adding a `start` and a `poll` here — nothing above
 * this file knows which service produced the clip.
 */
export type VideoProvider = 'replicate' | 'fal'

export type RenderStart = { provider: VideoProvider; providerJobId: string }

export type RenderPoll = {
  status: 'running' | 'succeeded' | 'failed'
  videoUrl?: string
  error?: string
}

export function activeProvider(): VideoProvider | null {
  if (Netlify.env.get('REPLICATE_API_TOKEN')) return 'replicate'
  if (Netlify.env.get('FAL_KEY')) return 'fal'
  return null
}

/** Image-to-video keeps the clip faithful to the still the director approved. */
export type RenderRequest = {
  imageUrl: string
  prompt: string
  seconds: number
  webhookUrl?: string
}

const REPLICATE_MODEL =
  Netlify.env.get('REPLICATE_VIDEO_MODEL') ?? 'wan-video/wan-2.5-i2v'
const FAL_MODEL = Netlify.env.get('FAL_VIDEO_MODEL') ?? 'fal-ai/kling-video/v2/standard/image-to-video'

async function startReplicate(request: RenderRequest): Promise<RenderStart> {
  const response = await fetch(
    `https://api.replicate.com/v1/models/${REPLICATE_MODEL}/predictions`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${Netlify.env.get('REPLICATE_API_TOKEN')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        input: {
          image: request.imageUrl,
          prompt: request.prompt,
          duration: request.seconds,
        },
        ...(request.webhookUrl
          ? { webhook: request.webhookUrl, webhook_events_filter: ['completed'] }
          : {}),
      }),
    },
  )

  if (!response.ok) {
    throw new Error(`Replicate rejected the render (${response.status}): ${await response.text()}`)
  }

  const body = (await response.json()) as { id?: string }
  if (!body.id) throw new Error('Replicate returned no prediction id.')

  return { provider: 'replicate', providerJobId: body.id }
}

async function pollReplicate(providerJobId: string): Promise<RenderPoll> {
  const response = await fetch(`https://api.replicate.com/v1/predictions/${providerJobId}`, {
    headers: { authorization: `Bearer ${Netlify.env.get('REPLICATE_API_TOKEN')}` },
  })

  if (!response.ok) {
    return { status: 'failed', error: `Replicate status check failed (${response.status}).` }
  }

  const body = (await response.json()) as {
    status?: string
    output?: string | string[]
    error?: string
  }

  if (body.status === 'succeeded') {
    const output = Array.isArray(body.output) ? body.output[0] : body.output
    return output
      ? { status: 'succeeded', videoUrl: output }
      : { status: 'failed', error: 'Replicate finished without an output clip.' }
  }

  if (body.status === 'failed' || body.status === 'canceled') {
    return { status: 'failed', error: body.error || `Render ${body.status}.` }
  }

  return { status: 'running' }
}

async function startFal(request: RenderRequest): Promise<RenderStart> {
  const response = await fetch(`https://queue.fal.run/${FAL_MODEL}`, {
    method: 'POST',
    headers: {
      authorization: `Key ${Netlify.env.get('FAL_KEY')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      image_url: request.imageUrl,
      prompt: request.prompt,
      duration: String(request.seconds),
      ...(request.webhookUrl ? { webhook_url: request.webhookUrl } : {}),
    }),
  })

  if (!response.ok) {
    throw new Error(`fal rejected the render (${response.status}): ${await response.text()}`)
  }

  const body = (await response.json()) as { request_id?: string }
  if (!body.request_id) throw new Error('fal returned no request id.')

  return { provider: 'fal', providerJobId: body.request_id }
}

async function pollFal(providerJobId: string): Promise<RenderPoll> {
  const status = await fetch(`https://queue.fal.run/${FAL_MODEL}/requests/${providerJobId}/status`, {
    headers: { authorization: `Key ${Netlify.env.get('FAL_KEY')}` },
  })

  if (!status.ok) {
    return { status: 'failed', error: `fal status check failed (${status.status}).` }
  }

  const state = (await status.json()) as { status?: string }
  if (state.status !== 'COMPLETED') {
    return state.status === 'FAILED'
      ? { status: 'failed', error: 'fal reported a failed render.' }
      : { status: 'running' }
  }

  const result = await fetch(`https://queue.fal.run/${FAL_MODEL}/requests/${providerJobId}`, {
    headers: { authorization: `Key ${Netlify.env.get('FAL_KEY')}` },
  })

  if (!result.ok) {
    return { status: 'failed', error: `fal result fetch failed (${result.status}).` }
  }

  const body = (await result.json()) as { video?: { url?: string } }
  return body.video?.url
    ? { status: 'succeeded', videoUrl: body.video.url }
    : { status: 'failed', error: 'fal finished without an output clip.' }
}

export async function startRender(
  provider: VideoProvider,
  request: RenderRequest,
): Promise<RenderStart> {
  return provider === 'replicate' ? startReplicate(request) : startFal(request)
}

export async function pollRender(
  provider: VideoProvider,
  providerJobId: string,
): Promise<RenderPoll> {
  return provider === 'replicate' ? pollReplicate(providerJobId) : pollFal(providerJobId)
}

/** Providers hand back a URL; the bytes belong in Blobs alongside the stills. */
export async function downloadClip(videoUrl: string): Promise<{ body: ArrayBuffer; ext: string }> {
  const response = await fetch(videoUrl)
  if (!response.ok) {
    throw new Error(`Could not download the finished clip (${response.status}).`)
  }

  const type = response.headers.get('content-type') ?? ''
  const ext = type.includes('webm') ? 'webm' : 'mp4'
  return { body: await response.arrayBuffer(), ext }
}
