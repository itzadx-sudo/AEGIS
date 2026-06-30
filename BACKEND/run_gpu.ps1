<#
.SYNOPSIS
    run_gpu.ps1 — launch the Aegis GPU inference engines on Windows.

.DESCRIPTION
    Thin Windows wrapper around run_gpu.py, which does the real, cross-platform
    work (picks CUDA when an NVIDIA GPU is present, otherwise CPU; starts the LLM
    and embedding llama.cpp servers; tears down only what it started on Ctrl-C).
    On macOS/Linux use run_gpu.sh instead.

.EXAMPLE
    .\run_gpu.ps1
#>

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Here

Write-Host "[*] Detected Windows - llama.cpp will use CUDA if an NVIDIA GPU is present."

# Pick the Python interpreter:
#   1. $env:AEGIS_PYBIN if set (also consumed by config.py)
#   2. python / py launcher from PATH
function Get-Python {
    if ($env:AEGIS_PYBIN) { return $env:AEGIS_PYBIN }
    foreach ($cand in @("python", "py")) {
        $cmd = Get-Command $cand -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
    }
    throw "No Python interpreter found. Install Python or set AEGIS_PYBIN."
}

$Py = Get-Python
Write-Host "[*] Using interpreter: $Py"
& $Py (Join-Path $Here "run_gpu.py")
exit $LASTEXITCODE
