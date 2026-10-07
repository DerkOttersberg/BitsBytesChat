param([string]$SourceImage = (Join-Path $PSScriptRoot '..\icons\bitsbytes-source.png'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$iconFolder = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\icons\bitsbytes'))
New-Item -ItemType Directory -Path $iconFolder -Force | Out-Null
$source = [Drawing.Image]::FromFile([IO.Path]::GetFullPath($SourceImage))
$frames = [Collections.Generic.List[object]]::new()
try {
    # Generate platform sizes from the approved source; do not redraw the logo.
    foreach ($size in @(16, 24, 32, 48, 64, 128, 256, 512)) {
        $bitmap = [Drawing.Bitmap]::new($size, $size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        $memory = [IO.MemoryStream]::new()
        try {
            $graphics.Clear([Drawing.Color]::White)
            $graphics.CompositingQuality = [Drawing.Drawing2D.CompositingQuality]::HighQuality
            $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $graphics.DrawImage($source, [Drawing.Rectangle]::new(0, 0, $size, $size))
            $bitmap.Save($memory, [Drawing.Imaging.ImageFormat]::Png)
            $bytes = $memory.ToArray()
            if ($size -le 256) { $frames.Add([pscustomobject]@{size=$size; bytes=$bytes}) }
            $name = switch ($size) { 32 {'32x32.png'} 64 {'64x64.png'} 128 {'128x128.png'} 256 {'128x128@2x.png'} 512 {'icon.png'} }
            if ($name) { [IO.File]::WriteAllBytes((Join-Path $iconFolder $name), $bytes) }
        } finally { $graphics.Dispose(); $bitmap.Dispose(); $memory.Dispose() }
    }
} finally { $source.Dispose() }
$stream = [IO.File]::Create((Join-Path $iconFolder 'icon.ico'))
$writer = [IO.BinaryWriter]::new($stream)
try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$frames.Count)
    $offset = 6 + 16 * $frames.Count
    foreach ($frame in $frames) {
        $edge = if ($frame.size -eq 256) { 0 } else { $frame.size }
        $writer.Write([byte]$edge); $writer.Write([byte]$edge)
        $writer.Write([byte]0); $writer.Write([byte]0)
        $writer.Write([uint16]1); $writer.Write([uint16]32)
        $writer.Write([uint32]$frame.bytes.Length); $writer.Write([uint32]$offset)
        $offset += $frame.bytes.Length
    }
    foreach ($frame in $frames) { $writer.Write([byte[]]$frame.bytes) }
} finally { $writer.Dispose() }
