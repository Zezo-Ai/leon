import fs from 'node:fs'
import path from 'node:path'

import type { ActionFunction, ActionParams } from '@sdk/types'
import { leon } from '@sdk/leon'
import { ParamsHelper } from '@sdk/params-helper'
import FfmpegTool from '@sdk/tools/ffmpeg-tool'
import { formatFilePath } from '@sdk/utils'

import { getVideoInfo, updateAudioInfo } from '../lib/memory'

export const run: ActionFunction = async function (
  _params: ActionParams,
  paramsHelper: ParamsHelper
) {
  let videoPath = paramsHelper.getActionArgument('video_path') as string
  let targetLanguage = paramsHelper.getActionArgument(
    'target_language'
  ) as string
  const audioFormat =
    (paramsHelper.getActionArgument('audio_format') as string) || 'mp3'

  try {
    // If video_path is not provided as argument, try to get it from memory
    if (!videoPath) {
      const videoInfo = await getVideoInfo()

      if (!videoInfo) {
        leon.answer({
          key: 'no_video_info',
          data: {
            error:
              'No video information found in memory. Please download a video first.'
          }
        })
        return
      }

      videoPath = videoInfo.videoPath
      targetLanguage = targetLanguage || videoInfo.targetLanguage
    }

    // Initialize ffmpeg tool
    const ffmpegTool = new FfmpegTool()

    // Verify the input video file exists
    if (!fs.existsSync(videoPath)) {
      leon.answer({
        key: 'video_file_not_found',
        data: {
          video_path: formatFilePath(videoPath)
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
        video_path: formatFilePath(path.basename(videoPath)),
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
          video_path: formatFilePath(path.basename(videoPath)),
          error: 'Extracted audio file not found'
        }
      })
      return
    }

    // Get audio file info
    const audioStats = await fs.promises.stat(extractedAudioPath)
    const audioSizeMB = Math.round(audioStats.size / (1_024 * 1_024))

    // Update memory with audio information
    await updateAudioInfo(extractedAudioPath, audioFormat)

    leon.answer({
      key: 'extraction_completed',
      data: {
        video_path: path.basename(videoPath),
        audio_path: formatFilePath(extractedAudioPath),
        folder_path: formatFilePath(path.dirname(extractedAudioPath)),
        audio_size: `${audioSizeMB} MB`,
        target_language: targetLanguage,
        audio_format: audioFormat
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
