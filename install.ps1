# Installs the FreeJam extension into Spicetify and re-applies it.
$ErrorActionPreference = 'Stop'

if (-not (Get-Command spicetify -ErrorAction SilentlyContinue)) {
    Write-Error 'Spicetify is not installed. Get it from https://spicetify.app/docs/getting-started'
}

$userdata = (spicetify path userdata).Trim()
$dest = Join-Path $userdata 'Extensions'
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'extension\freejam.js') $dest -Force
Write-Host "Copied freejam.js to $dest"

spicetify config extensions freejam.js
spicetify apply
Write-Host 'Done. Look for the FreeJam button in Spotify''s top bar.'
