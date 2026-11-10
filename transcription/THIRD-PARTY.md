BitsBytes Transcription is based on the MIT-licensed BitsBytesChat repository.
The application uses Electron (MIT), Node.js (MIT and bundled notices), and FFmpeg
through ffmpeg-static. The Windows FFmpeg binary is a GPL build; its license and
source/build links are distributed alongside the binary in node_modules/ffmpeg-static.
FFmpeg runs as a separate command-line process. See https://ffmpeg.org/legal.html,
https://github.com/eugeneware/ffmpeg-static. This Windows binary is the Gyan
6.1.1 essentials build. Its exact FFmpeg source is
https://github.com/FFmpeg/FFmpeg/commit/e38092ef93; build configuration and component
notices are in ffmpeg.exe.README beside the binary, with ffmpeg.exe.LICENSE.
Electron's LICENSE and LICENSES.chromium.html are distributed by the installer.

Cream and Ink UI is vendored at commit da4036afb1736878413720391d36f4d6ba5bfa65
from https://git.derkdev.nl/derk/cream-ink-ui at the owner's request. Its fonts,
textures, upstream notices, provenance manifest and Apache 2.0 font license are
preserved under dist/renderer/cream-ink-ui in the application archive.
