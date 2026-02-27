import path from 'node:path'

import {
  CONTEXT_PATH,
  GLOBAL_DATA_PATH,
  LOGS_PATH,
  MODELS_PATH,
  SERVER_CORE_PATH,
  SKILLS_PATH,
  TMP_PATH,
  TOOLKITS_PATH
} from '@/constants'
import { ContextFile } from '@/core/context-manager/context-file'

export class HomeContextFile extends ContextFile {
  public readonly filename = 'HOME.md'
  public readonly ttlMs = null

  public generate(): string {
    const projectRoot = process.cwd()
    const serverSourcePath = path.join(projectRoot, 'server', 'src')

    return [
      `> Leon workspace rooted at ${projectRoot}. Key folders for skills, toolkits, models, logs and runtime temp are available.`,
      '# HOME',
      `- Project root: ${projectRoot}`,
      `- Skills path: ${SKILLS_PATH}`,
      `- Toolkits path: ${TOOLKITS_PATH}`,
      `- Global data path: ${GLOBAL_DATA_PATH}`,
      `- Models path: ${MODELS_PATH}`,
      `- Context path: ${CONTEXT_PATH}`,
      `- Server source path: ${serverSourcePath}`,
      `- Server core runtime path: ${SERVER_CORE_PATH}`,
      `- Logs path: ${LOGS_PATH}`,
      `- Temp path: ${TMP_PATH}`
    ].join('\n')
  }
}
