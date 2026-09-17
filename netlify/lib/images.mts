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

function getEnv(key: string): string | undefined {
  if (typeof Netlify !== 'undefined' && Netlify.env?.get) {
    const val = Netlify.env.get(key)
    if (val) return val
  }
  return process.env[key]
}

function isGatewayToken(key?: string): boolean {
  return Boolean(key && key.startsWith('eyJ'))
}

export function gatewayBase(): string | undefined {
  const url =
    getEnv('NETLIFY_AI_GATEWAY_BASE_URL') ||
    getEnv('GOOGLE_GEMINI_BASE_URL') ||
    getEnv('OPENAI_BASE_URL')
  return url ? url.replace(/\/$/, '') : undefined
}

export function gatewayKey(): string | undefined {
  const key = getEnv('NETLIFY_AI_GATEWAY_KEY')
  if (key) return key
  const gemini = getEnv('GEMINI_API_KEY')
  if (isGatewayToken(gemini)) return gemini
  const openai = getEnv('OPENAI_API_KEY')
  if (isGatewayToken(openai)) return openai
  return undefined
}

export function isImageGenerationConfigured(): boolean {
  const hasGateway = Boolean(gatewayKey() && gatewayBase())
  const manualOpenAI = getEnv('OPENAI_API_KEY')
  const hasManualOpenAI = Boolean(manualOpenAI && !isGatewayToken(manualOpenAI))
  const manualGemini = getEnv('GEMINI_API_KEY')
  const hasManualGemini = Boolean(manualGemini && !isGatewayToken(manualGemini))
  return hasGateway || hasManualOpenAI || hasManualGemini
}

async function generateWithGatewayOpenAI(prompt: string): Promise<GeneratedImage> {
  const key = gatewayKey()
  const base = gatewayBase()
  if (!key || !base) throw new Error('Netlify AI Gateway is not configured')

  const openai = new OpenAI({
    apiKey: key,
    baseURL: `${base}/v1`,
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
  if (!base64) throw new Error('gpt-image-1 via AI Gateway returned no image data')

  return { body: toArrayBuffer(base64), ext: 'png', model: 'gpt-image-1' }
}

async function generateWithGatewayGemini(prompt: string): Promise<GeneratedImage> {
  const key = gatewayKey()
  const base = gatewayBase()
  if (!key || !base) throw new Error('Netlify AI Gateway is not configured')

  const ai = new GoogleGenAI({
    apiKey: key,
    httpOptions: { baseUrl: base },
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

  throw new Error('gemini-3-pro-image via AI Gateway returned no image data')
}

async function generateWithManualOpenAI(prompt: string): Promise<GeneratedImage> {
  const key = getEnv('OPENAI_API_KEY')
  if (!key || isGatewayToken(key)) throw new Error('Manual OPENAI_API_KEY is not configured')

  const openai = new OpenAI({
    apiKey: key,
    baseURL: getEnv('OPENAI_BASE_URL') || undefined,
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

async function generateWithManualGemini(prompt: string): Promise<GeneratedImage> {
  const key = getEnv('GEMINI_API_KEY')
  if (!key || isGatewayToken(key)) throw new Error('Manual GEMINI_API_KEY is not configured')

  const ai = new GoogleGenAI({
    apiKey: key,
    httpOptions: getEnv('GOOGLE_GEMINI_BASE_URL')
      ? { baseUrl: getEnv('GOOGLE_GEMINI_BASE_URL') }
      : undefined,
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
 * Image generation supports Netlify AI Gateway (via OpenAI or Gemini) or
 * manually configured OPENAI_API_KEY / GEMINI_API_KEY. A multi-provider fallback
 * ensures that rate limits or transient errors on one provider do not leave
 * holes in the storyboard.
 */
export async function generateImage(prompt: string): Promise<GeneratedImage> {
  const scened = `${prompt}\n\n${FILM_LOOK}`

  const providers: { name: string; run: () => Promise<GeneratedImage> }[] = []

  const hasGateway = Boolean(gatewayKey() && gatewayBase())
  const manualOpenAI = getEnv('OPENAI_API_KEY')
  const hasManualOpenAI = Boolean(manualOpenAI && !isGatewayToken(manualOpenAI))
  const manualGemini = getEnv('GEMINI_API_KEY')
  const hasManualGemini = Boolean(manualGemini && !isGatewayToken(manualGemini))

  if (hasGateway) {
    providers.push({
      name: 'Netlify AI Gateway (OpenAI gpt-image-1)',
      run: () => generateWithGatewayOpenAI(scened),
    })
    providers.push({
      name: 'Netlify AI Gateway (Gemini gemini-3-pro-image)',
      run: () => generateWithGatewayGemini(scened),
    })
  }

  if (hasManualOpenAI) {
    providers.push({
      name: 'Manual OpenAI (gpt-image-1)',
      run: () => generateWithManualOpenAI(scened),
    })
  }

  if (hasManualGemini) {
    providers.push({
      name: 'Manual Gemini (gemini-3-pro-image)',
      run: () => generateWithManualGemini(scened),
    })
  }

  if (providers.length === 0) {
    throw new Error(
      'No image generation provider configured. Enable Netlify AI Gateway or configure OPENAI_API_KEY / GEMINI_API_KEY.',
    )
  }

  let lastError: unknown
  for (const provider of providers) {
    try {
      return await provider.run()
    } catch (err) {
      console.warn(`${provider.name} failed, falling back to next provider:`, err)
      lastError = err
    }
  }

  throw new Error(
    `Image generation failed on all configured providers: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  )
}
