import pkg from '../package.json' with { type: 'json' }

export const APP_NAME: string = pkg.name
export const APP_VERSION: string = pkg.version
export const USER_AGENT: string = `indexnow-relay/${pkg.version} (+https://github.com/imjlk/indexnow-relay)`
