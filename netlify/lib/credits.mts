import { desc, eq, sql } from 'drizzle-orm'
import { db } from '../../db/index.js'
import { creditLedger, users } from '../../db/schema.js'

/** Opening balance for a new account — enough for a story and a few frames. */
export const SIGNUP_GRANT = 250

/**
 * What each generation costs. These are the numbers the interface quotes before
 * the work starts, so they live in one place.
 */
export const CREDIT_COSTS = {
  story: 10,
  frame: 20,
  video: 120,
} as const

export type SpendReason = keyof typeof CREDIT_COSTS | 'signup_grant' | 'topup' | 'refund'

export class InsufficientCreditsError extends Error {
  readonly required: number
  readonly balance: number

  constructor(required: number, balance: number) {
    super(`Needs ${required} credits, balance is ${balance}.`)
    this.name = 'InsufficientCreditsError'
    this.required = required
    this.balance = balance
  }
}

export async function balanceFor(userId: string): Promise<number> {
  const [row] = await db
    .select({ balance: sql<number>`coalesce(sum(${creditLedger.delta}), 0)::int` })
    .from(creditLedger)
    .where(eq(creditLedger.userId, userId))

  return row?.balance ?? 0
}

/** Adds credits. Positive deltas only — spending goes through `spend`. */
export async function grant(
  userId: string,
  amount: number,
  reason: SpendReason,
  description = '',
  refId: string | null = null,
): Promise<number> {
  if (amount <= 0) throw new Error('Grant amount must be positive.')

  await db.insert(creditLedger).values({ userId, delta: amount, reason, description, refId })
  return balanceFor(userId)
}

/**
 * Debits the ledger inside a transaction that locks the account's rows first,
 * so two generations started at once cannot both spend the same balance.
 * Throws InsufficientCreditsError rather than allowing an overdraft.
 */
export async function spend(
  userId: string,
  amount: number,
  reason: SpendReason,
  description = '',
  refId: string | null = null,
): Promise<number> {
  if (amount <= 0) throw new Error('Spend amount must be positive.')

  return db.transaction(async (tx) => {
    // Postgres refuses FOR UPDATE next to an aggregate, so the lock is taken on
    // the account row instead: a second spend for the same account waits here,
    // and the balance below is only read once this transaction owns that row.
    await tx.execute(
      sql`select ${users.id} from ${users} where ${users.id} = ${userId} for update`,
    )

    const [row] = await tx
      .select({ balance: sql<number>`coalesce(sum(${creditLedger.delta}), 0)::int` })
      .from(creditLedger)
      .where(eq(creditLedger.userId, userId))

    const balance = Number(row?.balance ?? 0)

    if (balance < amount) {
      throw new InsufficientCreditsError(amount, balance)
    }

    await tx
      .insert(creditLedger)
      .values({ userId, delta: -amount, reason, description, refId })

    return balance - amount
  })
}

export async function recentLedger(userId: string, limit = 12) {
  return db
    .select({
      id: creditLedger.id,
      delta: creditLedger.delta,
      reason: creditLedger.reason,
      description: creditLedger.description,
      createdAt: creditLedger.createdAt,
    })
    .from(creditLedger)
    .where(eq(creditLedger.userId, userId))
    .orderBy(desc(creditLedger.createdAt))
    .limit(limit)
}
