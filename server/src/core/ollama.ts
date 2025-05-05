import ollama from 'ollama'

import { LogHelper } from '@/helpers/log-helper'
import { SkillDomainHelper } from '@/helpers/skill-domain-helper'
import { NLPUtterance } from '@/core/nlp/types'

const MODEL_IDENTIFIER = 'qwen3:4b'

export default class Ollama {
  private static instance: Ollama

  constructor() {
    if (!Ollama.instance) {
      LogHelper.title('Ollama')
      LogHelper.success('New instance')

      Ollama.instance = this
    }
  }

  public async chooseSkill(utterance: NLPUtterance): Promise<void> {
    /**
     * TODO: the skill list should be saved at build time
     */
    const friendlyPrompts = await SkillDomainHelper.listSkillFriendlyPrompts()
    const formattedFriendlyPrompts = friendlyPrompts
      .map((friendlyPrompt, index) => {
        return `${index + 1}. ${friendlyPrompt}`
      })
      .join('\n')
    const systemPrompt = `SYSTEM: Analyze the User Query and the list of Available Skills below. Your task is to determine which single skill is the most appropriate for fulfilling the user's request.

Available Skills:
${formattedFriendlyPrompts}

--- Examples ---

User Query: "Translate 'Hello, how are you?' to Spanish."
Chosen Skill Name: translate_text_skill

User Query: "Generate a logo for my startup 'Blue Widgets'"
Chosen Skill Name: image_generation_skill

User Query: "Add 'Dentist Appointment' to my calendar for Tuesday at 3 PM."
Chosen Skill Name: create_calendar_event_skill

--- End Examples ---

Instructions:
- /no_think
- Carefully consider the User Query and the description of each skill.
- Select the single best skill from the list provided.
- Respond ONLY with the exact skill name (e.g., WeatherSkill, VideoTranslationSkill).
- If NONE of the provided skills are a good match for the User Query, respond ONLY with the exact word "None".
- Do not add any explanation or introductory text to your response.`
    const prompt = `User Query: "${utterance}"\nChosen Skill Name: `

    console.log('System Prompt:', systemPrompt)
    console.log('Prompt:', prompt)

    const completionResult = await ollama.generate({
      model: MODEL_IDENTIFIER,
      system: systemPrompt,
      prompt,
      // Always keep the model loaded in memory
      keep_alive: -1,
      stream: false,
      options: {
        // num_ctx: 8_192,
        // TODO: dynamic allocation according to total number of tokens for the classification duty
        num_ctx: 1_024,
        temperature: 0,
        // Max tokens
        num_predict: 12
      }
    })

    console.log('response', completionResult.response)
  }

  /**
   * TODO: function calling
   * @see https://ollama.com/blog/tool-support
   * @see https://qwen.readthedocs.io/en/latest/framework/function_call.html
   * @see https://platform.openai.com/docs/guides/function-calling?api-mode=responses&lang=javascript
   */
}
