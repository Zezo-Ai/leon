import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { type FastifyPluginAsync } from 'fastify'

import { LogHelper } from '@/helpers/log-helper'
import { SystemHelper } from '@/helpers/system-helper'

function expandHomeAlias(inputPath: string): string {
  if (inputPath === '~') {
    return os.homedir()
  }

  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(os.homedir(), inputPath.slice(2))
  }

  return inputPath
}

function openResolvedPath(
  resolvedPath: string,
  callback: (error: Error | null) => void
): void {
  if (SystemHelper.isWindows()) {
    execFile('cmd.exe', ['/c', 'start', '', resolvedPath], (error) => {
      callback(error)
    })
    return
  }

  if (SystemHelper.isMacOS()) {
    execFile('open', [resolvedPath], (error) => {
      callback(error)
    })
    return
  }

  if (SystemHelper.isLinux()) {
    execFile('xdg-open', [resolvedPath], (error) => {
      callback(error)
    })
    return
  }

  callback(new Error('Unsupported operating system'))
}

const openPath: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Body: {
      path: string
    }
  }>(
    '/api/v1/open-path',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            path: { type: 'string' }
          },
          required: ['path']
        }
      }
    },
    async (request, reply) => {
      try {
        const { path: filePath } = request.body

        if (!filePath || typeof filePath !== 'string') {
          return reply.code(400).send({
            success: false,
            error: 'Invalid path provided'
          })
        }

        const expandedPath = expandHomeAlias(filePath)
        const resolvedPath = path.resolve(expandedPath)

        if (!fs.existsSync(resolvedPath)) {
          return reply.code(404).send({
            success: false,
            error: 'Path does not exist'
          })
        }

        const targetStats = fs.statSync(resolvedPath)

        if (!targetStats.isDirectory() && !targetStats.isFile()) {
          return reply.code(400).send({
            success: false,
            error: 'Unsupported path type'
          })
        }

        openResolvedPath(resolvedPath, (error) => {
          if (error) {
            LogHelper.error(`Failed to open path: ${error.message}`)
            reply.code(500).send({
              success: false,
              error: 'Failed to open path'
            })
            return
          }

          reply.send({
            success: true,
            message: 'Path opened successfully'
          })
        })
      } catch (error) {
        LogHelper.error(
          `Error in open-path endpoint: ${(error as Error).message}`
        )
        reply.code(500).send({
          success: false,
          error: 'Internal server error'
        })
      }
    }
  )
}

export default openPath
