# Generates Android launcher + splash images from ../app_icon.png (run from android-app/).
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile((Resolve-Path '..\app_icon.png'))
$res = 'android\app\src\main\res'

function New-Canvas($w, $h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  return @($bmp, $g)
}
function Save($bmp, $g, $path) { $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose() }

$dens = @{ 'mdpi' = 1; 'hdpi' = 1.5; 'xhdpi' = 2; 'xxhdpi' = 3; 'xxxhdpi' = 4 }
foreach ($d in $dens.Keys) {
  $k = $dens[$d]
  # Legacy square icon (48dp) with rounded corners
  $s = [int](48 * $k); $bmp, $g = New-Canvas $s $s
  $r = [int]($s * 0.22); $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, 2*$r, 2*$r, 180, 90); $path.AddArc($s-2*$r, 0, 2*$r, 2*$r, 270, 90)
  $path.AddArc($s-2*$r, $s-2*$r, 2*$r, 2*$r, 0, 90); $path.AddArc(0, $s-2*$r, 2*$r, 2*$r, 90, 90); $path.CloseFigure()
  $g.SetClip($path); $g.DrawImage($src, 0, 0, $s, $s)
  Save $bmp $g "$res\mipmap-$d\ic_launcher.png"
  # Legacy round icon
  $bmp, $g = New-Canvas $s $s
  $circle = New-Object System.Drawing.Drawing2D.GraphicsPath; $circle.AddEllipse(0, 0, $s, $s)
  $g.SetClip($circle); $g.DrawImage($src, 0, 0, $s, $s)
  Save $bmp $g "$res\mipmap-$d\ic_launcher_round.png"
  # Adaptive foreground (108dp canvas): icon at 80% so the mask only trims its green edge
  $f = [int](108 * $k); $bmp, $g = New-Canvas $f $f
  $inner = [int]($f * 0.80); $off = [int](($f - $inner) / 2)
  $g.DrawImage($src, $off, $off, $inner, $inner)
  Save $bmp $g "$res\mipmap-$d\ic_launcher_foreground.png"
}

# Splash screens: app background with the icon centred
Get-ChildItem $res -Recurse -Filter splash.png | ForEach-Object {
  $old = [System.Drawing.Image]::FromFile($_.FullName); $w = $old.Width; $h = $old.Height; $old.Dispose()
  $bmp, $g = New-Canvas $w $h
  $g.Clear([System.Drawing.ColorTranslator]::FromHtml('#f4f7f5'))
  $is = [int]([Math]::Min($w, $h) * 0.32); $rad = [int]($is * 0.22)
  $x = [int](($w - $is) / 2); $y = [int](($h - $is) / 2)
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc($x, $y, 2*$rad, 2*$rad, 180, 90); $p.AddArc($x+$is-2*$rad, $y, 2*$rad, 2*$rad, 270, 90)
  $p.AddArc($x+$is-2*$rad, $y+$is-2*$rad, 2*$rad, 2*$rad, 0, 90); $p.AddArc($x, $y+$is-2*$rad, 2*$rad, 2*$rad, 90, 90); $p.CloseFigure()
  $g.SetClip($p); $g.DrawImage($src, $x, $y, $is, $is)
  Save $bmp $g $_.FullName
}
$src.Dispose()
'icons generated'
