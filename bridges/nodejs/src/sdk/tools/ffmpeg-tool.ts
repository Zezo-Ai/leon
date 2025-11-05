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
      // Keep it simple: do not force codec/bitrate. Let ffmpeg choose defaults based on extension.
      // Add -progress to emit periodic key=value lines we can log as progress.
      const args = [
        '-y',
        '-i',
        videoPath,
        '-vn',
        // Progress to stderr so we can parse without interfering with stdout JSON
        '-progress',
        'pipe:2',
        audioPath
      ]

      await this.executeCommand({
        binaryName: 'ffmpeg',
        args,
        options: { sync: false },
        onOutput: (data: string, isError?: boolean) => {
          // Parse ffmpeg -progress key=value lines from stderr
          if (!isError) return
          const lines = data.split('\n')
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || !trimmed.includes('=')) continue
            const [key, value] = trimmed.split('=')
            if (!key || value === undefined) continue

            // Log some useful progress keys
            if (key === 'progress') {
              this.log(`ffmpeg progress: ${value}`)
            } else if (key === 'out_time_ms') {
              const ms = parseInt(value, 10)
              if (!Number.isNaN(ms)) {
                const seconds = Math.floor(ms / 1_000_000)
                this.log(`processed_time_seconds=${seconds}`)
              }
            } else if (key === 'speed') {
              this.log(`speed=${value}`)
            }
          }
        }
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
   * Replaces the audio track of a video with a new audio file.
   * Removes/mutes the original audio and merges the new audio with the video.
   * @param videoPath The file path of the video file.
   * @param newAudioPath The file path of the new audio file to replace the original audio.
   * @param outputPath The desired file path for the video with replaced audio.
   * @returns A promise that resolves with the path to the video file with new audio.
   */
  async replaceVideoAudio(
    videoPath: string,
    newAudioPath: string,
    outputPath: string
  ): Promise<string> {
    try {
      // Use -map to explicitly map video from first input and audio from second input
      // This effectively removes the original audio and replaces it with the new audio
      await this.executeCommand({
        binaryName: 'ffmpeg',
        args: [
          '-y', // Overwrite output file if it exists
          '-i',
          videoPath,
          '-i',
          newAudioPath,
          '-map',
          '0:v:0', // Map video from first input
          '-map',
          '1:a:0', // Map audio from second input
          '-c:v',
          'copy', // Copy video codec (no re-encoding)
          '-c:a',
          'aac', // Encode audio to AAC
          '-b:a',
          '192k', // Audio bitrate
          '-shortest', // Finish encoding when the shortest input stream ends
          outputPath
        ],
        options: { sync: true }
      })

      return outputPath
    } catch (error: unknown) {
      throw new Error(
        `Video audio replacement failed: ${(error as Error).message}`
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
