import { Tool } from '@sdk/base-tool'
import { ToolkitConfig } from '@sdk/toolkit-config'

export default class FfmpegTool extends Tool {
  private static readonly TOOLKIT = 'video_streaming'
  private readonly config: ReturnType<typeof ToolkitConfig.load>

  constructor() {
    super()
    // Load configuration from central toolkits directory
    // Use class name for tool config name
    const toolConfigName = this.constructor.name
      .toLowerCase()
      .replace('tool', '')
    this.config = ToolkitConfig.load(FfmpegTool.TOOLKIT, toolConfigName)
  }

  get toolName(): string {
    // Dynamic tool name based on class name
    return this.constructor.name
  }

  get toolkit(): string {
    return FfmpegTool.TOOLKIT
  }

  get description(): string {
    return this.config['description']
  }

  /**
   * Converts a video file to a different format.
   * @param inputPath The file path of the video to be converted.
   * @param outputPath The desired file path for the converted video.
   * @returns A promise that resolves with the path to the converted video file.
   */
  async convertVideoFormat(
    inputPath: string,
    outputPath: string
  ): Promise<string> {
    try {
      await this.executeCommand({
        binaryName: 'ffmpeg',
        args: ['-i', inputPath, outputPath],
        options: { sync: true }
      })

      return outputPath
    } catch (error: unknown) {
      throw new Error(`Video conversion failed: ${(error as Error).message}`)
    }
  }

  /**
   * Extracts the audio track from a video file and saves it as a separate audio file.
   * @param videoPath The file path of the video from which to extract audio.
   * @param audioPath The desired file path for the extracted audio.
   * @returns A promise that resolves with the path to the extracted audio file.
   */
  async extractAudio(videoPath: string, audioPath: string): Promise<string> {
    try {
      // Determine output format and codec based on file extension
      const audioExtension = audioPath.split('.').pop()?.toLowerCase()
      let audioCodec = 'mp3'
      let audioBitrate = '192k'

      switch (audioExtension) {
        case 'mp3':
          audioCodec = 'mp3'
          break
        case 'aac':
          audioCodec = 'aac'
          break
        case 'wav':
          audioCodec = 'pcm_s16le'
          audioBitrate = '' // WAV doesn't need bitrate
          break
        case 'flac':
          audioCodec = 'flac'
          audioBitrate = '' // FLAC is lossless
          break
        default:
          audioCodec = 'mp3' // Default to MP3
      }

      // Build ffmpeg arguments
      const args = ['-i', videoPath, '-vn', '-acodec', audioCodec]

      // Add bitrate for lossy formats
      if (audioBitrate) {
        args.push('-ab', audioBitrate)
      }

      // Add output path
      args.push(audioPath)

      await this.executeCommand({
        binaryName: 'ffmpeg',
        args,
        options: { sync: true }
      })

      return audioPath
    } catch (error: unknown) {
      throw new Error(`Audio extraction failed: ${(error as Error).message}`)
    }
  }

  /**
   * Trims a video to a specified duration.
   * @param inputPath The file path of the video to be trimmed.
   * @param outputPath The desired file path for the trimmed video.
   * @param startTime The start time for the trim, formatted as HH:MM:SS.
   * @param endTime The end time for the trim, formatted as HH:MM:SS.
   * @returns A promise that resolves with the path to the trimmed video file.
   */
  async trimVideo(
    inputPath: string,
    outputPath: string,
    startTime: string,
    endTime: string
  ): Promise<string> {
    try {
      await this.executeCommand({
        binaryName: 'ffmpeg',
        args: [
          '-i',
          inputPath,
          '-ss',
          startTime,
          '-to',
          endTime,
          '-c',
          'copy',
          outputPath
        ],
        options: { sync: true }
      })

      return outputPath
    } catch (error: unknown) {
      throw new Error(`Video trimming failed: ${(error as Error).message}`)
    }
  }

  /**
   * Resizes a video to the specified dimensions.
   * @param inputPath The file path of the video to be resized.
   * @param outputPath The desired file path for the resized video.
   * @param width The target width of the video in pixels.
   * @param height The target height of the video in pixels.
   * @returns A promise that resolves with the path to the resized video file.
   */
  async resizeVideo(
    inputPath: string,
    outputPath: string,
    width: number,
    height: number
  ): Promise<string> {
    try {
      await this.executeCommand({
        binaryName: 'ffmpeg',
        args: ['-i', inputPath, '-vf', `scale=${width}:${height}`, outputPath],
        options: { sync: true }
      })

      return outputPath
    } catch (error: unknown) {
      throw new Error(`Video resizing failed: ${(error as Error).message}`)
    }
  }

  /**
   * Merges a video file with a separate audio file.
   * @param videoPath The file path of the video file.
   * @param audioPath The file path of the audio file.
   * @param outputPath The desired file path for the combined video and audio.
   * @returns A promise that resolves with the path to the merged video file.
   */
  async combineVideoAndAudio(
    videoPath: string,
    audioPath: string,
    outputPath: string
  ): Promise<string> {
    try {
      await this.executeCommand({
        binaryName: 'ffmpeg',
        args: [
          '-i',
          videoPath,
          '-i',
          audioPath,
          '-c:v',
          'copy',
          '-c:a',
          'aac',
          '-strict',
          'experimental',
          outputPath
        ],
        options: { sync: true }
      })

      return outputPath
    } catch (error: unknown) {
      throw new Error(
        `Video and audio combination failed: ${(error as Error).message}`
      )
    }
  }

  /**
   * Compresses a video to reduce its file size.
   * @param inputPath The file path of the video to be compressed.
   * @param outputPath The desired file path for the compressed video.
   * @param bitrate The target bitrate for the video (e.g., "1000k").
   * @returns A promise that resolves with the path to the compressed video file.
   */
  async compressVideo(
    inputPath: string,
    outputPath: string,
    bitrate: string
  ): Promise<string> {
    try {
      await this.executeCommand({
        binaryName: 'ffmpeg',
        args: ['-i', inputPath, '-b:v', bitrate, outputPath],
        options: { sync: true }
      })

      return outputPath
    } catch (error: unknown) {
      throw new Error(`Video compression failed: ${(error as Error).message}`)
    }
  }
}
