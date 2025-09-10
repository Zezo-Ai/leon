import fs from 'node:fs'
import path from 'node:path'

import type { ActionFunction, ActionParams } from '@sdk/types'
import { leon } from '@sdk/leon'
import { ParamsHelper } from '@sdk/params-helper'
import FasterWhisperTool from '@sdk/tools/faster_whisper-tool'
import { formatFilePath } from '@sdk/utils'

import { getVideoInfo, updateTranscriptionInfo } from '../lib/memory'

export const run: ActionFunction = async function (
  _params: ActionParams,
  paramsHelper: ParamsHelper
) {
  let audioPath = paramsHelper.getActionArgument('audio_path') as string
  let targetLanguage = paramsHelper.getActionArgument(
    'target_language'
  ) as string

  try {
    // If audio_path is not provided as argument, try to get it from memory
    if (!audioPath) {
      const videoInfo = await getVideoInfo()

      if (!videoInfo || !videoInfo.audioPath) {
        leon.answer({
          key: 'no_audio_info',
          data: {
            error:
              'No audio information found in memory. Please extract audio first.'
          }
        })
        return
      }

      audioPath = videoInfo.audioPath
      targetLanguage = targetLanguage || videoInfo.targetLanguage
    }

    // Initialize faster-whisper tool
    const whisperTool = new FasterWhisperTool()

    // Verify the input audio file exists
    if (!fs.existsSync(audioPath)) {
      leon.answer({
        key: 'audio_file_not_found',
        data: {
          audio_path: formatFilePath(audioPath)
        }
      })
      return
    }

    // Get audio file info
    const audioStats = await fs.promises.stat(audioPath)
    const audioSizeMB = Math.round(audioStats.size / (1_024 * 1_024))

    leon.answer({
      key: 'transcription_started',
      data: {
        audio_path: formatFilePath(path.basename(audioPath)),
        target_language: targetLanguage,
        audio_size: `${audioSizeMB} MB`
      }
    })

    // Create output path for transcription file
    const audioDir = path.dirname(audioPath)
    const audioName = path.parse(audioPath).name
    const transcriptionPath = path.join(
      audioDir,
      `${audioName}_transcription.txt`
    )

    // Transcribe audio using faster-whisper
    const transcribedPath = await whisperTool.transcribeToFile(
      audioPath,
      transcriptionPath
    )

    // Verify the transcription file exists
    if (!fs.existsSync(transcribedPath)) {
      leon.answer({
        key: 'transcription_failed',
        data: {
          audio_path: formatFilePath(path.basename(audioPath)),
          error: 'Transcription file not found'
        }
      })
      return
    }

    // Get transcription file info
    const transcriptionStats = await fs.promises.stat(transcribedPath)
    const transcriptionSizeKB = Math.round(transcriptionStats.size / 1_024)

    // Update memory with transcription information
    await updateTranscriptionInfo(transcribedPath)

    leon.answer({
      key: 'transcription_completed',
      data: {
        audio_path: path.basename(audioPath),
        transcription_path: formatFilePath(transcribedPath),
        folder_path: formatFilePath(path.dirname(transcribedPath)),
        transcription_size: `${transcriptionSizeKB} KB`,
        target_language: targetLanguage
      }
    })
  } catch (error) {
    leon.answer({
      key: 'transcription_error',
      data: {
        audio_path: path.basename(audioPath),
        error: (error as Error).message
      }
    })
  }
}
