[CmdletBinding()]
param([Parameter(Position=0)][string]$Package,[string]$Target)
$ErrorActionPreference='Stop'
$names=@('dist','app-server.js','package.json','update-fish-home.cmd','update-fish-home.ps1','MODEL-CREDITS.md')
$backup=$null; $stage=$null; $saved=@(); $installed=@()
function Full([string]$p){[IO.Path]::GetFullPath($p.Trim().Trim('"')).TrimEnd('\')}
function SafeItem([string]$p){
  $item=Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
  if($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw "不能更新链接或映射目录：$p"}
  return $item
}
function Runtime([string]$root){
  foreach($name in @('app-server.js','package.json','dist/index.html')){
    if(-not (Test-Path -LiteralPath (Join-Path $root $name) -PathType Leaf)){throw "房间文件不完整：$name"}
  }
  $meta=Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
  if($meta.name -ne 'fish-home-room-runtime'){throw '请选择纯净版运行目录，不要用这个脚本覆盖开发项目。'}
  $null=[version]$meta.version
  return $meta
}
try{
  if(-not $Target){$Target=$PSScriptRoot}
  $targetPath=Full $Target
  $targetItem=SafeItem $targetPath
  if(-not $targetItem -or -not $targetItem.PSIsContainer){throw '请指定已经安装的鱼鱼窝目录。'}
  $targetPath=$targetItem.FullName
  $parent=Split-Path -Parent $targetPath
  $old=Runtime $targetPath
  foreach($name in $names){$null=SafeItem (Join-Path $targetPath $name)}
  if(-not $Package){$Package=Read-Host '粘贴新版本 ZIP 的完整路径（也可以把 ZIP 拖到这里）'}
  $zip=Full $Package
  if([IO.Path]::GetExtension($zip) -ne '.zip' -or -not (Test-Path -LiteralPath $zip -PathType Leaf)){throw '找不到房间更新 ZIP。'}
  $stage=Join-Path $parent ('.fish-home-update-'+[guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage | Out-Null
  $extract=Join-Path $stage 'files'
  Expand-Archive -LiteralPath $zip -DestinationPath $extract
  $source=$extract
  if(-not (Test-Path -LiteralPath (Join-Path $source 'app-server.js'))){
    $matches=@(Get-ChildItem -LiteralPath $extract -Directory | Where-Object {Test-Path -LiteralPath (Join-Path $_.FullName 'app-server.js')})
    if($matches.Count -ne 1){throw 'ZIP 里找不到唯一的房间目录。'}
    $source=$matches[0].FullName
  }
  $new=Runtime $source
  if([version]$new.version -lt [version]$old.version){throw '选择的包比已安装版本更旧。'}
  foreach($name in $names){$null=SafeItem (Join-Path $source $name)}
  $entry=[regex]::Escape((Join-Path $targetPath 'app-server.js'))
  $processes=@(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)
  if($processes | Where-Object {$_.CommandLine -match $entry}){throw '鱼鱼窝后台还在运行。请用鱼鱼窝右上角退出按钮关闭后台后，再运行更新。'}
  $dsh=if($env:DSH_HOME){$env:DSH_HOME}else{Join-Path $env:USERPROFILE '.dsh'}
  $dataRoots=@((Join-Path $targetPath 'data')); if($targetPath -eq (Join-Path $dsh 'fish-home-room')){$dataRoots+=Join-Path $dsh 'fish-home-data'}
  if($env:DAYU_DATA_DIR){$dataRoots+=$env:DAYU_DATA_DIR}
  foreach($dataRoot in $dataRoots){
    $lock=Join-Path $dataRoot 'server.lock'
    if(Test-Path -LiteralPath $lock -PathType Leaf){
      $owner=Get-Content -LiteralPath $lock -Raw | ConvertFrom-Json
      if($owner.pid -and ($processes | Where-Object ProcessId -eq $owner.pid)){throw '这份存档正在使用。请退出鱼鱼窝后台后再更新。'}
    }
  }
  $backupRoot=Join-Path $parent 'fish-home-room-backups'
  $null=SafeItem $backupRoot
  New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
  $backup=Join-Path $backupRoot ($targetItem.Name+'-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8))
  New-Item -ItemType Directory -Path $backup | Out-Null
  foreach($name in $names){
    $next=Join-Path $source $name
    if(-not (Test-Path -LiteralPath $next)){continue}
    $dst=Join-Path $targetPath $name
    if(Test-Path -LiteralPath $dst){
      Move-Item -LiteralPath $dst -Destination (Join-Path $backup $name)
      $saved+= $name
    }
    Move-Item -LiteralPath $next -Destination $dst
    $installed+= $name
  }
  Write-Host "鱼鱼窝已更新至 $($new.version)。可以从 DSH 重新打开。"
  Write-Host "已保留存档和设置。旧版运行文件：$backup"
}catch{
  Write-Host "更新失败：$($_.Exception.Message)" -ForegroundColor Red
  if($saved.Count -or $installed.Count){
    try{
      $failed=Join-Path $stage 'failed'; New-Item -ItemType Directory -Path $failed | Out-Null
      foreach($name in $installed){Move-Item -LiteralPath (Join-Path $targetPath $name) -Destination (Join-Path $failed $name)}
      foreach($name in $saved){Move-Item -LiteralPath (Join-Path $backup $name) -Destination (Join-Path $targetPath $name)}
      Write-Host '已恢复旧版。'
    }catch{Write-Host "恢复未完成，旧版运行文件仍在：$backup" -ForegroundColor Red}
  }
  exit 1
}finally{
  if($stage -and (Test-Path -LiteralPath $stage)){
    $resolved=(Resolve-Path -LiteralPath $stage).ProviderPath
    if((Split-Path -Parent $resolved) -eq $parent -and (Split-Path -Leaf $resolved) -match '^\.fish-home-update-[0-9a-f]{32}$'){
      Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}