import typia from 'typia'

interface Warm {
  url: string
}

// Compile-time warm-up only: builds the ttsc/typia native plugin (Go) so the
// cache holds a ready plugin binary. Never imported by the application.
export const warm = typia.createValidateEquals<Warm>
