from __future__ import annotations

import base64
import binascii
import json
import mimetypes
import tempfile
from pathlib import Path


_TRANSCRIBE_SCRIPT = r'''
import json, sys
from tools.transcription_tools import transcribe_audio
print(json.dumps(transcribe_audio(sys.argv[1]), ensure_ascii=False))
'''

_SPEAK_SCRIPT = r'''
import base64, json, mimetypes, sys
from pathlib import Path
from tools.tts_tool import text_to_speech_tool
text = Path(sys.argv[1]).read_text(encoding="utf-8")
output = sys.argv[2]
result = json.loads(text_to_speech_tool(text, output))
if not isinstance(result, dict):
    result = {"success": False, "error": "Invalid speech-tool response"}
if result.get("success"):
    path = Path(result["file_path"])
    mime = mimetypes.guess_type(path.name)[0] or "audio/mpeg"
    result["data_url"] = "data:" + mime + ";base64," + base64.b64encode(path.read_bytes()).decode("ascii")
    path.unlink(missing_ok=True)
    result.pop("file_path", None)
    result.pop("media_tag", None)
print(json.dumps(result, ensure_ascii=False))
'''


class VoiceService:
    def __init__(self, hermes_root: Path, profile_home: Path, commands):
        self.hermes_root = Path(hermes_root)
        self.profile_home = Path(profile_home)
        self.commands = commands
        self.python = self._find_python()

    def _find_python(self) -> Path:
        for candidate in (self.hermes_root / "venv/bin/python", self.hermes_root / ".venv/bin/python"):
            if candidate.exists():
                return candidate
        return self.hermes_root / "venv/bin/python"

    def status(self) -> dict:
        return {
            "available": self.python.exists(),
            "stt": {"available": self.python.exists(), "provider": "Hermes configured STT"},
            "tts": {"available": self.python.exists(), "provider": "Hermes configured TTS"},
        }

    def _environment(self) -> dict[str, str]:
        return {"HERMES_HOME": str(self.profile_home), "PYTHONPATH": str(self.hermes_root)}

    @staticmethod
    def _parse_result(result: dict) -> dict:
        if result.get("returncode") != 0:
            raise RuntimeError((result.get("stderr") or "Hermes voice command failed").strip()[-1000:])
        lines = [line for line in str(result.get("stdout", "")).splitlines() if line.strip()]
        if not lines:
            raise RuntimeError("Hermes voice command returned no result")
        try:
            payload = json.loads(lines[-1])
        except json.JSONDecodeError as exc:
            raise RuntimeError("Hermes voice command returned an invalid result") from exc
        if not isinstance(payload, dict):
            raise RuntimeError("Hermes voice command returned an invalid result")
        if not payload.get("success"):
            raise RuntimeError(str(payload.get("error") or "Hermes voice command failed"))
        return payload

    async def transcribe(self, data_url: str, mime_type: str | None = None) -> dict:
        if not self.python.exists():
            raise RuntimeError("Hermes local voice runtime is not installed")
        if not data_url.startswith("data:") or "," not in data_url:
            raise ValueError("Invalid audio payload")
        header, encoded = data_url.split(",", 1)
        if ";base64" not in header:
            raise ValueError("Audio payload must be base64 encoded")
        try:
            audio = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("Invalid audio base64") from exc
        if not audio or len(audio) > 25 * 1024 * 1024:
            raise ValueError("Audio payload must be between 1 byte and 25 MiB")
        resolved_mime = (mime_type or header[5:].split(";", 1)[0] or "audio/webm").lower()
        if not resolved_mime.startswith("audio/"):
            raise ValueError("Payload is not audio")
        extension = mimetypes.guess_extension(resolved_mime) or ".webm"
        with tempfile.NamedTemporaryFile(suffix=extension, delete=False) as handle:
            handle.write(audio)
            audio_path = Path(handle.name)
        try:
            result = await self.commands.run(
                [str(self.python), "-c", _TRANSCRIBE_SCRIPT, str(audio_path)],
                cwd=self.hermes_root,
                env=self._environment(),
                environment_scope="voice",
                timeout=300,
            )
            payload = self._parse_result(result)
            return {"success": True, "transcript": payload.get("transcript", ""), "provider": payload.get("provider", "configured")}
        finally:
            audio_path.unlink(missing_ok=True)

    async def speak(self, text: str) -> dict:
        content = text.strip()
        if not content:
            raise ValueError("Text is required")
        if len(content) > 15_000:
            raise ValueError("Speech text exceeds 15000 characters")
        if not self.python.exists():
            raise RuntimeError("Hermes local voice runtime is not installed")
        with tempfile.TemporaryDirectory(prefix="archon-voice-") as directory:
            root = Path(directory)
            text_path = root / "speech.txt"
            output_path = root / "speech.mp3"
            text_path.write_text(content, encoding="utf-8")
            result = await self.commands.run(
                [str(self.python), "-c", _SPEAK_SCRIPT, str(text_path), str(output_path)],
                cwd=self.hermes_root,
                env=self._environment(),
                environment_scope="voice",
                timeout=300,
            )
            payload = self._parse_result(result)
            return {"success": True, "data_url": payload["data_url"], "provider": payload.get("provider", "configured")}
