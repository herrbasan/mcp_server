<#
.SYNOPSIS
    Builds a safe memory-refactor lab snapshot (reference + work copies) of the
    live memory/nVDB/dream/chat/storage data.

.DESCRIPTION
    Copies live sources into
        <DestinationRoot>\<Name>\reference\...
        <DestinationRoot>\<Name>\work\...
    using the chain live -> reference -> work, and writes manifest.json plus a
    MANIFEST.sha256 sidecar. The reference copy is never mutated afterwards.

    Default mode is VSS (volume shadow copy): requires an elevated 64-bit
    Windows host. Each source volume gets its own shadow, exposed through a
    temporary directory symlink; robocopy reads from the shadow. Links and
    shadows are always removed in a finally block.

    -AllowCrashConsistentCopy switches to a direct copy without VSS. That is
    NOT a point-in-time snapshot; the mode is recorded in the manifest and a
    loud warning is emitted.

.PARAMETER ProjectRoot
    mcp_server checkout. config.json is read from here.

.PARAMETER StorageRoot
    Storage root to snapshot. Defaults to agents.storage.root in config.json.

.PARAMETER ChatDataRoot
    LLM-Gateway-Chat server/data root. Defaults to
    D:\SRV\LLM-Gateway-Chat\server\data

.PARAMETER DestinationRoot
    Lab root; the snapshot is written to <DestinationRoot>\<Name>.

.PARAMETER Name
    Snapshot folder name. Defaults to a UTC timestamp.

.PARAMETER AllowCrashConsistentCopy
    Direct copy without VSS. Loud warning, recorded in the manifest.

.PARAMETER ExcludeChatData
    Omit the LLM-Gateway-Chat data tree.

.PARAMETER FreeSpaceMarginGb
    Free space required beyond the two copies.

.EXAMPLE
    powershell -NoProfile -File scripts\snapshot-memory-lab.ps1
    powershell -NoProfile -File scripts\snapshot-memory-lab.ps1 -AllowCrashConsistentCopy -Name lab1
#>
[CmdletBinding()]
param(
    [string]$ProjectRoot = 'D:\DEV\mcp_server',
    [string]$StorageRoot,
    [string]$ChatDataRoot,
    [string]$DestinationRoot = 'D:\MCP_Lab\memory-refactor',
    [string]$Name,
    [switch]$AllowCrashConsistentCopy,
    [switch]$ExcludeChatData,
    [ValidateRange(0, [int]::MaxValue)]
    [int]$FreeSpaceMarginGb = 10
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# ── helpers ───────────────────────────────────────────────────────────────────

function Resolve-FullPath([string]$path) {
    if ([string]::IsNullOrWhiteSpace($path)) { throw 'empty path' }
    return [System.IO.Path]::GetFullPath($path)
}

function Resolve-ProjectPath([string]$path) {
    if ([System.IO.Path]::IsPathRooted($path)) { return [System.IO.Path]::GetFullPath($path) }
    return [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $path))
}

