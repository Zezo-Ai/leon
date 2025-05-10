import { Ollama as OllamaServer } from 'ollama'

import { LogHelper } from '@/helpers/log-helper'
import { SkillDomainHelper } from '@/helpers/skill-domain-helper'
import { NLPUtterance } from '@/core/nlp/types'

/**
 * OLLAMA_SERVER
 * Model list: qwen3:4b (x2); lexi; qwen3:1.7b
 * Ollama servers: main; action-router
 */

// ollama create "qwen3:4b-skillrouter" -f ./qwen3-4b
// const MODEL_IDENTIFIER = 'qwen3:4b-q4_k_m'
const SKILL_ROUTER_MODEL_IDENTIFIER = 'qwen3:4b-leon'
// ollama create "qwen3:4b-actionrouter" -f ./qwen3-4b
const ACTION_ROUTER_MODEL_IDENTIFIER = 'qwen3:4b-leon'

const OLLAMA_CLIENT_1 = new OllamaServer({
  host: 'http://127.0.0.1:11435'
})
const OLLAMA_CLIENT_2 = new OllamaServer({
  host: 'http://127.0.0.1:11436'
})

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

    console.time('skill router')
    const completionResult = await OLLAMA_CLIENT_1.generate({
      model: SKILL_ROUTER_MODEL_IDENTIFIER,
      system: systemPrompt,
      prompt,
      /*messages: [
        { 'role': 'system', 'content': systemPrompt },
        { 'role': 'user', 'content': prompt }
      ],*/
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
    console.timeEnd('skill router')

    console.log('response', JSON.stringify(completionResult, null, 2))
  }

  /**
   * TODO: function calling
   * @see https://ollama.com/blog/functions-as-tools
   * @see https://ollama.com/blog/tool-support
   * @see https://qwen.readthedocs.io/en/latest/framework/function_call.html
   * @see https://platform.openai.com/docs/guides/function-calling?api-mode=responses&lang=javascript
   */

  public async callFunction(utterance: NLPUtterance): Promise<void> {
    /*const systemPrompt = `SYSTEM: You are a function caller. Your task is to call the function with the provided name and arguments.`
    const prompt = `Function Name: ${functionName}\nFunction Arguments: ${JSON.stringify(
      functionArgs,
      null,
      2
    )}`
    */

    // TODO: this needs to be another model to enable KV cache

    // TODO: skill devs can injects notes at the skill level
    const notes = ["E.g. shopping list, 'shopping' is the list name."]
    const userPrompt = `/no_think\nNotes: ${notes.join(
      '; '
    )}\nUser Prompt: "${utterance}"`

    console.log('User Prompt:', userPrompt)

    console.time('action router')
    const completionResult = await OLLAMA_CLIENT_2.chat({
      model: ACTION_ROUTER_MODEL_IDENTIFIER,
      messages: [{ role: 'user', content: userPrompt }],
      // Always keep the model loaded in memory
      keep_alive: -1,
      stream: false,
      options: {
        // num_ctx: 8_192,
        /**
         * An action may have ~128 tokens,
         * a skill may contain 10 actions,
         * we double that
         */
        num_ctx: 2_048,
        temperature: 0,
        // Max tokens
        // num_predict: 12
        num_predict: 512
      },
      tools: [
        {
          type: 'function',
          function: {
            name: 'create_list',
            description:
              'Create a new to-do list based on the given list name.',
            parameters: {
              properties: {
                list_name: {
                  type: 'string',
                  description: 'The name of the to-do list to create.'
                }
              },
              required: ['list_name']
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'add_todos',
            description: 'Add items to a specific to-do list.',
            parameters: {
              properties: {
                list_name: {
                  type: 'string',
                  description: 'The name of the to-do list to add items to.'
                },
                items: {
                  type: 'array',
                  items: {
                    type: 'string'
                  },
                  description: 'The items to add to the list.'
                }
              },
              required: ['list_name', 'items']
            }
          }
        }
      ]
    })
    console.timeEnd('action router')

    const answer = completionResult.message

    if (answer.tool_calls) {
      console.log('Tool found')
      console.log(answer.content)
      console.log('Tool name:', JSON.stringify(answer.tool_calls[0], null, 2))
    } else {
      console.log('No tool found:', answer.content)
    }
  }
}
