import path from 'node:path'

import type { ActionFunction, ActionParams } from '@sdk/types'
import { leon } from '@sdk/leon'
import { ParamsHelper } from '@sdk/params-helper'
import { Settings } from '@sdk/settings'
import OpenCodeTool from '@sdk/tools/opencode-tool'

import { SKILL_PLAN_SYSTEM_PROMPT } from '../lib/skill-plan-llm'

interface SkillWriterSettings extends Record<string, unknown> {
  opencode_provider?: string
  opencode_cerebras_api_key?: string
  opencode_cerebras_model?: string
  opencode_minimax_api_key?: string
  opencode_minimax_model?: string
  opencode_anthropic_api_key?: string
  opencode_anthropic_model?: string
  opencode_openai_api_key?: string
  opencode_openai_model?: string
  opencode_gemini_api_key?: string
  opencode_gemini_model?: string
}

const normalizeSkillFolderName = (value: string): string => {
  const sanitized = value
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\w]/g, '_')

  return sanitized.endsWith('_skill') ? sanitized : `${sanitized}_skill`
}

export const run: ActionFunction = async function (
  _params: ActionParams,
  paramsHelper: ParamsHelper
) {
  const description = paramsHelper.getActionArgument('description') as
    | string
    | undefined

  if (!description) {
    leon.answer({ key: 'missing_description' })
    return
  }

  const settings = new Settings<SkillWriterSettings>()
  const provider = ((await settings.get('opencode_provider')) ||
    'cerebras') as string

  // Get provider-specific settings
  const apiKey = (await settings.get(`opencode_${provider}_api_key`)) as
    | string
    | undefined
  const model = (await settings.get(`opencode_${provider}_model`)) as
    | string
    | undefined

  if (!apiKey) {
    leon.answer({
      key: 'missing_api_key',
      data: { provider }
    })
    return
  }

  leon.answer({ key: 'generating_skill' })

  // Extract skill name from description (simple heuristic)
  const skillName = normalizeSkillFolderName(
    description.split(' ').slice(0, 3).join(' ')
  )
  const targetPath = path.join(process.cwd(), 'skills', skillName)

  // Context files for OpenCode to learn from
  const contextFiles = [
    'skills/guess_the_number_skill/skill.json',
    'skills/guess_the_number_skill/src/actions/set_up.py',
    'schemas/skill-schemas/skill.json'
  ]

  // Enhanced description with tool guidance
  const enhancedDescription = `${description}

IMPORTANT GUIDANCE:
- First check if any existing Leon tools can help with this functionality
- For video/audio tasks: Use ytdlp-tool, ffmpeg-tool, or other video_streaming tools
- For web requests: Use appropriate HTTP/API tools
- For file operations: Use file system tools
- For audio processing: Use music_audio toolkit tools
- NEVER create new tool functionality that already exists
- Only implement the skill-specific business logic in actions`

  const opencodeTool = new OpenCodeTool()

  const skillOptions: Parameters<typeof opencodeTool.generateSkill>[0] = {
    description: enhancedDescription,
    provider,
    target_path: targetPath,
    context_files: contextFiles,
    system_prompt: SKILL_PLAN_SYSTEM_PROMPT
  }

  if (model) {
    skillOptions.model = model
  }

  if (apiKey) {
    skillOptions.api_key = apiKey
  }

  const response = await opencodeTool.generateSkill(skillOptions)

  if (!response.success) {
    leon.answer({
      key: 'generation_failed',
      data: { error: response.error || 'Unknown error' }
    })
    return
  }

  // Extract created files info
  const filesCreated = response.files_created || []
  const filesList = filesCreated.slice(0, 5).join(', ')
  const moreFiles =
    filesCreated.length > 5 ? ` and ${filesCreated.length - 5} more` : ''

  leon.answer({
    key: 'skill_created',
    data: {
      skill_name: skillName,
      files_created: `${filesList}${moreFiles}`,
      provider: response.provider_used || provider,
      model: response.model_used || model || 'default'
    }
  })
}
