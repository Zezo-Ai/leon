import dotenv from 'dotenv'

import { LogHelper } from '@/helpers/log-helper'

import trainSkillRouterDuty from './train-skill-router-duty.js'

dotenv.config()

/**
 * Training utterance samples script
 *
 * npm run train [en or fr]
 */
export default () =>
  new Promise(async (resolve, reject) => {
    try {
      try {
        await trainSkillRouterDuty()

        LogHelper.success('Skill router duty trained')
        resolve()
      } catch (e) {
        LogHelper.error(`Failed to train skill router duty: ${e}`)
        reject()
      }
    } catch (e) {
      LogHelper.error(e.message)
      reject(e)
    }
  })
