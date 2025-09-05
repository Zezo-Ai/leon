import { leon } from '../../../../bridges/nodejs/src/sdk/leon'
import {
  type ActionFunction,
  ActionParams
} from '../../../../bridges/nodejs/src/sdk/types'
import { ParamsHelper } from '../../../../bridges/nodejs/src/sdk/params-helper'
import FfmpegTool from '@sdk/tools/ffmpeg-tool'
import fs from 'node:fs'
import path from 'node:path'

export const run: ActionFunction = async function (
  _params: ActionParams,
  paramsHelper: ParamsHelper
) {
  const videoPath = paramsHelper.getActionArgument('video_path') as string
  const targetLanguage = paramsHelper.getActionArgument(
    'target_language'
  ) as string
  const audioFormat =
    (paramsHelper.getActionArgument('audio_format') as string) || 'mp3'

  try {
    // Initialize ffmpeg tool
    const ffmpegTool = new FfmpegTool()

    // Verify the input video file exists
    if (!fs.existsSync(videoPath)) {
      leon.answer({
        key: 'video_file_not_found',
        data: {
          video_path: videoPath
        }
      })
      return
    }

    // Get video file info
    const videoStats = await fs.promises.stat(videoPath)
    const videoSizeMB = Math.round(videoStats.size / (1024 * 1024))

    leon.answer({
      key: 'extraction_started',
      data: {
        video_path: path.basename(videoPath),
        target_language: targetLanguage,
        audio_format: audioFormat,
        video_size: `${videoSizeMB} MB`
      }
    })

    // Create output path for audio file
    const videoDir = path.dirname(videoPath)
    const videoName = path.parse(videoPath).name
    const audioPath = path.join(videoDir, `${videoName}_audio.${audioFormat}`)

    // Extract audio using ffmpeg
    const extractedAudioPath = await ffmpegTool.extractAudio(
      videoPath,
      audioPath
    )

    // Verify the extracted audio file exists
    if (!fs.existsSync(extractedAudioPath)) {
      leon.answer({
        key: 'extraction_failed',
        data: {
          video_path: path.basename(videoPath),
          error: 'Extracted audio file not found'
        }
      })
      return
    }

    // Get audio file info
    const audioStats = await fs.promises.stat(extractedAudioPath)
    const audioSizeMB = Math.round(audioStats.size / (1024 * 1024))

    leon.answer({
      key: 'extraction_completed',
      data: {
        video_path: path.basename(videoPath),
        audio_path: extractedAudioPath,
        audio_size: `${audioSizeMB} MB`,
        target_language: targetLanguage,
        audio_format: audioFormat
      }
    })

    leon.answer({
      key: 'ready_for_translation',
      data: {
        target_language: targetLanguage,
        audio_path: path.basename(extractedAudioPath),
        next_step: 'translation_processing'
      }
    })
  } catch (error) {
    leon.answer({
      key: 'extraction_error',
      data: {
        video_path: path.basename(videoPath),
        error: (error as Error).message
      }
    })
  }
}
