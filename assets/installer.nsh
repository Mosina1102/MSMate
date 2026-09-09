; MSMate 安装器自定义脚本（v2.5.6）
; 升级安装时旧版 MSMate.exe 若还在运行，文件被锁 → NSIS 写文件失败静默中止。
; 此处在安装器初始化（静默 /S 与交互模式都走）先等旧进程优雅退出，等不到再强杀兜底。
; 应用侧配合：will-quit 才启动安装器，正常情况下第一次检测就已退出，几乎零等待。
;
; v2.5.4 关键改动：更新走"进度窗进程"（MSMate.exe --update-progress）托管——
; 它负责显示安装进度小窗，并在安装器退出后拉起新版。它自己也叫 MSMate.exe，
; 但绝不能被等待/强杀（否则死锁到超时被杀，新版没人拉起）。
; 所以用 PowerShell 按命令行精确过滤：只等/杀"非 --update-progress"的 MSMate.exe。
;
; v2.5.6 关键改动（更新失败"Failed to uninstall old application files.. 2"修复）：
; ① 进度窗进程已从应用侧下线（它会锁死安装目录的 MSMate.exe），本文件对 --update-progress
;    的排除逻辑保留兜底（老版本卸载器场景不再依赖它）；
; ② 新增 customUnInstallCheck：electron-builder 的卸载结果检查被本宏接管——旧版卸载失败
;   （跨盘 Rename 被当 File is busy / 文件锁等）不再弹框中止安装，直接继续覆盖安装，
;    旧版残骸无害（同路径同名文件被新版覆盖）；
; ③ 应用侧 spawn 安装器时注入 TEMP/TMP=安装目录同卷临时目录，$PLUGINSDIR 同卷 →
;    卸载器的原子 Rename 成功，本兜底大多数时候不会走到。
!include "LogicLib.nsh"

!macro customUnInstallCheck
  DetailPrint `旧版卸载结果已忽略（v2.5.6 兜底：继续覆盖安装，失败文件由新版覆盖）`
!macroend

!macro customUnInstallCheckCurrentUser
  DetailPrint `旧版卸载结果已忽略（v2.5.6 兜底：继续覆盖安装，失败文件由新版覆盖）`
!macroend

!macro customInit
  StrCpy $R0 0
  ${DoWhile} $R0 < 30
    ; 快路径：tasklist 没有任何 MSMate.exe → 直接放行
    nsExec::ExecToStack 'cmd /c tasklist /nh /fi "imagename eq ${APP_EXECUTABLE_FILENAME}" 2>nul | find /i "${APP_EXECUTABLE_FILENAME}"'
    Pop $R1
    Pop $R2
    ${If} $R1 != 0
      ${Break}
    ${EndIf}
    Sleep 500
    IntOp $R0 $R0 + 1
  ${Loop}
  ; 等了 15 秒还在跑（极端卡死 / 老版本 v2.5.4 的 --update-progress 进度窗进程，它不会自己退）
  ; → 无差别强杀兜底（**严禁 /t**：/t 会连坐杀掉"被杀进程的子进程"——进度窗是安装器的父进程，
  ;   /t 会把安装器自己杀掉，v2.5.62 及之前 2.5.4→2.5.62 升级"关闭了却没安装"的根因；
  ;   Electron 多进程全是 MSMate.exe 同镜像名，/im 本就全覆盖，无需 /t）
  nsExec::Exec `taskkill /f /im "${APP_EXECUTABLE_FILENAME}"`
  Sleep 400
!macroend

; v2.5.63：静默安装（自动更新链路 /S）装完自动拉起新版——"重启更新"名副其实。
; v2.5.6 下线进度窗后没人拉新版，electron-builder 静默 assisted 装完默认不启动应用，此宏补位。
; 交互式手动安装不动（finish 页让用户自己选）。
!macro customInstall
  ${If} ${Silent}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
  ${EndIf}
!macroend
