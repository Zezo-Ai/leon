from typing import Optional

from ..base_tool import BaseTool, ExecuteCommandOptions
from ..toolkit_config import ToolkitConfig

MODEL_NAME = 'faster-whisper-large-v3'

class FasterWhisperTool(BaseTool):
    TOOLKIT = 'music_audio'

    def __init__(self):
        super().__init__()
        # Load configuration from central toolkits directory
        self.config = ToolkitConfig.load(self.TOOLKIT, self.tool_name)

    @property
    def tool_name(self) -> str:
        # Use the actual config name for toolkit lookup
        return 'faster_whisper'

    @property
    def toolkit(self) -> str:
        return self.TOOLKIT

    @property
    def description(self) -> str:
        return self.config['description']

    def transcribe_to_file(
        self,
        input_path: str,
        output_path: str,
        device: str = 'auto',
        cpu_threads: Optional[int] = None,
        download_root: Optional[str] = None,
        local_files_only: bool = False
    ) -> str:
        """
        Transcribe audio to a file using faster-whisper

        Args:
            input_path: The file path of the audio to be transcribed
            output_path: The desired file path for the transcription output
            device: Device to use for processing (cpu, cuda, auto)
            cpu_threads: Number of CPU threads to use
            download_root: Root directory for model downloads
            local_files_only: Whether to use only local files

        Returns:
            The path to the transcription file
        """
        try:
            # Get model path using the generic resource system
            model_path = self.get_resource_path(MODEL_NAME)

            args = [
                '--function', 'transcribe_to_file',
                '--input', input_path,
                '--output', output_path,
                '--model_size_or_path', model_path,
                '--device', device
            ]

            if cpu_threads:
                args.extend(['--cpu_threads', str(cpu_threads)])

            if download_root:
                args.extend(['--download_root', download_root])

            if local_files_only:
                args.append('--local_files_only')

            self.execute_command(ExecuteCommandOptions(
                binary_name='faster_whisper',
                args=args,
                options={'sync': True}
            ))

            return output_path
        except Exception as e:
            raise Exception(f"Audio transcription failed: {str(e)}")
