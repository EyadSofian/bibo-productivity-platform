!define BIBO_SUPERVISOR_SERVICE "BiBoTrackingSupervisor"
!define BIBO_AGENT_BINARY "ctracking.exe"
!define BIBO_INSTALL_LOG "$COMMONAPPDATA\BiBoTracking\installer-service.log"

; Execute Service Control Manager commands without opening a console. Every
; command is checked: a broken supervisor installation must fail the installer
; instead of leaving a normal-looking but unmanaged agent behind.
!macro BIBO_RUN_SC LABEL ARGUMENTS ALLOWED_EXIT_CODE_1 ALLOWED_EXIT_CODE_2
  nsExec::ExecToStack '"$SYSDIR\sc.exe" ${ARGUMENTS}'
  Pop $R8
  Pop $R9

  DetailPrint "BiBoTracking service ${LABEL}: exit=$R8 output=$R9"
  CreateDirectory "$COMMONAPPDATA\BiBoTracking"
  FileOpen $R7 "${BIBO_INSTALL_LOG}" a
  FileWrite $R7 "${LABEL}: exit=$R8 output=$R9$\r$\n"
  FileClose $R7

  ${If} "$R8" != "0"
  ${AndIf} "$R8" != "${ALLOWED_EXIT_CODE_1}"
  ${AndIf} "$R8" != "${ALLOWED_EXIT_CODE_2}"
    SetErrorLevel 1
    Abort "Unable to configure the BiBoTracking managed-agent service (${LABEL}, exit $R8)."
  ${EndIf}
!macroend

; Stop the supervisor before replacing the application binary during an update.
; Exit 1060 means this is the first installation and the service does not exist.
!macro NSIS_HOOK_PREINSTALL
  Push $R7
  Push $R8
  Push $R9
  !insertmacro BIBO_RUN_SC "stop-before-install" 'stop "${BIBO_SUPERVISOR_SERVICE}"' "1060" "1062"
  Sleep 1500
  Pop $R9
  Pop $R8
  Pop $R7
!macroend

; The per-machine installer is elevated. Windows' default service ACL allows a
; normal employee to query the service but reserves stop/config/delete for local
; administrators. The service launches the same visible tray application.
!macro NSIS_HOOK_POSTINSTALL
  Push $R7
  Push $R8
  Push $R9

  ; Exit 1073 means an earlier installation already created the service.
  !insertmacro BIBO_RUN_SC "create" 'create "${BIBO_SUPERVISOR_SERVICE}" binPath= "$\"$INSTDIR\${BIBO_AGENT_BINARY}$\" --supervisor-service" start= auto DisplayName= "BiBoTracking Agent Supervisor"' "1073" ""
  !insertmacro BIBO_RUN_SC "configure" 'config "${BIBO_SUPERVISOR_SERVICE}" binPath= "$\"$INSTDIR\${BIBO_AGENT_BINARY}$\" --supervisor-service" start= auto DisplayName= "BiBoTracking Agent Supervisor"' "" ""
  !insertmacro BIBO_RUN_SC "description" 'description "${BIBO_SUPERVISOR_SERVICE}" "Keeps the visible, company-managed BiBoTracking agent available."' "" ""
  !insertmacro BIBO_RUN_SC "recovery" 'failure "${BIBO_SUPERVISOR_SERVICE}" reset= 86400 actions= restart/5000/restart/15000/restart/30000' "" ""
  ; Exit 1056 means the service is already running.
  !insertmacro BIBO_RUN_SC "start" 'start "${BIBO_SUPERVISOR_SERVICE}"' "1056" ""

  Pop $R9
  Pop $R8
  Pop $R7
!macroend

; Uninstall remains a normal, explicit Administrator operation. A missing
; service is accepted so uninstall can repair a partial/older installation.
!macro NSIS_HOOK_PREUNINSTALL
  Push $R7
  Push $R8
  Push $R9
  !insertmacro BIBO_RUN_SC "stop-before-uninstall" 'stop "${BIBO_SUPERVISOR_SERVICE}"' "1060" "1062"
  Sleep 1500
  !insertmacro BIBO_RUN_SC "delete" 'delete "${BIBO_SUPERVISOR_SERVICE}"' "1060" ""
  Pop $R9
  Pop $R8
  Pop $R7
!macroend
