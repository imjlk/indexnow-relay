import { ORPCError } from '@orpc/server'

/**
 * Domain error codes exposed through oRPC contracts. Each code maps to an
 * HTTP status via the OpenAPI error status map (see src/api/openapi.ts).
 */
export type DomainErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'FORBIDDEN_SITE'
  | 'INVALID_URL'
  | 'UNKNOWN_SITE'
  | 'NOT_FOUND'

export type DomainError = ORPCError<string, unknown>

export function domainError(code: DomainErrorCode, message: string, data?: Record<string, unknown>): DomainError {
  return new ORPCError(code, {
    message,
    ...(data === undefined ? {} : { data }),
  })
}

export function unauthorized(message = 'Missing or invalid bearer token.'): DomainError {
  return domainError('UNAUTHORIZED', message)
}

export function forbiddenAdmin(message = 'This endpoint requires an unrestricted token.'): DomainError {
  return domainError('FORBIDDEN', message)
}
