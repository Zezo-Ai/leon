import type { FastifyPluginAsync } from 'fastify'

import type { APIOptions } from '@/core/http-server/http-server'
import { LogHelper } from '@/helpers/log-helper'
import { LIVE_WIDGET_REGISTRY } from '@/live-widget-registry'

export const getLiveWidgets: FastifyPluginAsync<APIOptions> = async (
  fastify,
  options
) => {
  fastify.route({
    method: 'GET',
    url: `/api/${options.apiVersion}/live-widgets`,
    handler: async (_request, reply) => {
      try {
        const widgets = LIVE_WIDGET_REGISTRY.loadAll()

        LogHelper.title('GET /live-widgets')
        LogHelper.success('Live widgets fetched.')

        return reply.send({
          success: true,
          status: 200,
          code: 'live_widgets_fetched',
          message: 'Live widgets fetched.',
          widgets
        })
      } catch (error) {
        LogHelper.title('GET /live-widgets')
        LogHelper.error(`Failed to fetch live widgets: ${error}`)

        reply.statusCode = 500
        return reply.send({
          success: false,
          status: reply.statusCode,
          code: 'live_widgets_error',
          message: 'Failed to fetch live widgets.',
          widgets: []
        })
      }
    }
  })
}
