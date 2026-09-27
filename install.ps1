# Installs the JamTime extension into Spicetify.
# Works from a clone of the repo, or straight from the web:
#   iwr -useb https://raw.githubusercontent.com/Psychemm/JamTime/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$RawUrl = 'https://raw.githubusercontent.com/Psychemm/JamTime/main/extension/jamtime.js'

if (-not (Get-Command spicetify -ErrorAction SilentlyContinue)) {
    Write-Host 'Spicetify is not installed. Install it first:' -ForegroundColor Red
    Write-Host '  iwr -useb https://raw.githubusercontent.com/spicetify/cli/main/install.ps1 | iex'
    return
}

$dest = Join-Path (spicetify path userdata).Trim() 'Extensions'
New-Item -ItemType Directory -Force $dest | Out-Null
$target = Join-Path $dest 'jamtime.js'

$local = if ($PSScriptRoot) { Join-Path $PSScriptRoot 'extension\jamtime.js' }
if ($local -and (Test-Path $local)) {
    Copy-Item $local $target -Force
} else {
    Invoke-WebRequest -UseBasicParsing $RawUrl -OutFile $target
}
Write-Host "Installed jamtime.js to $dest"

spicetify config extensions jamtime.js
spicetify apply
Write-Host 'Done! Look for the JamTime button in the top bar of Spotify.' -ForegroundColor Green
