# One-step JamTime installer for Windows. Installs Spicetify first if needed.
#   iwr -useb https://raw.githubusercontent.com/Psychemm/JamTime/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$RawUrl = 'https://raw.githubusercontent.com/Psychemm/JamTime/main/dist/jamtime.js'

function Find-Spicetify {
    $cmd = Get-Command spicetify -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $default = Join-Path $env:LOCALAPPDATA 'spicetify\spicetify.exe'
    if (Test-Path $default) { return $default }
    return $null
}

Write-Host ''
Write-Host '  JamTime installer' -ForegroundColor Green
Write-Host ''

$spicetify = Find-Spicetify
if (-not $spicetify) {
    Write-Host 'Installing Spicetify (lets Spotify run extensions)...' -ForegroundColor Cyan
    Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/spicetify/cli/main/install.ps1' | Invoke-Expression
    $spicetify = Find-Spicetify
    if (-not $spicetify) {
        Write-Host 'Spicetify did not install. See https://spicetify.app/docs/getting-started' -ForegroundColor Red
        return
    }
}

$dest = Join-Path (& $spicetify path userdata).Trim() 'Extensions'
New-Item -ItemType Directory -Force $dest | Out-Null
$target = Join-Path $dest 'jamtime.js'

$local = if ($PSScriptRoot) { Join-Path $PSScriptRoot 'dist\jamtime.js' }
if ($local -and (Test-Path $local)) {
    Copy-Item $local $target -Force
} else {
    Write-Host 'Downloading JamTime...' -ForegroundColor Cyan
    Invoke-WebRequest -UseBasicParsing $RawUrl -OutFile $target
}

& $spicetify config extensions jamtime.js | Out-Null
Write-Host 'Applying to Spotify (it will restart)...' -ForegroundColor Cyan
& $spicetify apply
if ($LASTEXITCODE -ne 0) { & $spicetify backup apply }

Write-Host ''
Write-Host '  Done! Click the JamTime button at the top of Spotify.' -ForegroundColor Green
Write-Host ''
