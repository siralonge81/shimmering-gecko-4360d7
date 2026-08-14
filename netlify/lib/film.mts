export type Dialogue = {
  character: string
  parenthetical: string
  line: string
}

export type Scene = {
  heading: string
  action: string
  dialogue: Dialogue[]
}

export type Shot = {
  number: number
  shotType: string
  description: string
  imagePrompt: string
  camera: string
  lighting: string
  mood: string
  durationSeconds: number
  frameKey: string | null
}

export type FilmProject = {
  id: string
  createdAt: string
  prompt: string
  mode: 'basic' | 'advanced'
  title: string
  logline: string
  synopsis: string
  genres: string[]
  durationSeconds: number
  sceneHeading: string
  scenes: Scene[]
  shots: Shot[]
}

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback

const num = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value))
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/**
 * The model is asked for this shape via a forced tool call, but a film plan is
 * rendered directly into the UI — so every field is coerced to something
 * displayable before it is stored.
 */
export function normalizePlan(
  raw: Record<string, unknown>,
  meta: { id: string; prompt: string; mode: 'basic' | 'advanced' },
): FilmProject {
  const scenes: Scene[] = arr(raw.scenes)
    .slice(0, 6)
    .map((entry) => {
      const scene = entry as Record<string, unknown>
      return {
        heading: str(scene.heading, 'INT. UNSPECIFIED — DAY').toUpperCase(),
        action: str(scene.action),
        dialogue: arr(scene.dialogue)
          .slice(0, 12)
          .map((line) => {
            const spoken = line as Record<string, unknown>
            return {
              character: str(spoken.character, 'VOICE').toUpperCase(),
              parenthetical: str(spoken.parenthetical),
              line: str(spoken.line),
            }
          })
          .filter((line) => line.line),
      }
    })
    .filter((scene) => scene.action || scene.dialogue.length)

  const shots: Shot[] = arr(raw.shots)
    .slice(0, 12)
    .map((entry, index) => {
      const shot = entry as Record<string, unknown>
      const description = str(shot.description, 'Continuation of the scene.')
      return {
        number: index + 1,
        shotType: str(shot.shot_type, 'Medium shot'),
        description,
        imagePrompt: str(shot.image_prompt, description),
        camera: str(shot.camera_move, 'Static'),
        lighting: str(shot.lighting, 'Available light'),
        mood: str(shot.mood, 'Neutral'),
        durationSeconds: num(shot.duration_seconds, 5, 1, 20),
        frameKey: null,
      }
    })

  return {
    id: meta.id,
    createdAt: new Date().toISOString(),
    prompt: meta.prompt,
    mode: meta.mode,
    title: str(raw.title, 'Untitled Project'),
    logline: str(raw.logline, ''),
    synopsis: str(raw.synopsis, ''),
    genres: arr(raw.genres)
      .slice(0, 4)
      .map((genre) => str(genre))
      .filter(Boolean),
    durationSeconds: num(raw.duration_seconds, 60, 10, 600),
    sceneHeading: scenes[0]?.heading ?? 'EXT. LOCATION — NIGHT',
    scenes,
    shots,
  }
}

/** Prompt handed to the image model for a single storyboard frame. */
export function buildFramePrompt(project: FilmProject, shot: Shot): string {
  return [
    `Storyboard frame ${shot.number} of ${project.shots.length} from the short film "${project.title}".`,
    project.logline && `Story: ${project.logline}`,
    `Location: ${project.sceneHeading}.`,
    `Frame: ${shot.imagePrompt}`,
    `Shot size: ${shot.shotType}. Camera: ${shot.camera}. Lighting: ${shot.lighting}. Mood: ${shot.mood}.`,
  ]
    .filter(Boolean)
    .join('\n')
}
