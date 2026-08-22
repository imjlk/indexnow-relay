/**
 * ULID generation for receipt and batch identifiers.
 *
 * 26-character Crockford base32: 48-bit millisecond timestamp + 80 bits of
 * randomness. Lexicographically sortable, so receipts and batches can be
 * listed in creation order without an autoincrement column.
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_LEN = 10
const RANDOM_LEN = 16

export function createUlid(now: number = Date.now()): string {
  let time = ''
  let remaining = now
  for (let i = 0; i < TIME_LEN; i++) {
    time = ENCODING[remaining % 32]! + time
    remaining = Math.floor(remaining / 32)
  }

  const randomBytes = new Uint8Array(RANDOM_LEN)
  crypto.getRandomValues(randomBytes)
  let random = ''
  for (let i = 0; i < RANDOM_LEN; i++) {
    random += ENCODING[randomBytes[i]! % 32]
  }

  return time + random
}