function Normalize-ForCompare([string]$path) {
    $full = [System.IO.Path]::GetFullPath($path)
    return $full.TrimEnd('\', '/')
}

function Test-PathInside([string]$child, [string]$parent) {
    $c = Normalize-ForCompare $child
    $p = Normalize-ForCompare $parent
    if ($c -eq $p) { return $true }
    return $c.StartsWith($p + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-Outside([string]$child, [string]$parent, [string]$label) {
    if (Test-PathInside $child $parent) {
        throw "Destination guard: $label is inside what it must stay outside of.`n  destination: $child`n  forbidden root: $parent"
    }
}

function Assert-RequiredPath([string]$path, [string]$label, [string]$kind) {
    if ($kind -eq 'dir') {
        if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw "$label not found (directory): $path" }
    } else {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "$label not found (file): $path" }
    }
}

function Get-TreeStats {
    param(
        [string]$Path,
        [string[]]$ExcludeDirs = @(),
        [string[]]$ExcludeFileNames = @()
    )
    $files = 0
    $bytes = 0
    $base = Normalize-ForCompare $Path
    $items = Get-ChildItem -LiteralPath $Path -Recurse -Force -File -ErrorAction Stop
    foreach ($item in $items) {
        $skip = $false
        if ($ExcludeDirs.Count -gt 0) {
            $segments = $item.DirectoryName.Substring($base.Length).Split('\')
            foreach ($seg in $segments) {
                foreach ($ex in $ExcludeDirs) {
                    if ($seg -ieq $ex) { $skip = $true; break }
                }
                if ($skip) { break }
            }
        }
        if (-not $skip -and $ExcludeFileNames.Count -gt 0) {
            foreach ($ex in $ExcludeFileNames) {
                if ($item.Name -like $ex) { $skip = $true; break }
            }
        }
        if ($skip) { continue }
        $files++
        $bytes += $item.Length
    }
    return [pscustomobject]@{ Files = $files; Bytes = $bytes }
}

function Invoke-Robocopy {
    param(
        [string]$Source,
        [string]$Destination,
        [string[]]$ExcludeDirs = @(),
        [string[]]$ExcludeFileNames = @()
    )
    $rcArgs = @(
        $Source, $Destination,
        '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1',
        '/XJ', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'
    )
    if ($ExcludeDirs.Count -gt 0) { $rcArgs += '/XD'; $rcArgs += $ExcludeDirs }
    if ($ExcludeFileNames.Count -gt 0) { $rcArgs += '/XF'; $rcArgs += $ExcludeFileNames }

    $output = & robocopy.exe @rcArgs 2>&1
    $code = $LASTEXITCODE
    if ($code -ge 8) {
        throw "robocopy failed with exit code $code ($Source -> $Destination)`n$($output -join [Environment]::NewLine)"
    }
    return [pscustomobject]@{ ExitCode = $code; Output = $output }
}

function Copy-SingleFile {
    param([string]$Source, [string]$Destination)
    $parent = Split-Path -Parent $Destination
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-FreeBytes([string]$Path) {
    $probe = $Path
    while (-not (Test-Path -LiteralPath $probe)) {
        $parent = Split-Path -Parent $probe
        if ([string]::IsNullOrEmpty($parent)) { throw "cannot determine an existing ancestor for $Path" }
        $probe = $parent
    }
    $root = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($probe))
    $drive = New-Object System.IO.DriveInfo($root)
    return $drive.AvailableFreeSpace
}

function Get-VolumeRootForPath([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    $root = [System.IO.Path]::GetPathRoot($full)
    if ($root.StartsWith('\\')) { throw "UNC path has no VSS volume: $Path" }
    return $root
}

# Win32_ShadowCopy via WMI: never parses localized command-line output.
function New-ClientAccessibleShadow([string]$Volume) {
    $class = Get-WmiObject -Namespace 'root\cimv2' -Class Win32_ShadowCopy -List
    if (-not $class) { throw 'Win32_ShadowCopy provider is not available on this host' }
    $result = $class.Create($Volume, 'ClientAccessible')
    if ($null -eq $result) { throw "Win32_ShadowCopy.Create returned nothing for $Volume" }
    if ($result.ReturnValue -ne 0) {
        throw "Win32_ShadowCopy.Create failed for $Volume (ReturnValue=$($result.ReturnValue))"
    }
    if ([string]::IsNullOrWhiteSpace($result.ShadowID)) {
        throw "Win32_ShadowCopy.Create returned no ShadowID for $Volume"
    }
    return $result.ShadowID
}

function Get-ShadowCopyInstance([string]$ShadowId) {
    return Get-WmiObject -Namespace 'root\cimv2' -Class Win32_ShadowCopy |
        Where-Object { $_.ID -eq $ShadowId } | Select-Object -First 1
}

function Get-ShadowDeviceObject([string]$ShadowId) {
    $shadow = Get-ShadowCopyInstance $ShadowId
    if (-not $shadow) { throw "shadow copy not found after creation: $ShadowId" }
    if ([string]::IsNullOrWhiteSpace($shadow.DeviceObject)) {
        throw "shadow copy $ShadowId has no DeviceObject"
    }
    return $shadow.DeviceObject
}

function Remove-ShadowCopy([string]$ShadowId) {
    $shadow = Get-ShadowCopyInstance $ShadowId
    if (-not $shadow) { return }
    $result = $shadow.Delete()
    if ($null -ne $result -and $result.ReturnValue -ne 0) {
        throw "Win32_ShadowCopy.Delete failed for $ShadowId (ReturnValue=$($result.ReturnValue))"
    }
}

function Write-Manifest($Manifest, [string]$Path, [string]$SidecarPath) {
    $json = $Manifest | ConvertTo-Json -Depth 10
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $json, $utf8)
    $hash = Get-Sha256 $Path
    [System.IO.File]::WriteAllText($SidecarPath, ($hash + '  manifest.json' + [Environment]::NewLine), $utf8)
    return $hash
}

# ── configuration ─────────────────────────────────────────────────────────────

$ProjectRoot = Resolve-FullPath $ProjectRoot
$DestinationRoot = Resolve-FullPath $DestinationRoot

$configPath = Join-Path $ProjectRoot 'config.json'
Assert-RequiredPath $configPath 'config.json' 'file'
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if (-not $config.agents) { throw "config.json has no 'agents' section: $configPath" }

if ([string]::IsNullOrWhiteSpace($StorageRoot)) {
    if (-not $config.agents.storage.root) { throw 'config.json has no agents.storage.root; pass -StorageRoot' }
    $StorageRoot = $config.agents.storage.root
}
$StorageRoot = Resolve-FullPath $StorageRoot

if ([string]::IsNullOrWhiteSpace($ChatDataRoot)) {
    $ChatDataRoot = 'D:\SRV\LLM-Gateway-Chat\server\data'
}
$ChatDataRoot = Resolve-FullPath $ChatDataRoot

if (-not $config.agents.memory.dbPath) { throw 'config.json has no agents.memory.dbPath' }
if (-not $config.agents.vdb.dbPath) { throw 'config.json has no agents.vdb.dbPath' }
if (-not $config.agents.chat.dir) { throw 'config.json has no agents.chat.dir' }

$memoryDbPath = Resolve-ProjectPath $config.agents.memory.dbPath
$memoryDir = Split-Path -Parent $memoryDbPath
$nvdbDir = Resolve-ProjectPath $config.agents.vdb.dbPath
$chatSessionsDir = Resolve-ProjectPath $config.agents.chat.dir
$dataRoot = Join-Path $ProjectRoot 'data'

$dreamMapPath = Join-Path $dataRoot 'dream_map.json'
$dreamDistillatePath = Join-Path $dataRoot 'dream_distillate.json'
$dreamMapsDir = Join-Path $dataRoot 'dream_maps'

Assert-RequiredPath $memoryDir 'memory data directory' 'dir'
Assert-RequiredPath $memoryDbPath 'memory nDB file' 'file'
Assert-RequiredPath $nvdbDir 'nVDB directory' 'dir'
Assert-RequiredPath $chatSessionsDir 'chat sessions directory' 'dir'
Assert-RequiredPath $dreamMapPath 'dream_map.json' 'file'
Assert-RequiredPath $dreamDistillatePath 'dream_distillate.json' 'file'
Assert-RequiredPath $dreamMapsDir 'data/dream_maps' 'dir'
Assert-RequiredPath $StorageRoot 'storage root' 'dir'
if (-not $ExcludeChatData) { Assert-RequiredPath $ChatDataRoot 'LLM-Gateway-Chat data root' 'dir' }

# ── source plan ───────────────────────────────────────────────────────────────

$sourcePlan = New-Object System.Collections.ArrayList

function Add-Source {
    param(
        [string]$Name,
        [string]$Role,
        [string]$Kind,
        [string]$Path,
        [string]$RelativePath,
        [string[]]$ExcludeDirs = @(),
        [string[]]$ExcludeFileNames = @()
    )
    $entry = [pscustomobject]@{
        Name             = $Name
        Role             = $Role
        Kind             = $Kind
        LivePath         = $Path
        RelativePath     = $RelativePath
        ExcludeDirs      = $ExcludeDirs
        ExcludeFileNames = $ExcludeFileNames
    }
    [void]$sourcePlan.Add($entry)
}

Add-Source -Name 'memory-ndb' -Role 'memory-ndb' -Kind 'dir' -Path $memoryDir `
    -RelativePath 'mcp-server/data/memories' -ExcludeDirs @('_trash')

Add-Source -Name 'nvdb' -Role 'nvdb' -Kind 'dir' -Path $nvdbDir `
    -RelativePath 'mcp-server/data/nvdb' -ExcludeDirs @('_trash')

Add-Source -Name 'chat-sessions' -Role 'chat-sessions' -Kind 'dir' -Path $chatSessionsDir `
    -RelativePath 'mcp-server/data/chat/sessions'

Add-Source -Name 'dream-map' -Role 'dream-json' -Kind 'file' -Path $dreamMapPath `
    -RelativePath 'mcp-server/data/dream_map.json'

Add-Source -Name 'dream-distillate' -Role 'dream-json' -Kind 'file' -Path $dreamDistillatePath `
    -RelativePath 'mcp-server/data/dream_distillate.json'

$dreamRawOutputs = @(Get-ChildItem -LiteralPath $dataRoot -Filter 'dream_raw_output*.json' -File -Force)
foreach ($rawOutput in $dreamRawOutputs) {
    Add-Source -Name ('dream-raw:' + $rawOutput.Name) -Role 'dream-json' -Kind 'file' `
        -Path $rawOutput.FullName -RelativePath ('mcp-server/data/' + $rawOutput.Name)
}

Add-Source -Name 'dream-maps-history' -Role 'dream-history' -Kind 'dir' -Path $dreamMapsDir `
    -RelativePath 'mcp-server/data/dream_maps'

Add-Source -Name 'storage' -Role 'storage' -Kind 'dir' -Path $StorageRoot -RelativePath 'storage'

if (-not $ExcludeChatData) {
    Add-Source -Name 'chat-data' -Role 'chat-data' -Kind 'dir' -Path $ChatDataRoot `
        -RelativePath 'chat-data' -ExcludeFileNames @('*.zip')
}

