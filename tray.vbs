' 无窗口拉起托盘图标：wscript 本身是 GUI 程序、没有控制台，所以不会闪黑框。
' 用法：wscript //B //Nologo tray.vbs <端口>
Option Explicit
Dim sh, dir, port, cmd
Set sh = CreateObject("WScript.Shell")
dir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
port = "8080"
If WScript.Arguments.Count > 0 Then port = WScript.Arguments(0)
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden" _
    & " -File """ & dir & "tray.ps1"" -Port " & port
sh.Run cmd, 0, False
