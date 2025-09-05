import subprocess
import os
from ..base_tool import BaseTool
from ..toolkit_config import ToolkitConfig


class YtdlpTool(BaseTool):
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

    def download_video(self, video_url: str, output_path: str) -> str:
        """
        Downloads a single video from the provided URL.
        
        Args:
            video_url: The URL of the video to download.
            output_path: The directory where the video will be saved.
            
        Returns:
            The file path of the downloaded video.
        """
        try:
            ytdlp_path = self.get_binary_path('yt-dlp')  # Auto-downloads if needed

            # Ensure output directory exists
            os.makedirs(output_path, exist_ok=True)

            # Run yt-dlp with output template
            output_template = os.path.join(output_path, '%(title)s.%(ext)s')
            result = subprocess.run([
                ytdlp_path, video_url, '-o', output_template
            ], capture_output=True, text=True, check=True)

            # Parse the output to get the actual filename
            lines = result.stdout.split('\n')
            for line in lines:
                if 'has already been downloaded' in line or 'Destination:' in line:
                    # Extract filename from the line
                    filename = line.split()[-1]
                    return filename

            # If we can't parse the exact filename, return the template path
            return output_template

        except subprocess.CalledProcessError as e:
            raise Exception(f"Video download failed: {e.stderr}")

    def download_audio_only(self, video_url: str, output_path: str, audio_format: str) -> str:
        """
        Downloads the audio track from a video and saves it as an audio file.
        
        Args:
            video_url: The URL of the video.
            output_path: The directory to save the audio file in.
            audio_format: The desired audio format (e.g., 'mp3', 'm4a', 'wav').
            
        Returns:
            The file path of the extracted audio.
        """
        try:
            ytdlp_path = self.get_binary_path('yt-dlp')  # Auto-downloads if needed

            # Ensure output directory exists
            os.makedirs(output_path, exist_ok=True)

            # Run yt-dlp with audio extraction
            output_template = os.path.join(output_path, f'%(title)s.{audio_format}')
            result = subprocess.run([
                ytdlp_path, video_url, '-x', '--audio-format', audio_format,
                '-o', output_template
            ], capture_output=True, text=True, check=True)

            # Parse the output to get the actual filename
            lines = result.stdout.split('\n')
            for line in lines:
                if 'has already been downloaded' in line or 'Destination:' in line:
                    filename = line.split()[-1]
                    return filename

            return output_template

        except subprocess.CalledProcessError as e:
            raise Exception(f"Audio download failed: {e.stderr}")

    def download_playlist(self, playlist_url: str, output_path: str) -> str:
        """
        Downloads all videos from a given playlist URL.
        
        Args:
            playlist_url: The URL of the playlist.
            output_path: The directory where the playlist videos will be saved.
            
        Returns:
            The path to the directory containing the downloaded videos.
        """
        try:
            ytdlp_path = self.get_binary_path('yt-dlp')  # Auto-downloads if needed

            # Ensure output directory exists
            os.makedirs(output_path, exist_ok=True)

            # Run yt-dlp for playlist
            output_template = os.path.join(output_path, '%(playlist_index)s - %(title)s.%(ext)s')
            subprocess.run([
                ytdlp_path, playlist_url, '-o', output_template
            ], capture_output=True, text=True, check=True)

            return output_path

        except subprocess.CalledProcessError as e:
            raise Exception(f"Playlist download failed: {e.stderr}")

    def download_video_by_quality(self, video_url: str, output_path: str, quality: str) -> str:
        """
        Downloads a video in a specific quality or resolution.
        
        Args:
            video_url: The URL of the video to download.
            output_path: The directory where the video will be saved.
            quality: The desired quality string (e.g., 'best', '720p', '1080p').
            
        Returns:
            The file path of the downloaded video.
        """
        try:
            ytdlp_path = self.get_binary_path('yt-dlp')  # Auto-downloads if needed

            # Ensure output directory exists
            os.makedirs(output_path, exist_ok=True)

            # Convert quality to yt-dlp format
            if quality == 'best':
                format_selector = 'best'
            elif quality == 'worst':
                format_selector = 'worst'
            elif quality.endswith('p'):
                # For resolution like 720p, 1080p
                height = quality[:-1]
                format_selector = f'best[height<={height}]'
            else:
                format_selector = quality

            output_template = os.path.join(output_path, '%(title)s.%(ext)s')
            result = subprocess.run([
                ytdlp_path, video_url, '-f', format_selector, '-o', output_template
            ], capture_output=True, text=True, check=True)

            # Parse the output to get the actual filename
            lines = result.stdout.split('\n')
            for line in lines:
                if 'has already been downloaded' in line or 'Destination:' in line:
                    filename = line.split()[-1]
                    return filename

            return output_template

        except subprocess.CalledProcessError as e:
            raise Exception(f"Quality-specific video download failed: {e.stderr}")

    def download_subtitles(self, video_url: str, output_path: str, language_code: str) -> str:
        """
        Downloads the subtitles for a video.
        
        Args:
            video_url: The URL of the video.
            output_path: The directory to save the subtitle file in.
            language_code: The language code for the desired subtitles (e.g., 'en', 'es').
            
        Returns:
            The file path of the downloaded subtitle file.
        """
        try:
            ytdlp_path = self.get_binary_path('yt-dlp')  # Auto-downloads if needed

            # Ensure output directory exists
            os.makedirs(output_path, exist_ok=True)

            # Download subtitles only
            output_template = os.path.join(output_path, '%(title)s.%(ext)s')
            result = subprocess.run([
                ytdlp_path, video_url, '--write-subs', '--sub-langs', language_code,
                '--skip-download', '-o', output_template
            ], capture_output=True, text=True, check=True)

            # The subtitle file will have the same name but with .srt extension
            subtitle_file = output_template.replace('.%(ext)s', f'.{language_code}.srt')
            return subtitle_file

        except subprocess.CalledProcessError as e:
            raise Exception(f"Subtitle download failed: {e.stderr}")

    def download_video_with_thumbnail(self, video_url: str, output_path: str) -> str:
        """
        Downloads a video and embeds its thumbnail as cover art.
        
        Args:
            video_url: The URL of the video.
            output_path: The directory where the video will be saved.
            
        Returns:
            The file path of the video with the embedded thumbnail.
        """
        try:
            ytdlp_path = self.get_binary_path('yt-dlp')  # Auto-downloads if needed

            # Ensure output directory exists
            os.makedirs(output_path, exist_ok=True)

            # Download with thumbnail embedding
            output_template = os.path.join(output_path, '%(title)s.%(ext)s')
            result = subprocess.run([
                ytdlp_path, video_url, '--embed-thumbnail', '--write-thumbnail',
                '-o', output_template
            ], capture_output=True, text=True, check=True)

            # Parse the output to get the actual filename
            lines = result.stdout.split('\n')
            for line in lines:
                if 'has already been downloaded' in line or 'Destination:' in line:
                    filename = line.split()[-1]
                    return filename

            return output_template

        except subprocess.CalledProcessError as e:
            raise Exception(f"Video with thumbnail download failed: {e.stderr}")
