import dotenv from 'dotenv'

import { createSetupStatus } from '../setup/setup-status'

import trainSkillRouterDuty from './train-skill-router-duty.js'

dotenv.config()

/**
 * Training utterance samples script
 *
 * npm run train [en or fr]
 */
export default (options = {}) =>
  new Promise(async (resolve, reject) => {
    const { quiet = false } = options
    const status = quiet
      ? null
      : createSetupStatus('Training the skill router...').start()

    try {
      try {
        await trainSkillRouterDuty()

        if (status) {
          status.succeed('Skill router: ready')
        }

        resolve()
      } catch {
        if (status) {
          status.fail('Failed to train the skill router')
        }

        reject()
      }
    } catch (e) {
      if (status) {
        status.fail('Failed to train the skill router')
      }

      reject(e)
    }
  })
