import type { FastifyPluginAsync } from 'fastify'

import { getLiveWidgets } from '@/core/http-server/api/live-widgets/get'
import type { APIOptions } from '@/core/http-server/http-server'

export const liveWidgetsPlugin: FastifyPluginAsync<APIOptions> = async (
  fastify,
  options
) => {
  await fastify.register(getLiveWidgets, options)
}
