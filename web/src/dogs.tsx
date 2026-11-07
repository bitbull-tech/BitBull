import type { Model } from './api'
import d1 from './assets/dogs/dog-1.webp'
import d2 from './assets/dogs/dog-2.webp'
import d3 from './assets/dogs/dog-3.webp'
import d4 from './assets/dogs/dog-4.webp'
import d5 from './assets/dogs/dog-5.webp'
import d6 from './assets/dogs/dog-6.webp'
import d7 from './assets/dogs/dog-7.webp'
import d8 from './assets/dogs/dog-8.webp'
import d9 from './assets/dogs/dog-9.webp'

/**
 * Every model in the app is shown as one of the nine BitBull detectives, by the colour of its
 * collar: the same dog in the model picker, the model browser, on its replies and in the QA Hound
 * room. The big three makers keep a fixed colour close to their own brand (Anthropic orange,
 * OpenAI green, Google blue); everything else is spread over the remaining collars by a hash of
 * the model id, so a given model always gets the same dog.
 *
 * Index order matches assets/detectives/head-N and assets/dogs/dog-N:
 * blue, green, orange, green, pink, teal, maroon, teal, purple.
 */
export const DOG_FACES = [d1, d2, d3, d4, d5, d6, d7, d8, d9]
export const DOG_COLOUR = ['blue', 'green', 'orange', 'green', 'pink', 'teal', 'maroon', 'teal', 'purple']

const FAMILY_DOG: Partial<Record<Model['family'], number>> = { anthropic: 2, openai: 1, google: 0 }
/** pink, teal, maroon, purple: the collars no maker owns */
const OTHER_DOGS = [4, 5, 6, 8]

function hash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** The same guess the server makes when the gateway doesn't say (server/src/models.ts familyOf). */
export function familyOf(id: string): Model['family'] {
  const s = id.toLowerCase()
  if (s.includes('claude') || s.startsWith('anthropic/')) return 'anthropic'
  if (/(^|\/)(gpt|o\d|chatgpt|openai)/.test(s)) return 'openai'
  if (s.includes('gemini') || s.startsWith('google/')) return 'google'
  if (/(llama|qwen|deepseek|mistral|mixtral|kimi|glm|gemma|phi|nemotron|minimax|gpt-oss)/.test(s)) return 'open'
  return 'other'
}

/** Which of the nine dogs stands for this model (0-based). */
export function dogFor(id: string, family: Model['family'] = familyOf(id)): number {
  return FAMILY_DOG[family] ?? OTHER_DOGS[hash(id) % OTHER_DOGS.length]
}

/** A model's icon: its detective's head, collar and all. */
export function ModelDog({ id, family, size = 18, className = '' }: { id: string; family?: Model['family']; size?: number; className?: string }) {
  return (
    <img
      className={`model-dog ${className}`}
      src={DOG_FACES[dogFor(id, family)]}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  )
}
