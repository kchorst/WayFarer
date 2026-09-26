param(
  [Parameter(Mandatory=$true)][string]$ZipPath,
  [Parameter(Mandatory=$true)][string]$EvidenceOut,
  [switch]$Externalized
)
$ErrorActionPreference='Stop'

# Run the orchestrator from TEMP so the script itself cannot keep the extracted
# candidate directory open while rename/deleteability is being proved.
if(-not $Externalized){
  $self=(Resolve-Path -LiteralPath $MyInvocation.MyCommand.Path).Path
  $copy=Join-Path $env:TEMP ("wayfinder-windows-lifecycle-"+[guid]::NewGuid().ToString('N')+'.ps1')
  Copy-Item -LiteralPath $self -Destination $copy -Force
  $hostExe=(Get-Process -Id $PID).Path
  & $hostExe -NoProfile -ExecutionPolicy Bypass -File $copy -ZipPath (Resolve-Path -LiteralPath $ZipPath).Path -EvidenceOut $EvidenceOut -Externalized
  $code=$LASTEXITCODE
  Remove-Item -LiteralPath $copy -Force -ErrorAction SilentlyContinue
  exit $code
}

function Get-FreePort {
  $listener=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0);$listener.Start();$p=([System.Net.IPEndPoint]$listener.LocalEndpoint).Port;$listener.Stop();return $p
}
function Wait-Http([string]$Url,[int]$Seconds=15){$end=(Get-Date).AddSeconds($Seconds);while((Get-Date)-lt $end){try{$r=Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 1;if($r.StatusCode -eq 200){return $true}}catch{};Start-Sleep -Milliseconds 150};return $false}
function Wait-ProcessGone([int]$Pid,[int]$Seconds=10){$end=(Get-Date).AddSeconds($Seconds);while((Get-Date)-lt $end){if(-not (Get-Process -Id $Pid -ErrorAction SilentlyContinue)){return $true};Start-Sleep -Milliseconds 150};return -not [bool](Get-Process -Id $Pid -ErrorAction SilentlyContinue)}
function Test-PortFree([int]$Port){try{$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,$Port);$l.Start();$l.Stop();return $true}catch{return $false}}
function Post-Json([string]$Url,$Body,[hashtable]$Headers=@{}){return Invoke-RestMethod -Method Post -Uri $Url -Headers $Headers -ContentType 'application/json' -Body ($Body|ConvertTo-Json -Depth 12 -Compress) -TimeoutSec 20}

