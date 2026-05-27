import { LogHelper } from '@/helpers/log-helper'

import generateClientInterfaceToken from './generate-client-interface-token'

/**
 * Execute the generating Leon client interface token script
 */
;(async () => {
  try {
    await generateClientInterfaceToken()
  } catch (e) {
    LogHelper.error(`Failed to generate the Leon client interface token: ${e}`)
  }
})()
