import type { NormalizedToken } from '../config/config.types.ts'
import { findToken } from '../core/site.ts'
import { forbiddenAdmin, unauthorized } from '../core/errors.ts'
import type { ApiContext } from './context.ts'

export function authenticate(context: ApiContext): NormalizedToken {
  const header = context.request.headers.get('authorization')
  if (header === null || !header.startsWith('Bearer ')) {
    throw unauthorized('Send "Authorization: Bearer <token>".')
  }

  const presented = header.slice('Bearer '.length).trim()
  if (presented.length === 0) {
    throw unauthorized('Empty bearer token.')
  }

  const token = findToken(context.app.config.auth.tokens, presented)
  if (token === undefined) {
    throw unauthorized('Unknown token.')
  }
  return token
}

/** Admin endpoints require a token with unrestricted site access. */
export function authenticateAdmin(context: ApiContext): NormalizedToken {
  const token = authenticate(context)
  if (token.sites !== '*') {
    throw forbiddenAdmin()
  }
  return token
}
