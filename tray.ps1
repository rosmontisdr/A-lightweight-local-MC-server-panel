param(
  [Parameter(Mandatory = $true)][int]$Port
)

# 托盘图标宿主。由 launch.js 以 detached 方式拉起，随面板常驻。
# 左键单击打开面板网页；右键菜单可重启/关闭面板或退出图标。
# 面板没了就自己退出，不留下一个点了没反应的死图标。

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$url = "http://localhost:$Port"
$logFile = Join-Path $root 'data\tray.log'
# 面板关闭时写下这个文件；本脚本据此立即退出
$script:stopFile = Join-Path $root 'data\panel.stopping'
$script:failures = 0
$script:alive = $true

function Write-Log([string]$msg) {
  try {
    $dir = Split-Path $logFile -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 128KB)) { Remove-Item $logFile -Force }
    $stamp = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')
    Add-Content -Path $logFile -Value "$stamp  $msg" -Encoding UTF8
  } catch { }
}

function Open-Panel {
  # 已经有页面在看面板时，让它自己关掉再开一个新的
  # （浏览器没法把已有的标签页切到前台，只能关掉重开）
  $page = $false
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/panel/show" -TimeoutSec 3
    $page = [bool]$r.page
  } catch { }
  if ($page) {
    Write-Log '已让原来的面板标签页关闭，正在打开新的'
    Start-Sleep -Milliseconds 150
  }
  try { Start-Process $url } catch { Write-Log "打开浏览器失败：$($_.Exception.Message)" }
}

function Invoke-PanelApi([string]$path) {
  try {
    Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port$path" -TimeoutSec 5 | Out-Null
    return $true
  } catch {
    Write-Log "调用 $path 失败：$($_.Exception.Message)"
    return $false
  }
}

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
} catch {
  Write-Log "加载 WinForms 失败：$($_.Exception.Message)"
  exit 1
}

# 与桌面/开始菜单快捷方式同一个图标：安装后是 {app}\rs-panel.ico，开发目录里是 installer\assets\rs-panel.ico
$icon = $null
$iconUsed = '(系统默认)'
foreach ($cand in @(
    (Join-Path $root 'rs-panel.ico'),
    (Join-Path $root 'installer\assets\rs-panel.ico'),
    (Join-Path $root 'public\favicon.ico')
  )) {
  if (Test-Path $cand) {
    try { $icon = New-Object System.Drawing.Icon($cand); $iconUsed = $cand; break } catch { }
  }
}
if (-not $icon) { $icon = [System.Drawing.SystemIcons]::Application }

$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = $icon
$ni.Text = "RS面板 · 端口 $Port"
$ni.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miOpen = $menu.Items.Add('打开面板')
$miRestart = $menu.Items.Add('重启面板')
$miStop = $menu.Items.Add('关闭面板')
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miQuit = $menu.Items.Add('退出托盘图标')
$ni.ContextMenuStrip = $menu

$miOpen.add_Click({
    Write-Log '菜单：打开面板'
    Open-Panel
  })

$miRestart.add_Click({
    Write-Log '菜单：重启面板'
    if (Invoke-PanelApi '/api/panel/restart') {
      [System.Windows.Forms.MessageBox]::Show('面板正在重启，几秒后可重新打开。', 'RS面板',
        [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
    } else {
      [System.Windows.Forms.MessageBox]::Show('重启失败，面板可能已经不在运行。', 'RS面板',
        [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
    }
  })

$miStop.add_Click({
    Write-Log '菜单：关闭面板'
    $ok = [System.Windows.Forms.MessageBox]::Show(
      "确定关闭面板吗？`n`n正在运行的 Minecraft 服务器不受影响，会继续运行。",
      'RS面板', [System.Windows.Forms.MessageBoxButtons]::OKCancel, [System.Windows.Forms.MessageBoxIcon]::Warning)
    if ($ok -ne [System.Windows.Forms.DialogResult]::OK) { return }
    if (Invoke-PanelApi '/api/panel/shutdown') { Write-Log '已请求关闭面板' }
  })

$miQuit.add_Click({
    Write-Log '菜单：退出托盘图标'
    $script:alive = $false
    $ni.Visible = $false
    [System.Windows.Forms.Application]::Exit()
  })

# 左键单击打开面板
$ni.add_MouseClick({
    param($sender, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
      Write-Log '左键单击'
      Open-Panel
    }
  })

# 每 3 秒探一次面板；连续 5 次探不到（约 15 秒）就退出图标
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.add_Tick({
    try {
      $st = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/state" -TimeoutSec 2
      $script:failures = 0
      $n = @($st.servers).Count
      $ni.Text = "RS面板 · 端口 $Port · 已纳管 $n 台"
    } catch {
      $script:failures++
      if ($script:failures -ge 5) {
        Write-Log '面板连续 15 秒无响应，退出托盘图标'
        $script:alive = $false
        $ni.Visible = $false
        [System.Windows.Forms.Application]::Exit()
      }
    }
  })
$timer.Start()

# 面板关闭后马上退：只查本地哨兵文件
$stopTimer = New-Object System.Windows.Forms.Timer
$stopTimer.Interval = 400
$stopTimer.add_Tick({
    if (Test-Path $script:stopFile) {
      Write-Log '面板已关闭，退出托盘图标'
      $script:alive = $false
      $ni.Visible = $false
      [System.Windows.Forms.Application]::Exit()
    }
  })
$stopTimer.Start()

Write-Log "托盘已启动，端口 $Port，图标 $iconUsed"
$ctx = New-Object System.Windows.Forms.ApplicationContext
try {
  [System.Windows.Forms.Application]::Run($ctx)
} finally {
  $timer.Stop()
  $stopTimer.Stop()
  $ni.Visible = $false
  $ni.Dispose()
  Write-Log '托盘已退出'
}
