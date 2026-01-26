import type { ActionFunction } from '@sdk/types'
import { leon } from '@sdk/leon'
import { ParamsHelper } from '@sdk/params-helper'
import { Settings } from '@sdk/settings'
import GrokTool from '@sdk/tools/grok-tool'
import OpenRouterTool from '@sdk/tools/openrouter-tool'
import ChatterboxONNXTool from '@sdk/tools/chatterbox_onnx-tool'
import FfmpegTool from '@sdk/tools/ffmpeg-tool'
import FfprobeTool from '@sdk/tools/ffprobe-tool'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'

interface PodcastSettings extends Record<string, unknown> {
  research_grok_api_key?: string
  script_openrouter_api_key?: string
  script_model?: string
  host_voice?: string
  guest_voice?: string
}

interface PodcastSegment {
  speaker: 'host' | 'guest'
  text: string
}

interface PodcastScript {
  title: string
  segments: PodcastSegment[]
}

/**
 * Split text at punctuation boundaries to ensure no segment exceeds max characters
 * @param text The text to split
 * @param maxChars Maximum characters per segment (default: 272)
 * @returns Array of text chunks split at punctuation
 */
function splitAtPunctuation(text: string, maxChars: number = 272): string[] {
  if (text.length <= maxChars) {
    return [text]
  }

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > maxChars) {
    // Find the last punctuation mark before maxChars
    const segment = remaining.substring(0, maxChars)

    // Look for punctuation marks in reverse order
    const punctuationRegex = /[.!?;:,]\s/g
    let lastPunctuationIndex = -1
    let match: RegExpExecArray | null

    while ((match = punctuationRegex.exec(segment)) !== null) {
      lastPunctuationIndex = match.index + 1 // Include the punctuation
    }

    if (lastPunctuationIndex > 0) {
      // Split at the punctuation
      chunks.push(remaining.substring(0, lastPunctuationIndex).trim())
      remaining = remaining.substring(lastPunctuationIndex).trim()
    } else {
      // No punctuation found, force split at last space
      const lastSpaceIndex = segment.lastIndexOf(' ')
      if (lastSpaceIndex > 0) {
        chunks.push(remaining.substring(0, lastSpaceIndex).trim())
        remaining = remaining.substring(lastSpaceIndex).trim()
      } else {
        // No space either, force split at maxChars
        chunks.push(remaining.substring(0, maxChars).trim())
        remaining = remaining.substring(maxChars).trim()
      }
    }
  }

  if (remaining.length > 0) {
    chunks.push(remaining.trim())
  }

  return chunks
}

