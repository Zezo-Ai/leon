import type {
  AnswerData,
  AnswerInput,
  AnswerOutput,
  AnswerConfig
} from '@sdk/types'
import { INTENT_OBJECT, SKILL_LOCALE_CONFIG } from '@bridge/constants'
import { WidgetWrapper } from '@sdk/aurora'
import { SUPPORTED_WIDGET_EVENTS } from '@sdk/widget-component'

class Leon {
  private static instance: Leon

  constructor() {
    if (!Leon.instance) {
      Leon.instance = this
    }
  }

  /**
   * Injects variables into the answer string
   * @param answer The answer to inject variables into
   * @param data The data to apply
   * @example injectVariables('Hello {{ name }}', { name: 'Leon' }) // 'Hello Leon'
   */
  private injectVariables(
    answer: AnswerConfig,
    data: AnswerData | null
  ): AnswerConfig {
    let finalAnswer = answer

    const applyData = (obj: AnswerData): void => {
      for (const key in obj) {
        if (typeof finalAnswer === 'string') {
          finalAnswer = finalAnswer.replaceAll(`{{ ${key} }}`, String(obj[key]))
        } else {
          if (finalAnswer.text) {
            finalAnswer.text = finalAnswer.text.replaceAll(
              `{{ ${key} }}`,
              String(obj[key])
            )
          }
          if (finalAnswer.speech) {
            finalAnswer.speech = finalAnswer.speech.replaceAll(
              `{{ ${key} }}`,
              String(obj[key])
            )
          }
        }
      }
    }

    if (data) {
      applyData(data)
    }

    if (SKILL_LOCALE_CONFIG.variables) {
      applyData(SKILL_LOCALE_CONFIG.variables)
    }

    return finalAnswer
  }

  /**
   * Apply data to the answer
   * @param answerKey The answer key
   * @param data The data to apply
   * @example setAnswerData('key', { name: 'Leon' })
   */
  public setAnswerData(
    answerKey: string,
    data: AnswerData = null
  ): AnswerConfig {
    try {
      const answers =
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-expect-error
        SKILL_LOCALE_CONFIG.answers?.[answerKey] ??
        SKILL_LOCALE_CONFIG.common_answers?.[answerKey]

      if (!answers) {
        return answerKey
      }

      const answer = Array.isArray(answers)
        ? answers[Math.floor(Math.random() * answers.length)] ?? ''
        : answers

      return this.injectVariables(answer, data)
    } catch (e) {
      console.error(
        `Error while setting answer data. Please verify that the answer key "${answerKey}" exists in the locale configuration. Details:`,
        e
      )

      throw e
    }
  }

  /**
   * Send an answer to the core
   * @param answerInput The answer input
   * @example answer({ key: 'greet' }) // 'Hello world'
   * @example answer({ key: 'welcome', data: { name: 'Louis' } }) // 'Welcome Louis'
   * @example answer({ key: 'confirm', core: { restart: true } }) // 'Would you like to retry?'
   */
  public async answer(answerInput: AnswerInput): Promise<void> {
    try {
      const answerObject: AnswerOutput = {
        ...INTENT_OBJECT,
        output: {
          codes:
            answerInput.widget && !answerInput.key
              ? 'widget'
              : (answerInput.key as string),
          answer:
            answerInput.key != null
              ? this.setAnswerData(answerInput.key, answerInput.data)
              : '',
          core: answerInput.core
        }
      }

      if (answerInput.widget) {
        answerObject.output.widget = {
          actionName: `${INTENT_OBJECT.skill_name}:${INTENT_OBJECT.action_name}`,
          widget: answerInput.widget.widget,
          id: answerInput.widget.id,
          onFetch: answerInput.widget.onFetch ?? null,
          componentTree: new WidgetWrapper({
            ...answerInput.widget.wrapperProps,
            children: [answerInput.widget.render()]
          }),
          supportedEvents: SUPPORTED_WIDGET_EVENTS
        }
      }

      // "Temporize" for the data buffer output on the core
      await new Promise((r) => setTimeout(r, 100))

      // Write the answer object to stdout as a JSON string with a newline for brain chunk-by-chunk parsing
      process.stdout.write(JSON.stringify(answerObject) + '\n')
    } catch (e) {
      console.error('Error while creating answer:', e)
    }
  }
}

export const leon = new Leon()
