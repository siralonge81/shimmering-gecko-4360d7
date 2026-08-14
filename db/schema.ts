import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Identity owns credentials; this table owns everything CinePay needs to join
 * against (projects, votes, credits). `identity_id` is the GoTrue user id and is
 * the only link between the two.
 */
export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey().defaultRandom(),
    identityId: text('identity_id').notNull(),
    email: text().notNull(),
    displayName: text('display_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('users_identity_id_key').on(table.identityId),
    uniqueIndex('users_email_key').on(table.email),
  ],
)

export const projects = pgTable(
  'projects',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    slug: text(),
    title: text().notNull(),
    logline: text().notNull().default(''),
    synopsis: text().notNull().default(''),
    genres: jsonb().notNull().default(sql`'[]'::jsonb`),
    brief: text().notNull().default(''),
    mode: text().notNull().default('basic'),
    durationSeconds: integer('duration_seconds').notNull().default(60),
    sceneHeading: text('scene_heading').notNull().default(''),
    posterKey: text('poster_key'),
    published: boolean().notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('projects_slug_key').on(table.slug),
    index('projects_user_id_idx').on(table.userId),
    index('projects_published_idx').on(table.published),
  ],
)

export const scenes = pgTable(
  'scenes',
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    heading: text().notNull(),
    action: text().notNull().default(''),
    /** [{ character, parenthetical, line }] — screenplay order. */
    dialogue: jsonb().notNull().default(sql`'[]'::jsonb`),
  },
  (table) => [uniqueIndex('scenes_project_position_key').on(table.projectId, table.position)],
)

export const shots = pgTable(
  'shots',
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    number: integer().notNull(),
    shotType: text('shot_type').notNull().default('Medium shot'),
    description: text().notNull().default(''),
    imagePrompt: text('image_prompt').notNull().default(''),
    camera: text().notNull().default('Static'),
    lighting: text().notNull().default('Available light'),
    mood: text().notNull().default('Neutral'),
    durationSeconds: integer('duration_seconds').notNull().default(5),
    /** Blob key for the rendered still; the bytes live in Netlify Blobs. */
    frameKey: text('frame_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('shots_project_number_key').on(table.projectId, table.number)],
)

/**
 * One row per (viewer, film). The unique index is what makes voting
 * ungameable — a second vote is a constraint violation, not an increment.
 */
export const votes = pgTable(
  'votes',
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('votes_project_user_key').on(table.projectId, table.userId),
    index('votes_project_id_idx').on(table.projectId),
  ],
)

/**
 * Append-only. Balance is SUM(delta) — rows are never updated or deleted, so
 * every debit stays auditable against the generation that caused it.
 */
export const creditLedger = pgTable(
  'credit_ledger',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Positive credits granted or purchased, negative spent. */
    delta: integer().notNull(),
    /** signup_grant | topup | story | frame | video | refund */
    reason: text().notNull(),
    description: text().notNull().default(''),
    /** Project, shot, or render job this entry paid for. */
    refId: text('ref_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('credit_ledger_user_id_idx').on(table.userId)],
)

/**
 * Per-user, per-action rate-limit counters. A row is touched on every
 * generation request; the window is short and the table is trimmed as old
 * buckets age out, so it stays small. Lives in the database so every function
 * instance sees the same count.
 */
export const rateBuckets = pgTable(
  'rate_buckets',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** The Identity user id, so anonymous abuse is also bounded by IP. */
    identityId: text('identity_id'),
    ip: text(),
    /** story | frame | video — which metered endpoint this counts. */
    action: text().notNull(),
    /** Truncated to the second; one row per (key, action, window). */
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer().notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('rate_buckets_key_window_key')
      .on(table.identityId, table.ip, table.action, table.windowStart),
    index('rate_buckets_window_idx').on(table.windowStart),
  ],
)

/**
 * Video renders run on an external provider and outlive a request, so the job
 * is a row that a background function advances and the browser polls.
 */
export const renderJobs = pgTable(
  'render_jobs',
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    shotNumber: integer('shot_number'),
    /** queued | running | succeeded | failed | unavailable */
    status: text().notNull().default('queued'),
    provider: text(),
    providerJobId: text('provider_job_id'),
    /** Blob key for the finished clip. */
    clipKey: text('clip_key'),
    error: text(),
    creditsHeld: integer('credits_held').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('render_jobs_project_id_idx').on(table.projectId),
    index('render_jobs_status_idx').on(table.status),
    // At most one unfinished job per shot: two clicks cannot both be charged.
    uniqueIndex('render_jobs_open_shot_key')
      .on(table.projectId, table.shotNumber)
      .where(sql`status in ('queued', 'running')`),
  ],
)