export const run: ActionFunction = async function (
  _params,
  paramsHelper: ParamsHelper
) {
  const topic = paramsHelper.getActionArgument('topic') as string
  const durationParam = paramsHelper.getActionArgument('duration')
  const duration =
    typeof durationParam === 'number'
      ? durationParam
      : typeof durationParam === 'string'
        ? parseInt(durationParam, 10)
        : 5

  // Validate duration
  if (duration < 1 || duration > 30) {
    leon.answer({
      key: 'invalid_duration',
      data: { duration }
    })
    return
  }

  // Load settings
  const settings = new Settings<PodcastSettings>()
  const grokApiKey = (await settings.get('research_grok_api_key')) as
    | string
    | undefined
  const openrouterApiKey = (await settings.get('script_openrouter_api_key')) as
    | string
    | undefined
  const scriptModel =
    ((await settings.get('script_model')) as string) || 'gemini-2.5-flash'
  const hostVoice =
    ((await settings.get('host_voice')) as string) || 'default_female'
  const guestVoice =
    ((await settings.get('guest_voice')) as string) || 'default_male'

  if (!grokApiKey || !openrouterApiKey) {
    leon.answer({ key: 'missing_api_key' })
    return
  }

  try {
    // Step 1: Research the topic using Grok
    leon.answer({
      key: 'researching',
      data: { topic }
    })

    const grok = new GrokTool()
    grok.setApiKey(grokApiKey)

    const researchResult = await grok.deepResearch(topic, [
      'Recent developments and trends',
      'Key facts and statistics',
      'Expert opinions',
      'Interesting angles and perspectives'
    ])

    if (!researchResult.success || !researchResult.data) {
      leon.answer({
        key: 'error',
        data: { error: researchResult.error || 'Research failed' }
      })
      return
    }

    // Responses API uses "output" array with the final text in content helper
    const researchContent = researchResult.content

    if (!researchContent) {
      leon.answer({
        key: 'error',
        data: { error: 'No research content found' }
      })
      return
    }

    // Step 2: Generate podcast script using OpenRouter with structured output
    leon.answer({ key: 'generating_script' })

    const openrouter = new OpenRouterTool()
    openrouter.setApiKey(openrouterApiKey)

    // Calculate approximate word count (150 words per minute of speech)
    const targetWordCount = duration * 150

    const scriptPrompt = `You are a podcast script writer. Based on the following research, create an engaging podcast conversation between a host and a guest expert.

RESEARCH CONTENT:
${researchContent}

REQUIREMENTS:
- Duration: approximately ${duration} minutes (${targetWordCount} words total)
- Create natural, conversational dialogue
- Host should ask insightful questions
- Guest should provide informative, engaging answers
- Include transitions, reactions, and natural speech patterns
- Make it educational but entertaining
- Alternate between host and guest naturally

Generate the script as a JSON object with this structure:
{
  "title": "Episode title",
  "segments": [
    {"speaker": "host", "text": "Welcome to..."},
    {"speaker": "guest", "text": "Thanks for having me..."},
    ...
  ]
}`

    const scriptSchema = {
      name: 'podcast_script',
      schema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'The episode title'
          },
          segments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                speaker: {
                  type: 'string',
                  enum: ['host', 'guest'],
                  description: 'The speaker (host or guest)'
                },
                text: {
                  type: 'string',
                  description: 'What the speaker says'
                }
              },
              required: ['speaker', 'text'],
              additionalProperties: false
            }
          }
        },
        required: ['title', 'segments'],
        additionalProperties: false
      }
    }

    const scriptResult = await openrouter.structuredCompletion({
      prompt: scriptPrompt,
      json_schema: scriptSchema,
      model: scriptModel,
      temperature: 0.8,
      max_tokens: targetWordCount * 2 // Allow enough tokens
    })

    if (!scriptResult.success || !scriptResult.data) {
      leon.answer({
        key: 'error',
        data: { error: scriptResult.error || 'Script generation failed' }
      })
      return
    }

    const script = scriptResult.data as PodcastScript

    // Step 3: Synthesize audio using ChatterboxONNX (batch processing!)
    leon.answer({ key: 'synthesizing_audio' })

    const chatterbox = new ChatterboxONNXTool()

    // Create output directory
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'podcast_'))
    const finalAudioPath = path.join(
      outputDir,
      `${topic.replace(/[^a-z0-9]/gi, '_')}_podcast.wav`
    )

    // Prepare batch synthesis tasks, splitting long segments at punctuation
    const synthesisTasks: Array<{
      text: string
      audio_path: string
      voice_name: string
      temperature: number
    }> = []

    let taskIndex = 0
    for (const segment of script.segments) {
      // Split long segments at punctuation (max 272 chars)
      const textChunks = splitAtPunctuation(segment.text, 272)

      for (const chunk of textChunks) {
        synthesisTasks.push({
          text: chunk,
          audio_path: path.join(
            outputDir,
            `segment_${taskIndex.toString().padStart(4, '0')}.wav`
          ),
          voice_name: segment.speaker === 'host' ? hostVoice : guestVoice,
          temperature: 0.7
        })
        taskIndex++
      }
    }

    // Batch synthesize all segments at once (EFFICIENT!)
    await chatterbox.synthesizeSpeechToFiles(synthesisTasks)

    // Step 4: Merge all audio segments into final podcast
    const ffmpeg = new FfmpegTool()
    const ffprobe = new FfprobeTool()

    // Get all segment paths in order
    const segmentPaths = synthesisTasks.map((task) => task.audio_path)

    // Calculate total duration by measuring each segment
    let totalDurationMs = 0
    const segmentsWithTiming: Array<{ path: string; startMs: number }> = []

    for (const segmentPath of segmentPaths) {
      const duration = await ffprobe.getDuration(segmentPath)
      segmentsWithTiming.push({
        path: segmentPath,
        startMs: totalDurationMs
      })
      totalDurationMs += duration + 500 // Add 500ms gap between speakers
    }

    // Merge segments with precise timing
    await ffmpeg.assembleAudioSegments(
      segmentsWithTiming,
      finalAudioPath,
      totalDurationMs
    )

    // Clean up individual segments
    for (const segmentPath of segmentPaths) {
      await fs.unlink(segmentPath).catch(() => {}) // Ignore errors
    }

    // Step 5: Return success
    leon.answer({
      key: 'success',
      data: {
        topic,
        duration,
        audio_file: finalAudioPath
      }
    })
  } catch (error: unknown) {
    leon.answer({
      key: 'error',
      data: { error: (error as Error).message }
    })
  }
}
