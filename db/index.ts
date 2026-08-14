import { drizzle } from 'drizzle-orm/netlify-db'
import * as schema from './schema.js'

/** Connection details come from the Netlify Database environment. */
export const db = drizzle({ schema })
