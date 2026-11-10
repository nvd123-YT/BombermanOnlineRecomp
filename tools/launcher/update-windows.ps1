param(
    [Parameter(Mandatory=$true)][string]$Installer,
    [Parameter(Mandatory=$true)][int]$ParentPid,
    [Parameter(Mandatory=$true)][string]$AppExe,
    [Parameter(Mandatory=$true)][string]$TempDir
)

$ErrorActionPreference = "Stop"

try {
    if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) {
        throw "The verified update installer is missing."
    }

    $parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
    if ($null -ne $parent) {
        Wait-Process -Id $ParentPid
    }

    # electron-builder's NSIS installer detects the existing per-user install
    # and upgrades it in place. User data is stored separately in app userData.
    $install = Start-Process -FilePath $Installer -ArgumentList "/S" -Wait -PassThru
    if ($install.ExitCode -ne 0) {
        throw "The installer exited with code $($install.ExitCode)."
    }
    if (-not (Test-Path -LiteralPath $AppExe -PathType Leaf)) {
        throw "The updated launcher executable was not found at its original path."
    }

    Remove-Item -LiteralPath $TempDir -Recurse -Force -ErrorAction SilentlyContinue
    Start-Process -FilePath $AppExe
} catch {
    Add-Type -AssemblyName PresentationFramework
    $message = "The update could not be installed. Your existing app and save data were left in place." +
               [Environment]::NewLine + [Environment]::NewLine + $_.Exception.Message
    [System.Windows.MessageBox]::Show(
        $message,
        "Bomberman Online update failed",
        [System.Windows.MessageBoxButton]::OK,
        [System.Windows.MessageBoxImage]::Error
    ) | Out-Null
    exit 1
}