# ── destination guards ────────────────────────────────────────────────────────

Assert-Outside $DestinationRoot $ProjectRoot 'DestinationRoot'
Assert-Outside $DestinationRoot $StorageRoot 'DestinationRoot'
if (-not $ExcludeChatData) { Assert-Outside $DestinationRoot $ChatDataRoot 'DestinationRoot' }
foreach ($src in $sourcePlan) {
    Assert-Outside $DestinationRoot $src.LivePath 'DestinationRoot'
    if (Test-PathInside $src.LivePath $DestinationRoot) {
        throw "Destination guard: source $($src.Name) sits inside the destination root.`n  source: $($src.LivePath)`n  destination: $DestinationRoot"
    }
}

if ([string]::IsNullOrWhiteSpace($Name)) {
    $Name = (Get-Date).ToUniversalTime().ToString('yyyyMMdd_HHmmss')
}
if ($Name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
    throw "snapshot name must match ^[A-Za-z0-9][A-Za-z0-9._-]*$ - got '$Name'"
}

$snapshotRoot = Join-Path $DestinationRoot $Name
if (Test-Path -LiteralPath $snapshotRoot) {
    throw "snapshot destination already exists, refusing to overwrite: $snapshotRoot"
}
$referenceRoot = Join-Path $snapshotRoot 'reference'
$workRoot = Join-Path $snapshotRoot 'work'
$manifestPath = Join-Path $snapshotRoot 'manifest.json'
$manifestSidecarPath = Join-Path $snapshotRoot 'MANIFEST.sha256'

