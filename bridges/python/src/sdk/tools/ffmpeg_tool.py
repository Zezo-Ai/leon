from ..base_tool import BaseTool, ExecuteCommandOptions
from ..toolkit_config import ToolkitConfig


class FfmpegTool(BaseTool):
    TOOLKIT = 'video_streaming'

    def __init__(self):
        super().__init__()
        # Load configuration from central toolkits directory
        # Use class name for tool config name
        tool_config_name = self.__class__.__name__.lower().replace('tool', '')
        self.config = ToolkitConfig.load(self.TOOLKIT, tool_config_name)

    @property
    def tool_name(self) -> str:
        # Dynamic tool name based on class name
        return self.__class__.__name__

    @property
    def toolkit(self) -> str:
        return self.TOOLKIT

    @property
    def description(self) -> str:
        return self.config['description']

    def convert_video_format(self, input_path: str, output_path: str) -> str:
        """
        Converts a video file to a different format.
        
        Args:
            input_path: The file path of the video to be converted.
            output_path: The desired file path for the converted video.
            
        Returns:
            The path to the converted video file.
        """
        try:
            self.execute_command(ExecuteCommandOptions(
                binary_name='ffmpeg',
                args=['-i', input_path, output_path],
                options={'sync': True}
            ))

            return output_path
        except Exception as e:
            raise Exception(f"Video conversion failed: {str(e)}")

    def extract_audio(self, video_path: str, audio_path: str) -> str:
        """
        Extracts the audio track from a video file and saves it as a separate audio file.
        
        Args:
            video_path: The file path of the video from which to extract audio.
            audio_path: The desired file path for the extracted audio.
            
        Returns:
            The path to the extracted audio file.
        """
        try:
            self.execute_command(ExecuteCommandOptions(
                binary_name='ffmpeg',
                args=['-i', video_path, '-vn', '-acodec', 'copy', audio_path],
                options={'sync': True}
            ))

            return audio_path
        except Exception as e:
            raise Exception(f"Audio extraction failed: {str(e)}")

    def trim_video(self, input_path: str, output_path: str, start_time: str, end_time: str) -> str:
        """
        Trims a video to a specified duration.
        
        Args:
            input_path: The file path of the video to be trimmed.
            output_path: The desired file path for the trimmed video.
            start_time: The start time for the trim, formatted as HH:MM:SS.
            end_time: The end time for the trim, formatted as HH:MM:SS.
            
        Returns:
            The path to the trimmed video file.
        """
        try:
            self.execute_command(ExecuteCommandOptions(
                binary_name='ffmpeg',
                args=['-i', input_path, '-ss', start_time, '-to', end_time, '-c', 'copy', output_path],
                options={'sync': True}
            ))

            return output_path
        except Exception as e:
            raise Exception(f"Video trimming failed: {str(e)}")

    def resize_video(self, input_path: str, output_path: str, width: int, height: int) -> str:
        """
        Resizes a video to the specified dimensions.
        
        Args:
            input_path: The file path of the video to be resized.
            output_path: The desired file path for the resized video.
            width: The target width of the video in pixels.
            height: The target height of the video in pixels.
            
        Returns:
            The path to the resized video file.
        """
        try:
            self.execute_command(ExecuteCommandOptions(
                binary_name='ffmpeg',
                args=['-i', input_path, '-vf', f'scale={width}:{height}', output_path],
                options={'sync': True}
            ))

            return output_path
        except Exception as e:
            raise Exception(f"Video resizing failed: {str(e)}")

    def combine_video_and_audio(self, video_path: str, audio_path: str, output_path: str) -> str:
        """
        Merges a video file with a separate audio file.
        
        Args:
            video_path: The file path of the video file.
            audio_path: The file path of the audio file.
            output_path: The desired file path for the combined video and audio.
            
        Returns:
            The path to the merged video file.
        """
        try:
            self.execute_command(ExecuteCommandOptions(
                binary_name='ffmpeg',
                args=['-i', video_path, '-i', audio_path, '-c:v', 'copy', '-c:a', 'aac', '-strict', 'experimental',
                      output_path],
                options={'sync': True}
            ))

            return output_path
        except Exception as e:
            raise Exception(f"Video and audio combination failed: {str(e)}")

    def compress_video(self, input_path: str, output_path: str, bitrate: str) -> str:
        """
        Compresses a video to reduce its file size.
        
        Args:
            input_path: The file path of the video to be compressed.
            output_path: The desired file path for the compressed video.
            bitrate: The target bitrate for the video (e.g., "1000k").
            
        Returns:
            The path to the compressed video file.
        """
        try:
            self.execute_command(ExecuteCommandOptions(
                binary_name='ffmpeg',
                args=['-i', input_path, '-b:v', bitrate, output_path],
                options={'sync': True}
            ))

            return output_path
        except Exception as e:
            raise Exception(f"Video compression failed: {str(e)}")
