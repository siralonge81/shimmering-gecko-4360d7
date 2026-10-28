import Anthropic from '@anthropic-ai/sdk'
import type { Config, Context } from '@netlify/functions'
import { currentUser, unauthorized } from '../lib/auth.mts'
import { CREDIT_COSTS, InsufficientCreditsError, grant, spend } from '../lib/credits.mts'
import { normalizePlan } from '../lib/film.mts'
import { checkRateLimit, sweepRateBuckets } from '../lib/rate-limit.mts'
import { saveProject } from '../lib/projects.mts'

const MAX_PROMPT_LENGTH = 1200

// Faster model by default so a story finishes well inside Netlify's function time limit.
// To switch models without changing code, set STORY_MODEL in Netlify environment variables.
const STORY_MODEL = Netlify.env.get('STORY_MODEL') || 'claude-haiku-5-5'

const SYSTEM_PROMPT = `You are the development department of CinePay, a studio that turns a one-line idea into a shootable short film.

Given a director's brief you deliver, in one pass: a title, a logline, a short synopsis, a scripted scene in screenplay form, and a numbered shot list that covers the whole scene.

Rules:
- Keep the running time the director asked for. If they did not say, assume 60 seconds.
- One scene unless the brief clearly needs two. Never more than two.
- The shot list must add up to roughly the running time, one shot per beat.
- Every shot needs an image_prompt: a single dense paragraph a text-to-image model can render on its own, describing subject, wardrobe, setting, weather, time of day, lens and framing. Name characters by look ("a woman in her forties, close-cropped hair, soaked linen shirt") rather than by name, since the image model has no memory between shots.
- Keep visual continuity across shots: the same wardrobe, weather, and light in every image_prompt.
- Dialogue is sparse and subtextual. Action lines are present tense and lean.
- Write imagery that a camera can actually photograph. No on-screen text or title cards.
- Always fill in every field, including at least one genre tag.`

const MODE_GUIDANCE = {
  basic: 'Deliver 6 shots. Keep camera and lighting language plain and readable.',
  advanced:
    'Deliver 9 shots. Use precise cinematography language — lens length, camera movement, lighting instruments, and grade references — in both the shot list and the image prompts.',
} as const

const PLAN_TOOL: Anthropic.Tool = {
  name: 'deliver_film_plan',
  description: 'Return the complete development package for the director’s brief.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short, evocative film title.' },
      logline: { type: 'string', description: 'One sentence: character, want, obstacle.' },
      synopsis: { type: 'string', description: 'Two to three sentences of story.' },
      genres: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description: 'One to three single-word genre tags, e.g. Crime, Drama. Never empty.',
      },
      duration_seconds: { type: 'number', description: 'Total running time in seconds.' },
      scenes: {
        type: 'array',
        description: 'The scripted scene(s), in screenplay order.',
        items: {
          type: 'object',
          properties: {
            heading: { type: 'string', description: 'Slug line, e.g. EXT. LAGOS WATERFRONT — NIGHT' },
            action: { type: 'string', description: 'Action lines, present tense.' },
            dialogue: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  character: { type: 'string' },
                  parenthetical: { type: 'string' },
                  line: { type: 'string' },
                },
                required: ['character', 'line'],
              },
            },
          },
          required: ['heading', 'action'],
        },
      },
      shots: {
        type: 'array',
        description: 'The shot list, in cut order.',
        items: {
          type: 'object',
          properties: {
            shot_type: { type: 'string', description: 'e.g. Wide shot, Close-up, Over-the-shoulder.' },
            description: { type: 'string', description: 'One line describing what happens in the shot.' },
            image_prompt: { type: 'string', description: 'Self-contained prompt for a text-to-image model.' },
            camera_move: { type: 'string', description: 'e.g. Static, Slow push-in, Handheld track.' },
            lighting: { type: 'string', description: 'e.g. Neon spill, Practical lamp, Moonlight rim.' },
            mood: { type: 'string', description: 'e.g. Tense, Tender, Ominous.' },
            duration_seconds: { type: 'number' },
          },
          required: ['shot_type', 'description', 'image_prompt', 'camera_move', 'lighting', 'mood', 'duration_seconds'],
        },
      },
    },
    required: ['title', 'logline', 'synopsis', 'genres', 'duration_seconds', 'scenes', 'shots'],
  },
}