# ── preflight: space for two copies ───────────────────────────────────────────

Write-Host '[preflight] measuring sources...'
$sourceStats = @{}
$estimateBytes = 0
foreach ($src in $sourcePlan) {
    if ($src.Kind -eq 'dir') {
        $stats = Get-TreeStats -Path $src.LivePath -ExcludeDirs $src.ExcludeDirs -ExcludeFileNames $src.ExcludeFileNames
    } else {
        $info = Get-Item -LiteralPath $src.LivePath -Force
        $stats = [pscustomobject]@{ Files = 1; Bytes = $info.Length }
    }
    $sourceStats[$src.Name] = $stats
    $estimateBytes += $stats.Bytes
}

$requiredBytes = (2 * $estimateBytes) + ([int64]$FreeSpaceMarginGb * 1GB)
$freeBytes = Get-FreeBytes $DestinationRoot
Write-Host ("[preflight] sources: {0} files / {1} bytes; two copies + {2} GB margin need {3} bytes; free {4} bytes" -f `
        (($sourceStats.Values | Measure-Object Files -Sum).Sum), $estimateBytes, $FreeSpaceMarginGb, $requiredBytes, $freeBytes)
if ($freeBytes -lt $requiredBytes) {
    throw ("Insufficient free space on the destination volume for two copies plus margin." +
        " needed=$requiredBytes free=$freeBytes destination=$DestinationRoot")
}

# ── consistency mode ──────────────────────────────────────────────────────────

$mode = 'crash-consistent-copy'
$warning = $null
$vssShadows = New-Object System.Collections.ArrayList
$vssLinks = New-Object System.Collections.ArrayList
$vssRoot = $null

if (-not $AllowCrashConsistentCopy) {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        throw ('VSS mode requires an elevated 64-bit Windows shell (Win32_ShadowCopy via WMI).' +
            ' Re-run from an elevated prompt, or pass -AllowCrashConsistentCopy for a direct copy' +
            ' (that copy is NOT point-in-time).')
    }
    if (-not [Environment]::Is64BitProcess -or -not [Environment]::Is64BitOperatingSystem) {
        throw 'VSS mode requires a 64-bit process on 64-bit Windows.'
    }
    $mode = 'vss'
} else {
    $warning = ('CRASH-CONSISTENT DIRECT COPY: no volume shadow copy was taken. Files were read while ' +
        'the live services were running, so the result is NOT a point-in-time snapshot. Databases may ' +
        'be internally inconsistent. Mode is recorded in manifest.json as "crash-consistent-copy".')
    Write-Warning $warning
}

# ── copy plan (snapshot -> reference -> work) ─────────────────────────────────

$chatDataExclusions = @('*.zip')
if ($ExcludeChatData) { $chatDataExclusions = @('entire tree excluded') }

$manifest = [ordered]@{
    tool           = 'snapshot-memory-lab'
    version        = 1
    name           = $Name
    createdAt      = (Get-Date).ToUniversalTime().ToString('o')
    mode           = $mode
    pointInTime    = ($mode -eq 'vss')
    warning        = $warning
    flow           = 'live -> reference -> work'
    projectRoot    = $ProjectRoot
    storageRoot    = $StorageRoot
    chatDataRoot   = $(if ($ExcludeChatData) { $null } else { $ChatDataRoot })
    destinationRoot = $DestinationRoot
    snapshotRoot   = $snapshotRoot
    referenceRoot  = $referenceRoot
    workRoot       = $workRoot
    manifestHashFile = 'MANIFEST.sha256'
    exclusions     = [ordered]@{
        mcpServerSources   = @('memory data: _trash', 'nvdb: _trash')
        chatData           = $chatDataExclusions
        neverIncluded      = @('notepad', 'browser profiles', 'forge', 'uploads', 'temp')
        note               = 'chat-data *.log and nVDB wal/log files are REQUIRED and are not excluded'
    }
    freeSpace      = [ordered]@{
        requiredBytes  = $requiredBytes
        availableBytes = $freeBytes
        marginGb       = $FreeSpaceMarginGb
    }
    vss            = $null
    sources        = @()
    criticalHashes = @()
    totals         = [ordered]@{ estimateBytes = $estimateBytes }
    copyStatus     = 'pending'
}

try {
    if ($mode -eq 'vss') {
        $volumes = @()
        foreach ($src in $sourcePlan) {
            $vol = Get-VolumeRootForPath $src.LivePath
            if ($volumes -notcontains $vol) { $volumes += $vol }
        }
        Write-Host ("[vss] creating shadow copies for: {0}" -f ($volumes -join ', '))

        if (-not (Test-Path -LiteralPath $snapshotRoot)) {
            New-Item -ItemType Directory -Path $snapshotRoot -Force | Out-Null
        }
        $vssRoot = Join-Path $snapshotRoot '.vss'
        New-Item -ItemType Directory -Path $vssRoot -Force | Out-Null

        $shadowDevices = @{}
        foreach ($vol in $volumes) {
            $shadowId = New-ClientAccessibleShadow $vol
            [void]$vssShadows.Add($shadowId)
            $device = Get-ShadowDeviceObject $shadowId

            $linkPath = Join-Path $vssRoot $vol.Substring(0, 1)
            # SymbolicLink keeps the shadow device path intact (no cmd quoting), and
            # the trailing separator marks the target as the volume root directory.
            New-Item -ItemType SymbolicLink -Path $linkPath -Target ($device + '\') -ErrorAction Stop | Out-Null
            [void]$vssLinks.Add($linkPath)
            $shadowDevices[$vol] = $linkPath
            Write-Host "[vss] $vol -> $device"
        }

        $manifest.vss = [ordered]@{
            volumes = $volumes
            shadows = @($vssShadows)
            links   = @($vssLinks)
        }

        foreach ($src in $sourcePlan) {
            $vol = Get-VolumeRootForPath $src.LivePath
            $relativeToVolume = $src.LivePath.Substring($vol.Length)
            $src | Add-Member -NotePropertyName SnapshotPath -NotePropertyValue (Join-Path $shadowDevices[$vol] $relativeToVolume) -Force
        }
    } else {
        foreach ($src in $sourcePlan) {
            $src | Add-Member -NotePropertyName SnapshotPath -NotePropertyValue $src.LivePath -Force
        }
    }

    New-Item -ItemType Directory -Path $referenceRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $workRoot -Force | Out-Null

    # live/snapshot -> reference
    Write-Host '[copy] snapshot -> reference'
    foreach ($src in $sourcePlan) {
        $src | Add-Member -NotePropertyName ReferencePath -NotePropertyValue (Join-Path $referenceRoot $src.RelativePath) -Force
        $src | Add-Member -NotePropertyName WorkPath -NotePropertyValue (Join-Path $workRoot $src.RelativePath) -Force
        $src | Add-Member -NotePropertyName CopyExitCode -NotePropertyValue $null -Force

        if ($src.Kind -eq 'dir') {
            $result = Invoke-Robocopy -Source $src.SnapshotPath -Destination $src.ReferencePath `
                -ExcludeDirs $src.ExcludeDirs -ExcludeFileNames $src.ExcludeFileNames
            $src.CopyExitCode = $result.ExitCode
        } else {
            Copy-SingleFile -Source $src.SnapshotPath -Destination $src.ReferencePath
            $src.CopyExitCode = 0
        }
    }

    # reference -> work
    Write-Host '[copy] reference -> work'
    foreach ($src in $sourcePlan) {
        if ($src.Kind -eq 'dir') {
            $result = Invoke-Robocopy -Source $src.ReferencePath -Destination $src.WorkPath `
                -ExcludeDirs $src.ExcludeDirs -ExcludeFileNames $src.ExcludeFileNames
        } else {
            Copy-SingleFile -Source $src.ReferencePath -Destination $src.WorkPath
        }
    }

    # stats + manifest sources
    $totalFiles = 0
    $totalBytes = 0
    foreach ($src in $sourcePlan) {
        if ($src.Kind -eq 'dir') {
            $refStats = Get-TreeStats -Path $src.ReferencePath -ExcludeDirs $src.ExcludeDirs -ExcludeFileNames $src.ExcludeFileNames
            $workStats = Get-TreeStats -Path $src.WorkPath -ExcludeDirs $src.ExcludeDirs -ExcludeFileNames $src.ExcludeFileNames
        } else {
            $refStats = [pscustomobject]@{ Files = 1; Bytes = (Get-Item -LiteralPath $src.ReferencePath -Force).Length }
            $workStats = [pscustomobject]@{ Files = 1; Bytes = (Get-Item -LiteralPath $src.WorkPath -Force).Length }
        }
        if ($refStats.Files -ne $workStats.Files -or $refStats.Bytes -ne $workStats.Bytes) {
            throw ("work copy diverged from reference for {0}: reference {1} files/{2} bytes, work {3} files/{4} bytes" -f `
                    $src.Name, $refStats.Files, $refStats.Bytes, $workStats.Files, $workStats.Bytes)
        }
        $totalFiles += $refStats.Files
        $totalBytes += $refStats.Bytes
        $manifest.sources += [ordered]@{
            name         = $src.Name
            role         = $src.Role
            kind         = $src.Kind
            sourcePath   = $src.SnapshotPath
            livePath     = $src.LivePath
            referencePath = $src.ReferencePath
            workPath     = $src.WorkPath
            relativePath = $src.RelativePath
            files        = $refStats.Files
            bytes        = $refStats.Bytes
            estimatedFiles = $sourceStats[$src.Name].Files
            estimatedBytes = $sourceStats[$src.Name].Bytes
            robocopyExitCode = $src.CopyExitCode
            copyStatus   = 'ok'
        }
    }
    $manifest.totals = [ordered]@{
        estimateBytes = $estimateBytes
        copiedFiles   = $totalFiles
        copiedBytes   = $totalBytes
    }

    # critical hashes: reference and work must be byte-identical
    $criticalRelatives = New-Object System.Collections.ArrayList
    foreach ($src in $sourcePlan) {
        switch ($src.Role) {
            'memory-ndb' {
                [void]$criticalRelatives.Add(($src.RelativePath + '/' + (Split-Path -Leaf $memoryDbPath)))
            }
            'nvdb' {
                foreach ($candidate in @('scan-index.json', 'meta.json')) {
                    $test = Join-Path $src.ReferencePath $candidate
                    if (Test-Path -LiteralPath $test -PathType Leaf) {
                        [void]$criticalRelatives.Add(($src.RelativePath + '/' + $candidate))
                    }
                }
            }
            'dream-json' {
                [void]$criticalRelatives.Add($src.RelativePath)
            }
        }
    }

    foreach ($rel in $criticalRelatives) {
        $refFile = Join-Path $referenceRoot ($rel -replace '/', '\')
        $workFile = Join-Path $workRoot ($rel -replace '/', '\')
        Assert-RequiredPath $refFile "critical file in reference: $rel" 'file'
        Assert-RequiredPath $workFile "critical file in work: $rel" 'file'
        $refHash = Get-Sha256 $refFile
        $workHash = Get-Sha256 $workFile
        if ($refHash -ne $workHash) {
            throw "critical file hash mismatch between reference and work: $rel ($refHash != $workHash)"
        }
        $manifest.criticalHashes += [ordered]@{
            path     = $rel
            bytes    = (Get-Item -LiteralPath $refFile -Force).Length
            sha256   = $refHash
            verifiedIdentical = $true
        }
    }

    $manifest.copyStatus = 'ok'
    $manifestPathHash = Write-Manifest -Manifest $manifest -Path $manifestPath -SidecarPath $manifestSidecarPath
    Write-Host "[done] snapshot: $snapshotRoot"
    Write-Host ("[done] mode={0} sources={1} files={2} bytes={3} manifestSha256={4}" -f `
            $mode, $sourcePlan.Count, $totalFiles, $totalBytes, $manifestPathHash)
}
catch {
    $manifest.copyStatus = 'failed'
    $manifest.error = $_.Exception.Message
    try {
        if (-not (Test-Path -LiteralPath $snapshotRoot)) {
            New-Item -ItemType Directory -Path $snapshotRoot -Force | Out-Null
        }
        Write-Manifest -Manifest $manifest -Path $manifestPath -SidecarPath $manifestSidecarPath | Out-Null
    } catch {
        Write-Warning "could not write failure manifest: $($_.Exception.Message)"
    }
    throw
}
finally {
    # Remove only what this script created: our links, our shadows, our .vss dir.
    foreach ($linkPath in @($vssLinks)) {
        if (Test-Path -LiteralPath $linkPath) {
            & $env:ComSpec ('/c rmdir "{0}"' -f $linkPath) | Out-Null
            if ($LASTEXITCODE -ne 0) { Write-Warning "could not remove VSS link: $linkPath" }
        }
    }
    foreach ($shadowId in @($vssShadows)) {
        try {
            Remove-ShadowCopy $shadowId
        } catch {
            Write-Warning "could not delete VSS shadow ${shadowId}: $($_.Exception.Message)"
        }
    }
    if ($vssRoot -and (Test-Path -LiteralPath $vssRoot)) {
        $remaining = @(Get-ChildItem -LiteralPath $vssRoot -Force)
        if ($remaining.Count -eq 0) {
            Remove-Item -LiteralPath $vssRoot -Force
        } else {
            Write-Warning "VSS temp directory not empty, left in place: $vssRoot"
        }
    }
}
