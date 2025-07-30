import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'

import type { NLUProcessResult } from '@/core/nlp/types'
import type {
  BrainProcessResult,
  SkillResult,
  IntentObject
} from '@/core/brain/types'
import type { AnswerOutput } from '@sdk/types'
import { SkillBridges } from '@/core/brain/types'
import {
  TMP_PATH,
  PYTHON_BRIDGE_BIN_PATH,
  NODEJS_BRIDGE_BIN_PATH
} from '@/constants'
import { BRAIN, SOCKET_SERVER } from '@/core'
import { LogHelper } from '@/helpers/log-helper'
import { DateHelper } from '@/helpers/date-helper'

export class LogicActionSkillHandler {
  public static async handle(
    nluProcessResult: NLUProcessResult,
    utteranceId: string
  ): Promise<Partial<BrainProcessResult>> {
    return new Promise(async (resolve) => {
      const intentObjectPath = path.join(TMP_PATH, `${utteranceId}.json`)
      const {
        skillConfig: { name: skillFriendlyName }
      } = nluProcessResult

      await this.executeLogicActionSkill(
        nluProcessResult,
        utteranceId,
        intentObjectPath
      )

      BRAIN.skillFriendlyName = skillFriendlyName

      // Read skill output
      BRAIN.skillProcess?.stdout.on('data', (data: Buffer) => {
        this.handleLogicActionSkillProcessOutput(data)
      })

      // Handle error
      BRAIN.skillProcess?.stderr.on('data', (data: Buffer) => {
        this.handleLogicActionSkillProcessError(data, intentObjectPath)
      })

      // Catch the end of the skill execution
      BRAIN.skillProcess?.stdout.on('end', () => {
        LogHelper.title(`${BRAIN.skillFriendlyName} skill (on end)`)
        LogHelper.info(BRAIN.skillOutput)

        let skillResult: SkillResult | undefined = undefined

        // Check if there is an output (no skill error)
        if (BRAIN.skillOutput !== '') {
          try {
            skillResult = JSON.parse(BRAIN.skillOutput)
          } catch (e) {
            LogHelper.title(`${BRAIN.skillFriendlyName} skill`)
            LogHelper.error(
              `There is an error on the final output: ${String(e)}`
            )

            BRAIN.speakSkillError()
          }
        }

        this.deleteIntentObjFile(intentObjectPath)

        // Send suggestions to the client
        // TODO: core rewrite
        /*if (
          nextAction?.suggestions &&
          skillResult?.output.core?.showNextActionSuggestions
        ) {
          SOCKET_SERVER.socket?.emit('suggest', nextAction.suggestions)
        }
        if (
          action?.suggestions &&
          skillResult?.output.core?.showSuggestions
        ) {
          SOCKET_SERVER.socket?.emit('suggest', action.suggestions)
        }*/

        resolve({
          utteranceId,
          lang: BRAIN.lang,
          ...nluProcessResult,
          core: skillResult?.output.core
          // action,
          // nextAction
        })
      })

      // Reset the child process
      BRAIN.skillProcess = undefined
    })
  }

  /**
   * Handle the skill process output
   */
  private static handleLogicActionSkillProcessOutput(
    data: Buffer
  ): Promise<Error | null> | void {
    SOCKET_SERVER.socket?.emit('is-typing', true)

    try {
      const skillAnswer = JSON.parse(data.toString()) as AnswerOutput

      if (typeof skillAnswer === 'object') {
        LogHelper.title(`${BRAIN.skillFriendlyName} skill (on data)`)
        LogHelper.info(data.toString())

        if (skillAnswer.output.widget && !BRAIN.isMuted) {
          try {
            SOCKET_SERVER.socket?.emit(
              'widget',
              JSON.stringify(skillAnswer.output.widget)
            )
          } catch (e) {
            LogHelper.title('Brain')
            LogHelper.error(
              `Failed to send widget. Widget output is not well formatted: ${e}`
            )
          } finally {
            // Stop typing when the widget is sent
            SOCKET_SERVER.socket?.emit('is-typing', false)
          }
        }

        const { answer } = skillAnswer.output
        if (!BRAIN.isMuted) {
          BRAIN.talk(answer, true)
        }
        BRAIN.skillOutput = data.toString()

        return Promise.resolve(null)
      } else {
        return Promise.reject(
          new Error(
            `The "${BRAIN.skillFriendlyName}" skill is not well configured. Check the configuration file.`
          )
        )
      }
    } catch (e) {
      LogHelper.title('Brain')
      LogHelper.debug(`process.stdout: ${String(data)}. Details: ${e}`)
    }
  }

