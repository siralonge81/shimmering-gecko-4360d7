import OpenAI from 'openai'
import { GoogleGenAI } from '@google/genai'

export type GeneratedImage = {
  body: ArrayBuffer
  ext: 'png' | 'jpg' | 'webp'
  model: string
}

/** Shared look so every frame in a storyboard reads as one film. */
export const FILM_LOOK =
  'Cinematic film still, anamorphic widescreen framing, 35mm photochemical texture, ' +
  'motivated practical lighting, shallow depth of field, rich contrast with lifted blacks, ' +
  'muted gold and petrol color grade. Photographic, not illustrated. ' +
  'No text, no captions, no watermarks, no letterbox bars, no split panels.'

const EXT_BY_MIME: Record<string, GeneratedImage['ext']> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
}

function toArrayBuffer(base64: string): ArrayBuffer {
  const buf = Buffer.from(base64, 'base64')
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

/**
 * Netlify normally injects per-provider credentials that the official SDKs pick
 * up on their own. When a provider's own variables are absent, the always-set
 * AI Gateway credentials reach the same models.
 */
function gatewayBase(): string {
  return (Netlify.env.get('NETLIFY_AI_GATEWAY_BASE_URL') ?? '').replace(/\/$/, '')
}

function gatewayKey(): string | undefined {
  return Netlify.env.get('NETLIFY_AI_GATEWAY_KEY')
}

async function generateWithOpenAI(prompt: string): Promise<GeneratedImage> {
  const openai = new OpenAI({
    apiKey: Netlify.env.get('OPENAI_API_KEY') ?? gatewayKey(),
    baseURL: Netlify.env.get('OPENAI_BASE_URL') ?? `${gatewayBase()}/v1`,
  })

  const result = await openai.images.generate({
    model: 'gpt-image-1',
    prompt,
    size: '1536x1024',
    quality: 'low',
    output_format: 'png',
    n: 1,
  })

  const base64 = result.data?.[0]?.b64_json
  if (!base64) throw new Error('gpt-image-1 returned no image data')

  return { body: toArrayBuffer(base64), ext: 'png', model: 'gpt-image-1' }
}

async function generateWithGemini(prompt: string): Promise<GeneratedImage> {
  const ai = new GoogleGenAI({
    apiKey: Netlify.env.get('GEMINI_API_KEY') ?? gatewayKey(),
    httpOptions: { baseUrl: Netlify.env.get('GOOGLE_GEMINI_BASE_URL') ?? gatewayBase() },
  })

  const response = await ai.models.generateContent({
    model: 'gemini-3-pro-image',
    contents: prompt,
  })

  const parts = response.candidates?.[0]?.content?.parts ?? []
  for (const part of parts) {
    const inline = part.inlineData
    if (inline?.data) {
      return {
        body: toArrayBuffer(inline.data),
        ext: EXT_BY_MIME[inline.mimeType ?? 'image/png'] ?? 'png',
        model: 'gemini-3-pro-image',
      }
    }
  }

  throw new Error('gemini-3-pro-image returned no image data')
}

/**
 * Image models are the flakiest part of the pipeline (refusals, rate limits),
 * so a failure on the primary falls through to the other provider rather than
 * dropping a hole in the storyboard.
 */
export async function generateImage(prompt: string): Promise<GeneratedImage> {
  const scened = `${prompt}\n\n${FILM_LOOK}`

  try {
    return await generateWithOpenAI(scened)
  } catch (primaryError) {
    console.warn('gpt-image-1 failed, falling back to gemini-3-pro-image:', primaryError)
    try {
      return await generateWithGemini(scened)
    } catch (fallbackError) {
      console.error('gemini-3-pro-image also failed:', fallbackError)
      throw new Error('Image generation failed on both providers')
    }
  }
}
