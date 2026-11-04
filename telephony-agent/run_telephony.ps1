# Run the dedicated Telephony Voice Agent worker
Write-Host "Starting Telephony Voice Agent for LiveKit SIP..." -ForegroundColor Cyan

$VENV_PYTHON = "..\voice-agent\.venv\Scripts\python.exe"

if (-not (Test-Path $VENV_PYTHON)) {
    Write-Host "Virtual environment not found at $VENV_PYTHON. Using system python." -ForegroundColor Yellow
    $VENV_PYTHON = "python"
}

& $VENV_PYTHON agent.py dev
