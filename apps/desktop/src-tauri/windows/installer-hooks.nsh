!define BIBO_AGENT_BINARY "ctracking.exe"
!define BIBO_INSTALL_LOG "$COMMONAPPDATA\BiBoTracking\installer-service.log"

; Ask the installed, signed binary to manage its own Windows service through
; the native Service Control Manager API. This avoids shell quoting differences
; and makes service setup errors fatal to the installer.
!macro BIBO_RUN_AGENT_ADMIN LABEL ARGUMENT
  nsExec::ExecToStack '"$INSTDIR\${BIBO_AGENT_BINARY}" ${ARGUMENT}'
  Pop $R8
  Pop $R9

  DetailPrint "BiBoTracking service ${LABEL}: exit=$R8"
  CreateDirectory "$COMMONAPPDATA\BiBoTracking"
  ClearErrors
  FileOpen $R7 "${BIBO_INSTALL_LOG}" a
  ${IfNot} ${Errors}
    FileWrite $R7 "${LABEL}: exit=$R8$\r$\n"
    FileClose $R7
  ${EndIf}

  ${If} "$R8" != "0"
    SetErrorLevel 1
    Abort "Unable to configure the BiBoTracking managed-agent service (${LABEL}, exit $R8)."
  ${EndIf}
!macroend

; Stop the supervisor before replacing the application binary during an update.
!macro NSIS_HOOK_PREINSTALL
  Push $R7
  Push $R8
  Push $R9
  ${If} ${FileExists} "$INSTDIR\${BIBO_AGENT_BINARY}"
    !insertmacro BIBO_RUN_AGENT_ADMIN "stop-before-install" "--stop-supervisor-service"
  ${EndIf}
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

  !insertmacro BIBO_RUN_AGENT_ADMIN "install" "--install-supervisor-service"

  Pop $R9
  Pop $R8
  Pop $R7
!macroend

; Uninstall remains a normal, explicit Administrator operation.
!macro NSIS_HOOK_PREUNINSTALL
  Push $R7
  Push $R8
  Push $R9
  ${If} ${FileExists} "$INSTDIR\${BIBO_AGENT_BINARY}"
    !insertmacro BIBO_RUN_AGENT_ADMIN "uninstall" "--uninstall-supervisor-service"
  ${EndIf}
  Pop $R9
  Pop $R8
  Pop $R7
!macroend
