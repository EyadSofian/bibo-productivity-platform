!define BIBO_SUPERVISOR_SERVICE "BiBoTrackingSupervisor"

; Stop the supervisor before replacing the application binary during an update.
!macro NSIS_HOOK_PREINSTALL
  nsExec::ExecToLog '"$SYSDIR\sc.exe" stop "${BIBO_SUPERVISOR_SERVICE}"'
  Sleep 1500
!macroend

; The per-machine installer is elevated. Windows' default service ACL allows a
; normal employee to query the service but reserves stop/config/delete for local
; administrators. The service launches the same visible tray application.
!macro NSIS_HOOK_POSTINSTALL
  nsExec::ExecToLog '"$SYSDIR\sc.exe" create "${BIBO_SUPERVISOR_SERVICE}" binPath= "$\"$INSTDIR\BiBoTracking.exe$\" --supervisor-service" start= auto DisplayName= "BiBoTracking Agent Supervisor"'
  nsExec::ExecToLog '"$SYSDIR\sc.exe" config "${BIBO_SUPERVISOR_SERVICE}" binPath= "$\"$INSTDIR\BiBoTracking.exe$\" --supervisor-service" start= auto DisplayName= "BiBoTracking Agent Supervisor"'
  nsExec::ExecToLog '"$SYSDIR\sc.exe" description "${BIBO_SUPERVISOR_SERVICE}" "Keeps the visible, company-managed BiBoTracking agent available."'
  nsExec::ExecToLog '"$SYSDIR\sc.exe" failure "${BIBO_SUPERVISOR_SERVICE}" reset= 86400 actions= restart/5000/restart/15000/restart/30000'
  nsExec::ExecToLog '"$SYSDIR\sc.exe" start "${BIBO_SUPERVISOR_SERVICE}"'
!macroend

; Uninstall remains a normal, explicit Administrator operation.
!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog '"$SYSDIR\sc.exe" stop "${BIBO_SUPERVISOR_SERVICE}"'
  Sleep 1500
  nsExec::ExecToLog '"$SYSDIR\sc.exe" delete "${BIBO_SUPERVISOR_SERVICE}"'
!macroend
