import type { FastifyPluginAsync, FastifySchema } from 'fastify'

import type { APIOptions } from '@/core/http-server/http-server'

const postCommandSchema = {
} satisfies FastifySchema

export const postCommand: FastifyPluginAsync<APIOptions> = async (
  fastify,
  options
) => {
  fastify.route({
    method: 'GET',
    url: `/api/${options.apiVersion}/command`,
    schema: postCommandSchema,
    handler: async (_, reply) => {
      return reply.send({ })
    }
  })
}
