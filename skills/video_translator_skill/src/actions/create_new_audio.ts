import fs from 'node:fs'
import path from 'node:path'

import type { ActionFunction, ActionParams } from '@sdk/types'
import type { TranscriptionOutput } from '@sdk/tools/schemas'
import { leon } from '@sdk/leon'
import { ParamsHelper } from '@sdk/params-helper'
import { Settings } from '@sdk/settings'
import ChatterboxONNXTool from '@sdk/tools/chatterbox_onnx-tool'
import FfmpegTool from '@sdk/tools/ffmpeg-tool'
import { formatFilePath } from '@sdk/utils'

interface SpeakerReference {
  speaker: string
  reference1_path: string
  reference2_path: string
}

interface Segment {
  from: number
  to: number
  text: string
  speaker: string
}

interface ProcessedSegment {
  path: string
  start: number
}

interface VideoTranslatorSkillSettings extends Record<string, unknown> {
  speech_synthesis_provider?: 'chatterbox_onnx'
  translation_openrouter_api_key?: string
  translation_openrouter_model?: string
  translation_max_tokens_per_request?: number
  translation_segments_per_batch?: number
}

const BREAK_CHARS = ',.!?'
const GROUP_TARGET_CHARS = 272
const LONG_PAUSE_S = 1.5
const MAX_SPEED_UP_RATIO = 1.3

/**
 * Convert seconds to milliseconds
 */
function toMs(seconds: number): number {
  return Math.round(seconds * 1_000)
}

/**
 * Create natural phrases (clauses) from segments
 */
function createPhrases(segments: Segment[]): Segment[] {
  const phrases: Segment[] = []
  let currentPhrase: Segment | null = null

  for (const segment of segments) {
    const text = segment.text.trim()
    const speakerId = segment.speaker

    if (!text || !speakerId) continue

    if (currentPhrase === null || currentPhrase.speaker !== speakerId) {
      if (currentPhrase) phrases.push(currentPhrase)
      currentPhrase = { ...segment }
    } else {
      currentPhrase.text += ' ' + text
      currentPhrase.to = segment.to
    }

    if (BREAK_CHARS.split('').some((char) => text.endsWith(char))) {
      phrases.push(currentPhrase)
      currentPhrase = null
    }
  }

  if (currentPhrase) phrases.push(currentPhrase)

  return phrases
}

/**
 * Group phrases into larger, efficient segments
 */
function groupPhrases(phrases: Segment[]): Segment[] {
  const groups: Segment[] = []
  let currentGroup: Segment | null = null

  for (const phrase of phrases) {
    if (currentGroup === null) {
      currentGroup = { ...phrase }
    } else {
      const pauseDuration = phrase.from - currentGroup.to
      const combinedLength = currentGroup.text.length + 1 + phrase.text.length // +1 for space

      // Break conditions: speaker changes, adding phrase would exceed limit, or there's a long pause
      if (
        currentGroup.speaker !== phrase.speaker ||
        combinedLength > GROUP_TARGET_CHARS ||
        pauseDuration >= LONG_PAUSE_S
      ) {
        groups.push(currentGroup)
        currentGroup = { ...phrase }
      } else {
        currentGroup.text += ' ' + phrase.text
        currentGroup.to = phrase.to
      }
    }
  }

  if (currentGroup) groups.push(currentGroup)

  return groups
}