async function handle(req: Request, _context: Context) {
  const user = await currentUser()
  if (!user) return unauthorized('Sign in to generate a film.')

  // Meter before charging: an abusive caller should be refused before any
  // model call or ledger write.
  const limited = await checkRateLimit(req, 'story', user.identityId)
  if (limited) return limited
  void sweepRateBuckets()

  let body: { prompt?: unknown; mode?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt) {
    return Response.json({ error: 'Describe the scene you want to make.' }, { status: 400 })
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return Response.json(
      { error: `Keep the brief under ${MAX_PROMPT_LENGTH} characters.` },
      { status: 400 },
    )
  }

  const mode = body.mode === 'advanced' ? 'advanced' : 'basic'
  const projectId = crypto.randomUUID()

  // Charged up front so a balance cannot be spent twice by parallel requests;
  // refunded below if the model never delivers a plan.
  let balance: number
  try {
    balance = await spend(
      user.id,
      CREDIT_COSTS.story,
      'story',
      `Story, script and shot list — ${mode}`,
      projectId,
    )
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

  let reason = 'MODEL_ERROR'
  try {
    // The SDK uses the provider credentials and URL injected by AI Gateway.
    // Netlify synchronous functions allow 60s; leave time for persistence/refunds.
    const anthropic = new Anthropic({ timeout: 45_000, maxRetries: 0 })
    const message = await anthropic.messages.create({
      model: STORY_MODEL,
      max_tokens: 3500,
      system: SYSTEM_PROMPT,
      tools: [PLAN_TOOL],
      tool_choice: { type: 'auto' },
      messages: [
        {
          role: 'user',
          content: `Director's brief:\n${prompt}\n\n${MODE_GUIDANCE[mode]}\n\nRespond only by calling the deliver_film_plan tool with the complete package.`,
        },
      ],
    })

    reason = 'INVALID_PLAN'
    if (message.stop_reason === 'max_tokens') {
      reason = 'TOKEN_LIMIT'
      throw new Error('The story model exceeded the output token limit.')
    }
    const toolUse = message.content.find((block) => block.type === 'tool_use')
    if (!toolUse || toolUse.type !== 'tool_use') {
      throw new Error('The story model returned no tool call.')
    }

    const project = normalizePlan(toolUse.input as Record<string, unknown>, {
      id: projectId,
      prompt,
      mode,
    })

    if (!project.shots.length) {
      const raw = toolUse.input as Record<string, unknown>
      throw new Error(
        `The story model returned no shots. Keys: ${Object.keys(raw).join(',')}; shots is ${typeof raw.shots}; stop reason: ${message.stop_reason}`,
      )
    }

    reason = 'SAVE_FAILED'
    await saveProject(user.id, project)

    return Response.json({
      project: { ...project, ownerId: user.id, published: false, voteCount: 0 },
      balance,
    })
  } catch (error) {
    if (error instanceof Anthropic.APIConnectionTimeoutError) reason = 'MODEL_TIMEOUT'
    else if (error instanceof Anthropic.APIConnectionError) reason = 'MODEL_CONNECTION'
    else if (error instanceof Anthropic.APIError) reason = `MODEL_HTTP_${error.status ?? 'ERROR'}`
    const detail = String((error as Error)?.message ?? error).slice(0, 600)
    console.error('generate-story failed:', {
      reason,
      projectId,
      status: error instanceof Anthropic.APIError ? error.status : undefined,
      // For a MODEL_HTTP_400 this carries the provider's explanation of what was wrong.
      detail,
    })
    let refunded: number
    try {
      refunded = await grant(
        user.id,
        CREDIT_COSTS.story,
        'refund',
        'Refund — story generation failed',
        projectId,
      )
    } catch {
      console.error('generate-story refund failed:', { reason, projectId })
      return Response.json(
        {
          error: `Story generation failed (${reason}). We could not confirm your credit refund. Contact support with reference ${projectId}.`,
          reason,
          refundStatus: 'unconfirmed',
          reference: projectId,
        },
        { status: 502 },
      )
    }
    return Response.json(
      {
        // TEMPORARY DEBUGGING: shows the provider's message on the page. Remove once fixed.
        error: `Story generation failed (${reason}): ${detail} — Your credits were refunded.`,
        detail,
        reason,
        refundStatus: 'refunded',
        balance: refunded,
      },
      { status: 502 },
    )
  }
}

// Any crash outside the model call (database, auth, module errors) used to reach the
// browser as an unreadable server error. This turns it into a message the page can show.
export default async (req: Request, context: Context) => {
  try {
    return await handle(req, context)
  } catch (error) {
    const detail = String((error as Error)?.message ?? error).slice(0, 400)
    console.error('generate-story unhandled error:', detail)
    return Response.json(
      { error: `Story generation hit a server error (UNHANDLED): ${detail}`, reason: 'UNHANDLED' },
      { status: 500 },
    )
  }
}

export const config: Config = {
  path: '/api/generate-story',
  method: 'POST',
}
