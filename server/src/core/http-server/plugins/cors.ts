import type { onRequestHookHandler } from 'fastify'

import {
  CLIENT_INTERFACE_ALLOWED_ORIGINS,
  HOST,
  IS_PRODUCTION_ENV,
  WEB_APP_DEV_SERVER_PORT
} from '@/constants'

function getAllowedOrigins(): string[] {
  const origins = new Set(CLIENT_INTERFACE_ALLOWED_ORIGINS)

  if (!IS_PRODUCTION_ENV) {
    origins.add(`${HOST}:${WEB_APP_DEV_SERVER_PORT}`)
  }

  return [...origins]
}

export const corsMidd: onRequestHookHandler = async (request, reply) => {
  const origin = request.headers.origin
  const allowedOrigins = getAllowedOrigins()

  if (origin && allowedOrigins.includes(origin)) {
    reply.header('Access-Control-Allow-Origin', origin)
  } else if (!IS_PRODUCTION_ENV && !origin) {
    reply.header(
      'Access-Control-Allow-Origin',
      `${HOST}:${WEB_APP_DEV_SERVER_PORT}`
    )
  }

  // Allow several headers for our requests
  reply.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, X-Leon-Client-Token'
  )

  reply.header('Access-Control-Allow-Credentials', true)
}