  /**
   * Handle the skill process error
   */
  private static handleLogicActionSkillProcessError(
    data: Buffer,
    intentObjectPath: string
  ): Error {
    BRAIN.speakSkillError()

    this.deleteIntentObjFile(intentObjectPath)

    LogHelper.title(`${BRAIN.skillFriendlyName} skill`)
    LogHelper.error(data.toString())

    return new Error(data.toString())
  }

  /**
   * Execute an action logic skill in a standalone way (CLI):
   *
   * 1. Need to be at the root of the project
   * 2. Edit: server/src/intent-object.sample.json
   * 3. Run: npm run python-bridge
   */
  private static async executeLogicActionSkill(
    nluProcessResult: NLUProcessResult,
    utteranceId: string,
    intentObjectPath: string
  ): Promise<void> {
    // Ensure the process is empty (to be able to execute other processes outside of Brain)
    if (!BRAIN.skillProcess) {
      const intentObject = this.createIntentObject(
        nluProcessResult,
        utteranceId
      )

      try {
        await fs.promises.writeFile(
          intentObjectPath,
          JSON.stringify(intentObject)
        )

        const { bridge: skillBridge } = nluProcessResult.skillConfig

        if (skillBridge === SkillBridges.Python) {
          BRAIN.skillProcess = spawn(
            `${PYTHON_BRIDGE_BIN_PATH} "${intentObjectPath}"`,
            { shell: true }
          )
        } else if (skillBridge === SkillBridges.NodeJS) {
          BRAIN.skillProcess = spawn(
            `${NODEJS_BRIDGE_BIN_PATH} "${intentObjectPath}"`,
            { shell: true }
          )
        } else {
          LogHelper.error(`The skill bridge is not supported: ${skillBridge}`)
        }
      } catch (e) {
        LogHelper.error(`Failed to save intent object: ${e}`)
      }
    }
  }

  /**
   * Create the intent object that will be passed to the skill
   */
  private static createIntentObject(
    nluProcessResult: NLUProcessResult,
    utteranceId: string
  ): IntentObject {
    const date = DateHelper.getDateTime()
    const dateObject = new Date(date)

    // TODO: core rewrite remove
    /*return {
      id: utteranceId,
      lang: this._lang, // TODO: remove once the Python bridge will be updated to use extra_context_data.lang instead
      domain: nluResult.classification.domain,
      skill: nluResult.classification.skill,
      action: nluResult.classification.action,
      utterance: nluResult.utterance,
      new_utterance: nluResult.newUtterance,
      current_entities: nluResult.currentEntities,
      entities: nluResult.entities,
      current_resolvers: nluResult.currentResolvers,
      resolvers: nluResult.resolvers,
      slots,
      extra_context_data: {
        lang: this._lang,
        sentiment: nluResult.sentiment,
        date: date.slice(0, 10),
        time: date.slice(11, 19),
        timestamp: dateObject.getTime(),
        date_time: date,
        week_day: dateObject.toLocaleString('default', { weekday: 'long' })
      }
    }*/

    return {
      id: utteranceId,
      lang: BRAIN.lang, // TODO: remove once the Python bridge will be updated to use extra_context_data.lang instead
      context_name: nluProcessResult.contextName,
      skill_name: nluProcessResult.skillName,
      action_name: nluProcessResult.actionName,
      skill_config: {
        name: nluProcessResult.skillConfig.name,
        bridge: nluProcessResult.skillConfig.bridge as SkillBridges,
        version: nluProcessResult.skillConfig.version,
        flow: nluProcessResult.skillConfig.flow as string[]
      },
      skill_config_path: nluProcessResult.skillConfigPath,
      utterance: nluProcessResult.new.utterance,
      action_arguments: nluProcessResult.new.actionArguments,
      entities: nluProcessResult.new.entities,
      sentiment: nluProcessResult.new.sentiment,
      context: {
        utterances: nluProcessResult.context.utterances,
        action_arguments: nluProcessResult.context.actionArguments,
        entities: nluProcessResult.context.entities,
        sentiments: nluProcessResult.context.sentiments
      },
      extra_context: {
        lang: BRAIN.lang,
        date: date.slice(0, 10),
        time: date.slice(11, 19),
        timestamp: dateObject.getTime(),
        date_time: date,
        week_day: dateObject.toLocaleString('default', { weekday: 'long' })
      }
    }
  }

  /**
   * Delete intent object file
   */
  private static deleteIntentObjFile(intentObjectPath: string): void {
    try {
      if (fs.existsSync(intentObjectPath)) {
        fs.unlinkSync(intentObjectPath)
      }
    } catch (e) {
      LogHelper.error(`Failed to delete intent object file: ${e}`)
    }
  }
}
