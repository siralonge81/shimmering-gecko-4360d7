import { getStore } from '@netlify/blobs'

/**
 * Film plans are written by /api/generate-story and read back immediately by
 * /api/generate-frame, so both stores need read-after-write consistency.
 */
export function storyStore() {
  return getStore({ name: 'cinepay-stories', consistency: 'strong' })
}

export function frameStore() {
  return getStore({ name: 'cinepay-frames', consistency: 'strong' })
}

export const STORY_PREFIX = 'projects/'
export const FRAME_PREFIX = 'frames/'
