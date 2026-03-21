import path from 'node:path'

import { FileHelper } from '@/helpers/file-helper'

import type { ActionFunction, ActionParams } from '@sdk/types'
import { INTENT_OBJECT } from '@bridge/constants'
import { ParamsHelper } from '@sdk/params-helper'
import { leon } from '@sdk/leon'
import { setToolReporter } from '@sdk/tool-reporter'

/**
 * Skill bridge runtimes are one-shot processes. Some actions can leave handles
 * alive briefly (file I/O, caches, toolkit internals), so we flush stdio and
 * exit explicitly once the action is done to avoid blocking the core workflow.
 */
const exitBridge = (code: number): void => {
  const writableStreams = [process.stdout, process.stderr].filter(
    (stream) => !stream.destroyed
  )

  if (writableStreams.length === 0) {
    process.exit(code)
  }

  let pendingStreams = writableStreams.length
  const onFlushed = (): void => {
    pendingStreams -= 1

    if (pendingStreams === 0) {
      process.exit(code)
    }
  }

  for (const stream of writableStreams) {
    stream.write('', onFlushed)
  }
}
;(async (): Promise<void> => {
  setToolReporter(async (input) => {
    await leon.answer(input)
  })

  const {
    lang,
    sentiment,
    context_name,
    skill_name,
    action_name,
    skill_config_path,
    extra_context
  } = INTENT_OBJECT

  const params: ActionParams = {
    lang,
    utterance: INTENT_OBJECT.utterance as ActionParams['utterance'],
    action_arguments:
      INTENT_OBJECT.action_arguments as ActionParams['action_arguments'],
    entities: INTENT_OBJECT.entities as ActionParams['entities'],
    sentiment,
    context_name,
    skill_name,
    action_name,
    context: INTENT_OBJECT.context as ActionParams['context'],
    skill_config: INTENT_OBJECT.skill_config as ActionParams['skill_config'],
    skill_config_path,
    extra_context
  }

  try {
    const actionModule = await FileHelper.dynamicImportFromFile(
      path.join(
        process.cwd(),
        'skills',
        skill_name,
        'src',
        'actions',
        `${action_name}.ts`
      )
    )
    const actionFunction: ActionFunction = actionModule.run
    const paramsHelper = new ParamsHelper(params)

    await actionFunction(params, paramsHelper)
    // Explicitly terminate the bridge after the action has emitted its output.
    exitBridge(0)
  } catch (e) {
    console.error(
      `Error while running "${skill_name}" skill "${action_name}" action:`,
      e
    )
    // Keep stderr visible to the core, then exit with failure for skill errors.
    exitBridge(1)
  }
})()
