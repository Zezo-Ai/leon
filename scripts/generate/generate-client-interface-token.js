import crypto from 'node:crypto'

import dotenv from 'dotenv'

import { LogHelper } from '@/helpers/log-helper'
import { StringHelper } from '@/helpers/string-helper'
import { ProfileHelper } from '@/helpers/profile-helper'
import { PROFILE_DOT_ENV_PATH } from '@/constants'

dotenv.config({ path: PROFILE_DOT_ENV_PATH })

/**
 * Generate Leon client interface token script
 * save it in the .env file
 */
const generateClientInterfaceToken = () =>
  new Promise(async (resolve, reject) => {
    LogHelper.info('Generating my client interface token...')

    try {
      const shasum = crypto.createHash('sha1')
      const str = StringHelper.random(11)
      const envVarKey = 'LEON_CLIENT_INTERFACE_TOKEN'

      shasum.update(str)
      const sha1 = shasum.digest('hex')

      await ProfileHelper.updateDotEnvVariable(envVarKey, sha1)
      LogHelper.success('Client interface token generated')

      resolve()
    } catch (e) {
      LogHelper.error(e.message)
      reject(e)
    }
  })

export default () =>
  new Promise(async (resolve, reject) => {
    try {
      if (
        !process.env.LEON_CLIENT_INTERFACE_TOKEN ||
        process.env.LEON_CLIENT_INTERFACE_TOKEN === ''
      ) {
        await generateClientInterfaceToken()
      }

      resolve()
    } catch (e) {
      reject(e)
    }
  })
