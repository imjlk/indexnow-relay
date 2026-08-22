import { closeApp, createApp, routeRequest } from './app.ts'

const app = await createApp()

const server = Bun.serve({
  port: app.config.server.port,
  hostname: app.config.server.host,
  fetch: (request) => routeRequest(app, request),
})

app.logger.info('relay listening', {
  host: app.config.server.host,
  port: server.port,
})

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  app.logger.info('shutting down', { signal })
  server.stop(true)
  await closeApp(app)
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
