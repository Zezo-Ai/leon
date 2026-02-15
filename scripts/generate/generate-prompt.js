/**
 * It will generate a prompt that can then
 * be passed to an agentic coding solution as OpenCode.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { LogHelper } from '@/helpers/log-helper'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

const TOOL_ALIAS_NAME = 'Qwen3-TTS'
const TOOL_TS_FILE_NAME = 'qwen3_tts-tool.ts'
const TOOL_PYTHON_FILE_NAME = 'qwen3_tts_tool.py'
const TOOL_TOOLKIT_NAME = 'music_audio'

const TEMPLATE_CONFIGS = {
  'create-tool': {
    templateFile: 'create-tool-template.md',
    replacements: {
      '{TOOL_ALIAS_NAME}': TOOL_ALIAS_NAME,
      '{TOOL_TS_FILE_NAME}': TOOL_TS_FILE_NAME,
      '{TOOL_PYTHON_FILE_NAME}': TOOL_PYTHON_FILE_NAME,
      '{TOOL_TOOLKIT_NAME}': TOOL_TOOLKIT_NAME
    }
  },
  'create-skill': {
    templateFile: 'create-skill-template.md',
    replacements: {
      // TODO
    }
  }
}

/**
 * Reads a markdown template file, replaces placeholders with actual values,
 * and saves the result to the scripts/out folder
 * @param {string} templateName
 * @returns {string} Path to the generated output file
 */
export default async (templateName) => {
  if (!templateName) {
    throw new Error(
      'Missing template name. Example: pnpm run generate:prompt create-tool'
    )
  }

  const templateConfig = TEMPLATE_CONFIGS[templateName]

  if (!templateConfig) {
    const availableTemplates = Object.keys(TEMPLATE_CONFIGS).join(', ')
    throw new Error(
      `Unknown template "${templateName}". Available templates: ${availableTemplates}`
    )
  }

  const templatePath = path.join(
    dirname,
    '..',
    'prompt-templates',
    templateConfig.templateFile
  )

  const templateContent = await fs.promises.readFile(templatePath, 'utf-8')

  let outputContent = templateContent
  for (const [placeholder, value] of Object.entries(
    templateConfig.replacements
  )) {
    outputContent = outputContent.replaceAll(placeholder, value)
  }

  const outDir = path.join(dirname, '..', 'out')
  await fs.promises.mkdir(outDir, { recursive: true })

  const templateFileName = path.basename(templatePath, '.md')
  const outputFileName = templateFileName.replace('-template', '') + '.md'
  const outputPath = path.join(outDir, outputFileName)

  await fs.promises.writeFile(outputPath, outputContent, 'utf-8')

  LogHelper.success(`Prompt generated: ${outputPath}`)
  return outputPath
}