export const run: ActionFunction = async function (
  _params: ActionParams,
  paramsHelper: ParamsHelper
) {
  const translatedTranscriptionPath =
    (paramsHelper.getActionArgument(
      'translated_transcription_path'
    ) as string) ||
    paramsHelper.getContextData<string>('translated_transcription_path')
  const audioPath =
    (paramsHelper.getActionArgument('audio_path') as string) ||
    paramsHelper.getContextData<string>('audio_path')
  const speakerReferences =
    (paramsHelper.getActionArgument('speaker_references') as
      | SpeakerReference[]
      | undefined) ||
    paramsHelper.getContextData<SpeakerReference[]>('speaker_references')

  // Extract target language from entity 'language' and format for Chatterbox ONNX
  // The entity option contains a locale like "fr-FR", we need just "fr"
  const languageEntity = paramsHelper.findLastEntityFromContext('language')
  const targetLanguageLocale =
    languageEntity && 'option' in languageEntity
      ? (languageEntity.option as string)
      : undefined
  const targetLanguage = targetLanguageLocale
    ? targetLanguageLocale.substring(0, 2).toLowerCase()
    : undefined

  try {
    // Load settings
    const settings = new Settings<VideoTranslatorSkillSettings>()
    const provider = ((await settings.get('speech_synthesis_provider')) ||
      'chatterbox_onnx') as NonNullable<
      VideoTranslatorSkillSettings['speech_synthesis_provider']
    >

    // Validate inputs
    if (
      !translatedTranscriptionPath ||
      !fs.existsSync(translatedTranscriptionPath)
    ) {
      leon.answer({
        key: 'translated_transcription_not_found'
      })
      return
    }

    if (!audioPath || !fs.existsSync(audioPath)) {
      leon.answer({
        key: 'audio_not_found'
      })
      return
    }

    if (!speakerReferences || speakerReferences.length === 0) {
      leon.answer({
        key: 'speaker_references_missing'
      })
      return
    }

    if (!targetLanguage) {
      leon.answer({
        key: 'target_language_missing',
        data: {
          note: 'Language entity not found in context. Please specify the target language in the conversation.'
        }
      })
      return
    }

    // Read and parse transcription
    const transcriptionContent = await fs.promises.readFile(
      translatedTranscriptionPath,
      'utf-8'
    )
    const transcription: TranscriptionOutput = JSON.parse(transcriptionContent)

    if (!transcription.segments || transcription.segments.length === 0) {
      leon.answer({
        key: 'no_segments_found'
      })
      return
    }

    leon.answer({
      key: 'synthesis_started',
      data: {
        segment_count: transcription.segments.length.toString(),
        speaker_count: speakerReferences.length.toString(),
        target_language: targetLanguage,
        provider
      }
    })

    // Initialize tools
    const ffmpegTool = new FfmpegTool()

    // Prepare output directory
    const audioDir = path.dirname(audioPath)
    const processedSegmentsDir = path.join(audioDir, 'processed_segments')
    await fs.promises.mkdir(processedSegmentsDir, { recursive: true })

    // Create phrases and groups
    leon.answer({
      key: 'grouping_segments'
    })

    const phrases = createPhrases(
      transcription.segments as unknown as Segment[]
    )
    const groups = groupPhrases(phrases)

    leon.answer({
      key: 'segments_grouped',
      data: {
        original_count: transcription.segments.length.toString(),
        grouped_count: groups.length.toString()
      }
    })

    // Build speaker reference map
    const speakerRefMap = new Map<string, SpeakerReference>()
    for (const ref of speakerReferences) {
      speakerRefMap.set(ref.speaker, ref)
    }

    // Prepare synthesis tasks for batch processing
    interface GroupTask {
      index: number
      group: Segment
      rawAudioPath: string
      startTimeMs: number
      endTimeMs: number
      originalDurationMs: number
    }

    const synthesisTasks: Array<{
      text: string
      target_language: string
      audio_path: string
      speaker_reference_path: string
      exaggeration: number
      cfg_strength: number
      temperature: number
    }> = []
    const validGroupTasks: GroupTask[] = []

    leon.answer({
      key: 'preparing_synthesis_tasks',
      data: {
        total_groups: groups.length.toString()
      }
    })

    for (let i = 0; i < groups.length; i += 1) {
      const group = groups[i]
      if (!group) continue

      const textToSpeak = group.text.trim()
      const speakerId = group.speaker

      if (!textToSpeak) continue

      const speakerRef = speakerRefMap.get(speakerId)
      if (!speakerRef) {
        leon.answer({
          key: 'speaker_reference_not_found',
          data: {
            speaker: speakerId
          }
        })
        continue
      }

      const rawAudioPath = path.join(
        processedSegmentsDir,
        `segment_${i}_raw.wav`
      )

      const startTimeMs = toMs(group.from)
      const endTimeMs = toMs(group.to)
      const originalDurationMs = endTimeMs - startTimeMs

      validGroupTasks.push({
        index: i,
        group,
        rawAudioPath,
        startTimeMs,
        endTimeMs,
        originalDurationMs
      })

      synthesisTasks.push({
        text: textToSpeak,
        target_language: targetLanguage,
        audio_path: rawAudioPath,
        speaker_reference_path: speakerRef.reference1_path,
        exaggeration: 0.4,
        cfg_strength: 0.1,
        temperature: 0.5
      })
    }

    // Batch synthesize all audio segments at once
    if (synthesisTasks.length > 0) {
      leon.answer({
        key: 'batch_synthesis_started',
        data: {
          task_count: synthesisTasks.length.toString(),
          provider
        }
      })

      try {
        if (provider === 'chatterbox_onnx') {
          const chatterboxTool = new ChatterboxONNXTool()
          await chatterboxTool.synthesizeSpeechToFiles(synthesisTasks)
        } else {
          throw new Error(`Unsupported speech synthesis provider: ${provider}`)
        }

        leon.answer({
          key: 'batch_synthesis_completed',
          data: {
            task_count: synthesisTasks.length.toString()
          }
        })
      } catch (error) {
        leon.answer({
          key: 'batch_synthesis_failed',
          data: {
            error: (error as Error).message
          }
        })
        throw error
      }
    }

    // Post-process each generated audio file
    const processedFiles: ProcessedSegment[] = []

    leon.answer({
      key: 'post_processing_started',
      data: {
        segment_count: validGroupTasks.length.toString()
      }
    })

    for (const task of validGroupTasks) {
      const { index, rawAudioPath, startTimeMs, originalDurationMs } = task

      // Verify the audio file was created
      if (!fs.existsSync(rawAudioPath)) {
        leon.answer({
          key: 'segment_not_generated',
          data: {
            segment_number: (index + 1).toString()
          }
        })
        continue
      }

      // Get the generated audio duration
      const generatedStats = await fs.promises.stat(rawAudioPath)
      // Rough estimation: 16-bit PCM, 22.05kHz, mono = 44.1 KB/s
      const estimatedGeneratedDurationMs =
        (generatedStats.size / 44_100) * 1_000
      const generatedDurationMs = Math.max(estimatedGeneratedDurationMs, 100) // Minimum 100ms

      const finalSegmentPath = path.join(
        processedSegmentsDir,
        `segment_${index}_final.wav`
      )

      // Synchronization logic
      if (originalDurationMs <= 0 || generatedDurationMs <= 0) {
        // Can't sync, just copy
        await fs.promises.copyFile(rawAudioPath, finalSegmentPath)
      } else {
        const durationRatio = generatedDurationMs / originalDurationMs

        if (durationRatio <= 1.0) {
          // Generated audio is shorter, pad with silence
          // For now, just copy the file (padding will be done in assembly)
          await fs.promises.copyFile(rawAudioPath, finalSegmentPath)
        } else {
          // Generated audio is longer, speed it up
          const speedFactor = Math.min(durationRatio, MAX_SPEED_UP_RATIO)

          if (speedFactor < durationRatio) {
            leon.answer({
              key: 'capping_speed',
              data: {
                segment_number: (index + 1).toString(),
                requested_speed: durationRatio.toFixed(2),
                capped_speed: speedFactor.toFixed(2)
              }
            })
          }

          try {
            await ffmpegTool.adjustTempo(
              rawAudioPath,
              finalSegmentPath,
              speedFactor
            )
          } catch (error) {
            leon.answer({
              key: 'tempo_adjustment_failed',
              data: {
                group_number: (index + 1).toString(),
                error: (error as Error).message
              }
            })
            // Fallback: use original
            await fs.promises.copyFile(rawAudioPath, finalSegmentPath)
          }
        }
      }

      processedFiles.push({
        path: finalSegmentPath,
        start: startTimeMs
      })

      // Clean up raw file
      await fs.promises.unlink(rawAudioPath).catch(() => {
        /* ignore */
      })
    }

    leon.answer({
      key: 'assembling_audio'
    })

    // Assemble final audio track with precise timing
    const originalTotalDurationMs = toMs(transcription.duration)

    // Create output path for final dubbed audio
    const audioName = path.parse(audioPath).name
    const finalAudioPath = path.join(
      audioDir,
      `${audioName}_dubbed_${targetLanguage
        .toLowerCase()
        .replace(/\s+/g, '_')}.wav`
    )

    try {
      // Use FFmpeg to assemble segments with precise timing (like pydub overlay)
      await ffmpegTool.assembleAudioSegments(
        processedFiles.map((seg) => ({
          path: seg.path,
          startMs: seg.start
        })),
        finalAudioPath,
        originalTotalDurationMs
      )

      leon.answer({
        key: 'audio_assembly_completed',
        data: {
          output_path: formatFilePath(finalAudioPath)
        }
      })
    } catch (assemblyError) {
      leon.answer({
        key: 'audio_assembly_failed',
        data: {
          error: (assemblyError as Error).message
        }
      })
      throw assemblyError
    }

    // Also create a manifest file for reference
    const manifestPath = path.join(audioDir, 'segments_manifest.json')
    await fs.promises.writeFile(
      manifestPath,
      JSON.stringify(
        {
          original_duration_ms: originalTotalDurationMs,
          target_language: targetLanguage,
          segments: processedFiles.map((seg, idx) => ({
            index: idx,
            path: seg.path,
            start_ms: seg.start
          }))
        },
        null,
        2
      ),
      'utf-8'
    )

    leon.answer({
      key: 'synthesis_completed',
      data: {
        processed_count: processedFiles.length.toString(),
        output_path: formatFilePath(finalAudioPath),
        output_folder: formatFilePath(processedSegmentsDir),
        manifest_path: formatFilePath(manifestPath),
        target_language: targetLanguage
      },
      core: {
        context_data: {
          processed_segments_dir: processedSegmentsDir,
          segments_manifest_path: manifestPath,
          dubbed_audio_path: finalAudioPath
        }
      }
    })
  } catch (error) {
    leon.answer({
      key: 'synthesis_error',
      data: {
        error: (error as Error).message
      }
    })
  }
}