$zip=(Resolve-Path -LiteralPath $ZipPath).Path
$out=[System.IO.Path]::GetFullPath($EvidenceOut)
$work=Join-Path $env:TEMP ('wayfinder-native-'+[guid]::NewGuid().ToString('N'))
$extract=Join-Path $work 'extract';$runtime=Join-Path $work 'runtime';$maps=Join-Path $work 'maps';$appData=Join-Path $work 'appdata';$settings=Join-Path $work 'settings.json'
New-Item -ItemType Directory -Path $extract,$runtime,$maps,$appData -Force|Out-Null
$checks=[ordered]@{integrityVerified=$false;launcherUsed=$false;appReachable=$false;backgroundWorkStarted=$false;normalExitUsed=$false;nodeGone=$false;workersGone=$false;portFree=$false;runtimeStateGone=$false;folderRenamed=$false;folderDeleted=$false}
$verdict='FAIL';$errorText='';$releaseId='';$criticalHash='';$manifestHash='';$zipHash=(Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant();$port=Get-FreePort
try{
  Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
  $roots=@(Get-ChildItem -LiteralPath $extract -Directory)
  if($roots.Count -eq 1 -and (Test-Path -LiteralPath (Join-Path $roots[0].FullName 'WAYFINDER.cmd'))){$root=$roots[0].FullName}else{$root=$extract}
  if(-not (Test-Path -LiteralPath (Join-Path $root 'WAYFINDER.cmd'))){throw 'Exact ZIP does not contain WAYFINDER.cmd at a recognizable package root.'}
  $release=Get-Content -Raw -LiteralPath (Join-Path $root 'RELEASE.json')|ConvertFrom-Json;$releaseId=[string]$release.releaseId
  $manifestPath=Join-Path $root 'PACKAGE_INTEGRITY.sha256';$manifestHash=(Get-FileHash -Algorithm SHA256 -LiteralPath $manifestPath).Hash.ToLowerInvariant()
  & node (Join-Path $root 'verify-integrity.mjs')|Out-Null
  if($LASTEXITCODE -ne 0){throw 'Exact ZIP failed complete-tree package integrity verification on Windows.'};$checks.integrityVerified=$true
  $criticalHash=(& node -e "const fs=require('fs'),crypto=require('crypto'),path=require('path');const root=process.argv[1],m=JSON.parse(fs.readFileSync(path.join(root,'RELEASE_CRITICAL_FILES.json'),'utf8'));const h=crypto.createHash('sha256');for(const rel of m.files){h.update(rel+'\\0');h.update(fs.readFileSync(path.join(root,rel)));h.update('\\0')}process.stdout.write(h.digest('hex'))" $root).Trim()
  if($LASTEXITCODE -ne 0 -or $criticalHash -notmatch '^[a-f0-9]{64}$'){throw 'Could not compute critical package hash on Windows.'}

  # Prepare a valid tiny raw OSM PBF outside the extraction, then point the app to it.
  & node (Join-Path $root 'tests\create-tiny-pbf.mjs') (Join-Path $maps 'lifecycle.osm.pbf')|Out-Null
  if($LASTEXITCODE -ne 0){throw 'Could not prepare lifecycle PBF fixture.'}

  $env:APPDATA=$appData;$env:WAYFINDER_PORT=[string]$port;$env:WAYFINDER_RUNTIME_DIR=$runtime;$env:WAYFINDER_SETTINGS_PATH=$settings;$env:WAYFINDER_REFERENCE_ENDPOINT='http://127.0.0.1:1';$env:WAYFINDER_AI_ENDPOINT='http://127.0.0.1:1';$env:WAYFINDER_ALLOW_WEB_GEOCODE='0';$env:WAYFINDER_NO_BROWSER='1';$env:WAYFINDER_CLIENT_CLOSE_GRACE_MS='800'
  $launcher=Start-Process -FilePath 'cmd.exe' -ArgumentList '/c',('"'+(Join-Path $root 'WAYFINDER.cmd')+'"') -WorkingDirectory $root -WindowStyle Hidden -PassThru -Wait
  if($launcher.ExitCode -ne 0){throw "WAYFINDER.cmd returned $($launcher.ExitCode)."};$checks.launcherUsed=$true
  if(-not (Wait-Http "http://127.0.0.1:$port/api/status" 15)){throw 'WAYFINDER did not become reachable.'};$checks.appReachable=$true
  $controlPath=Join-Path $runtime 'server-control.json';$end=(Get-Date).AddSeconds(5);while((Get-Date)-lt $end -and -not (Test-Path -LiteralPath $controlPath)){Start-Sleep -Milliseconds 100};if(-not (Test-Path -LiteralPath $controlPath)){throw 'Runtime control record did not appear.'};$serverPid=[int]((Get-Content -Raw -LiteralPath $controlPath|ConvertFrom-Json).pid)

  $headers=@{'X-WAYFINDER-Client'='1'};$client=Post-Json "http://127.0.0.1:$port/api/system/client/register" @{} $headers;$clientId=[string]$client.clientId;if(-not $clientId){throw 'Client session did not register.'}
  $settingsBody=@{aiEndpoint='http://127.0.0.1:1';referenceEndpoint='http://127.0.0.1:1';pbfRoot=$maps;allowWebGeocode=$false}
  Post-Json "http://127.0.0.1:$port/api/settings" $settingsBody|Out-Null
  $render=Post-Json "http://127.0.0.1:$port/api/offline/render" @{points=@(@{lat=18.0;lon=-76.8},@{lat=18.001;lon=-76.799});legModes=@('Car')}
  if(-not $render.job.id){throw 'Background offline-map worker did not start.'}
  $jobState=[string]$render.job.state
  if($jobState -notin @('starting','working','ready')){
    $live=Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$port/api/offline/job/$($render.job.id)" -TimeoutSec 5
    $jobState=[string]$live.job.state
  }
  if($jobState -notin @('starting','working','ready')){throw "Offline-map background job did not start successfully before shutdown (state=$jobState)."};$checks.backgroundWorkStarted=$true

  Post-Json "http://127.0.0.1:$port/api/system/client/exit" @{clientId=$clientId} $headers|Out-Null;$checks.normalExitUsed=$true
  $checks.nodeGone=Wait-ProcessGone $serverPid 12
  $escaped=$root.Replace("'","''");$owned=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue|Where-Object{$_.CommandLine -and $_.CommandLine.Contains($root)})
  $checks.workersGone=($owned.Count -eq 0)
  $checks.portFree=Test-PortFree $port
  $checks.runtimeStateGone=-not (Test-Path -LiteralPath $controlPath)
  if(-not ($checks.nodeGone -and $checks.workersGone -and $checks.portFree -and $checks.runtimeStateGone)){throw 'Normal Exit left a WAYFINDER process, worker, socket, or runtime record.'}

  $renamed=$root+'-renamed';Move-Item -LiteralPath $root -Destination $renamed -ErrorAction Stop;$checks.folderRenamed=$true
  Remove-Item -LiteralPath $renamed -Recurse -Force -ErrorAction Stop;$checks.folderDeleted=-not (Test-Path -LiteralPath $renamed)
  if(-not $checks.folderDeleted){throw 'Extracted candidate directory remained after delete.'}
  $verdict='PASS'
}catch{$errorText=$_.Exception.Message}
finally{
  $evidence=[ordered]@{schemaVersion=1;verdict=$verdict;platform='win32';releaseId=$releaseId;exactZipSha256=$zipHash;criticalHash=$criticalHash;packageManifestSha256=$manifestHash;createdAt=(Get-Date).ToUniversalTime().ToString('o');checks=$checks;error=$errorText}
  $outDir=Split-Path -Parent $out;if($outDir){New-Item -ItemType Directory -Path $outDir -Force|Out-Null};$json=$evidence|ConvertTo-Json -Depth 8;[System.IO.File]::WriteAllText($out,$json,(New-Object System.Text.UTF8Encoding($false)))
  if(Test-Path -LiteralPath $work){Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue}
}
if($verdict -ne 'PASS'){Write-Error "WAYFINDER native Windows lifecycle FAIL: $errorText";exit 1}
Write-Host "WAYFINDER native Windows lifecycle PASS - evidence: $out";exit 0
