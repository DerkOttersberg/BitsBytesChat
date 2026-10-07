# Third-party components

Bits & Bytes Chat is a modified OpenCode v1.18.34 desktop application. OpenCode's upstream copyright and MIT license are retained in `LICENSE`. The fork adds recording, speech workers, skill packages, document previews and its own provider bridge. It does not claim authorship of upstream components.

| Component | Authors / source | License / delivery |
| --- | --- | --- |
| OpenCode v1.18.34 | [anomalyco](https://github.com/anomalyco/opencode/tree/v1.18.34) | MIT; forked source and embedded engine |
| Electron / Chromium | [Electron](https://github.com/electron/electron) | MIT and Chromium notices; packaged notices accompany the executable |
| PDF.js | [Mozilla](https://github.com/mozilla/pdf.js) | Apache 2.0; preview renderer |
| QR Code Generator | [Kazuhiko Arase](https://github.com/kazuhikoarase/qrcode-generator) | MIT; existing mobile settings dependency retains its license notice |
| python-docx / python-pptx | [python-openxml](https://github.com/python-openxml) | MIT; local artifact environment |
| openpyxl | [openpyxl](https://openpyxl.readthedocs.io/) | MIT; local artifact environment |
| ReportLab | [ReportLab](https://www.reportlab.com/) | BSD; local artifact environment |
| pypdf / pdfplumber | [pypdf](https://github.com/py-pdf/pypdf), [pdfplumber](https://github.com/jsvine/pdfplumber) | BSD-3-Clause / MIT; local artifact environment |
| PyMuPDF | [Artifex](https://github.com/pymupdf/PyMuPDF) | GNU AGPL 3.0 or Artifex commercial license; separately installed local package retains its license |
| pandas / matplotlib | [pandas](https://github.com/pandas-dev/pandas), [matplotlib](https://github.com/matplotlib/matplotlib) | BSD-3-Clause / Matplotlib license; local artifact environment |
| pywin32 | [Mark Hammond and contributors](https://github.com/mhammond/pywin32) | PSF; installed Office automation |
| ONNX-ASR | [Ivan Stupakov](https://github.com/istupakov/onnx-asr) | MIT; installed by local setup |
| Parakeet TDT 0.6B v3 | [NVIDIA](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) | CC BY 4.0; model weights downloaded separately |
| Quantized Parakeet ONNX export | [Ivan Stupakov](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx) | Conversion/quantization of NVIDIA's model, not a new model trained by this app |
| faster-whisper | [SYSTRAN and contributors](https://github.com/SYSTRAN/faster-whisper) | MIT; installed by local setup |
| Whisper large-v3-turbo | [OpenAI](https://huggingface.co/openai/whisper-large-v3-turbo) | MIT; model weights downloaded separately |
| Silero VAD | [Silero Team](https://github.com/snakers4/silero-vad) | MIT; downloaded VAD model |
| Windows-MCP | [CursorTouch](https://github.com/CursorTouch/Windows-MCP) | MIT; optional local installation |
| Bits en Bytes intake package | User's existing `bits-en-bytes-intake` skill | Imported private instructions, references and helper; original remains unchanged |

Additional dependencies and their exact versions appear in `bun.lock`, the upstream packages, `requirements.txt` and `artifact-requirements.txt`. Python libraries and optional speech models are downloaded into the app's local data folder rather than redistributed inside the Windows installer. Their installed distribution metadata and license files remain in their respective environments. The seven new skill packages are original local instructions, not private OpenAI skill packages. OpenAI and Groq service access remains subject to those services' account permissions and usage limits. This implementation uses the documented public Sign in with ChatGPT endpoints; it does not include OpenAI Devkit code.
