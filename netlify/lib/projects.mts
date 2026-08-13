import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { projects, renderJobs, scenes, shots, votes } from '../../db/schema.js'
import type { Dialogue, FilmProject, Scene, Shot } from './film.mts'

/** Writes a freshly generated plan out across projects/scenes/shots. */
export async function saveProject(userId: string, plan: FilmProject): Promise<void> {
  await db.insert(projects).values({
    id: plan.id,
    userId,
    title: plan.title,
    logline: plan.logline,
    synopsis: plan.synopsis,
    genres: plan.genres,
    brief: plan.prompt,
    mode: plan.mode,
    durationSeconds: plan.durationSeconds,
    sceneHeading: plan.sceneHeading,
  })

  if (plan.scenes.length) {
    await db.insert(scenes).values(
      plan.scenes.map((scene, position) => ({
        projectId: plan.id,
        position,
        heading: scene.heading,
        action: scene.action,
        dialogue: scene.dialogue,
      })),
    )
  }

  if (plan.shots.length) {
    await db.insert(shots).values(
      plan.shots.map((shot) => ({
        projectId: plan.id,
        number: shot.number,
        shotType: shot.shotType,
        description: shot.description,
        imagePrompt: shot.imagePrompt,
        camera: shot.camera,
        lighting: shot.lighting,
        mood: shot.mood,
        durationSeconds: shot.durationSeconds,
      })),
    )
  }
}

export type LoadedShot = Shot & {
  clipKey: string | null
  renderStatus: string | null
  renderJobId: string | null
}

export type LoadedProject = FilmProject & {
  ownerId: string | null
  published: boolean
  voteCount: number
  shots: LoadedShot[]
}

/** Reassembles the shape the interface already renders from its three tables. */
export async function loadProject(projectId: string): Promise<LoadedProject | null> {
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  if (!row) return null

  const [sceneRows, shotRows, [voteRow], jobRows] = await Promise.all([
    db.select().from(scenes).where(eq(scenes.projectId, projectId)).orderBy(asc(scenes.position)),
    db.select().from(shots).where(eq(shots.projectId, projectId)).orderBy(asc(shots.number)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(votes)
      .where(eq(votes.projectId, projectId)),
    db
      .select({
        id: renderJobs.id,
        shotNumber: renderJobs.shotNumber,
        status: renderJobs.status,
        clipKey: renderJobs.clipKey,
      })
      .from(renderJobs)
      .where(eq(renderJobs.projectId, projectId))
      .orderBy(desc(renderJobs.createdAt)),
  ])

  // Newest job per shot wins; the query is already newest-first.
  const latestJob = new Map<number, (typeof jobRows)[number]>()
  for (const job of jobRows) {
    if (job.shotNumber != null && !latestJob.has(job.shotNumber)) latestJob.set(job.shotNumber, job)
  }

  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    prompt: row.brief,
    mode: row.mode === 'advanced' ? 'advanced' : 'basic',
    title: row.title,
    logline: row.logline,
    synopsis: row.synopsis,
    genres: Array.isArray(row.genres) ? (row.genres as string[]) : [],
    durationSeconds: row.durationSeconds,
    sceneHeading: row.sceneHeading,
    scenes: sceneRows.map(
      (scene): Scene => ({
        heading: scene.heading,
        action: scene.action,
        dialogue: Array.isArray(scene.dialogue) ? (scene.dialogue as Dialogue[]) : [],
      }),
    ),
    shots: shotRows.map((shot): LoadedShot => {
      const job = latestJob.get(shot.number)
      return {
        number: shot.number,
        shotType: shot.shotType,
        description: shot.description,
        imagePrompt: shot.imagePrompt,
        camera: shot.camera,
        lighting: shot.lighting,
        mood: shot.mood,
        durationSeconds: shot.durationSeconds,
        frameKey: shot.frameKey,
        clipKey: job?.clipKey ?? null,
        renderStatus: job?.status ?? null,
        renderJobId: job?.id ?? null,
      }
    }),
    ownerId: row.userId,
    published: row.published,
    voteCount: voteRow?.count ?? 0,
  }
}

/** Records the still a shot resolved to, and adopts the first one as the poster. */
export async function setFrameKey(
  projectId: string,
  shotNumber: number,
  frameKey: string,
): Promise<void> {
  await db
    .update(shots)
    .set({ frameKey })
    .where(and(eq(shots.projectId, projectId), eq(shots.number, shotNumber)))

  if (shotNumber === 1) {
    await db.update(projects).set({ posterKey: frameKey }).where(eq(projects.id, projectId))
  }
}

export async function listProjectsForUser(userId: string) {
  return db
    .select({
      id: projects.id,
      title: projects.title,
      logline: projects.logline,
      genres: projects.genres,
      durationSeconds: projects.durationSeconds,
      posterKey: projects.posterKey,
      published: projects.published,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .where(eq(projects.userId, userId))
    .orderBy(sql`${projects.createdAt} desc`)
    .limit(24)
}
