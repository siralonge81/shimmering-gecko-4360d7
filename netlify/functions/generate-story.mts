import Anthropic from '@anthropic-ai/sdk'
import type { Config, Context } from '@netlify/functions'
import { currentUser, unauthorized } from '../lib/auth.mts'
import { CREDIT_COSTS, InsufficientCreditsError, grant, spend } from '../lib/credits.mts'
import { normalizePlan } from '../lib/film.mts'
import { checkRateLimit, sweepRateBuckets } from '../lib/rate-limit.mts'
import { saveProject } from '../lib/projects.mts'
import { getAnonIdFromRequest, getProjectCount, incrementProjectCount } from '../lib/usage.mts'

const MAX_PROMPT_LENGTH = 1200

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

export default async (req: Request, _context: Context) => {
  const user = await currentUser()
  let anonId = getAnonIdFromRequest(req)

  let body: { prompt?: unknown; mode?: unknown; anonId?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }

  if (typeof body.anonId === 'string' && body.anonId.trim()) {
    anonId = body.anonId.trim()
  }

  const projectCount = await getProjectCount(anonId, user?.id ?? null)

  if (projectCount >= 3 && !user) {
    return Response.json(
      {
        error: 'Project limit reached. Please sign up to continue.',
        requiresSignup: true,
        projectCount,
      },
      { status: 403 },
    )
  }

  // Meter before charging: an abusive caller should be refused before any
  // model call or ledger write.
  const limited = await checkRateLimit(req, 'story', user?.identityId ?? null)
  if (limited) return limited
  void sweepRateBuckets()

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
  let balance = 0
  if (user) {
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
  }

  try {
    const anthropic = new Anthropic({
      apiKey: Netlify.env.get('ANTHROPIC_API_KEY') ?? Netlify.env.get('NETLIFY_AI_GATEWAY_KEY'),
      baseURL: Netlify.env.get('ANTHROPIC_BASE_URL') ?? Netlify.env.get('NETLIFY_AI_GATEWAY_BASE_URL'),
    })
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      tools: [PLAN_TOOL],
      tool_choice: { type: 'tool', name: PLAN_TOOL.name },
      messages: [
        {
          role: 'user',
          content: `Director's brief:\n${prompt}\n\n${MODE_GUIDANCE[mode]}`,
        },
      ],
    })

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
      throw new Error('The story model returned no shots.')
    }

    await saveProject(user ? user.id : null, project)
    const newCount = await incrementProjectCount(anonId, user ? user.id : null)

    return Response.json({ project, balance, projectCount: newCount })
  } catch (error) {
    console.error('generate-story failed:', error)
    if (user) {
      const refunded = await grant(
        user.id,
        CREDIT_COSTS.story,
        'refund',
        'Refund — story generation failed',
        projectId,
      )
      return Response.json(
        { error: 'Story generation failed. Your credits were refunded.', balance: refunded },
        { status: 502 },
      )
    }
    return Response.json(
      { error: 'Story generation failed. Try again.' },
      { status: 502 },
    )
  }
}

export const config: Config = {
  path: '/api/generate-story',
  method: 'POST',
}
