import path from 'node:path'

import { LogHelper } from '@/helpers/log-helper'
import { SkillDomainHelper } from '@/helpers/skill-domain-helper'

import setupSkillsSettings from './setup-skills-settings'
import syncSkillDependencies from './sync-skill-dependencies'

/**
 * Browse skills and set them up
 */
export default async function () {
  LogHelper.info('Setting up skills...')

  try {
    const skillNames = await SkillDomainHelper.listSkillFolders()

    for (const skillName of skillNames) {
      const currentSkill = await SkillDomainHelper.getNewSkillConfig(skillName)
      const currentSkillPath = SkillDomainHelper.getNewSkillConfigPath(skillName)

      if (!currentSkill || !currentSkillPath) {
        continue
      }

      const skillContext = {
        path: currentSkillPath ? path.dirname(currentSkillPath) : '',
        bridge: currentSkill.bridge
      }

      LogHelper.info(`Setting up "${skillName}" skill...`)

      await setupSkillsSettings(skillName, skillContext)
      await syncSkillDependencies(skillName, skillContext)

      LogHelper.success(`"${skillName}" skill set up`)
    }

    LogHelper.success('Skills are set up')
  } catch (e) {
    LogHelper.error(`Failed to set up skills: ${e}`)
  }
}
