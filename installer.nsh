; Create shared ProgramData folder with full access for all users during install
!macro customInstall
  Var /GLOBAL HameleonDataDir
  ReadEnvStr $HameleonDataDir "PROGRAMDATA"
  StrCpy $HameleonDataDir "$HameleonDataDir\HAMELEONWEB"
  CreateDirectory "$HameleonDataDir"
  nsExec::ExecToLog 'icacls "$HameleonDataDir" /grant Users:(OI)(CI)F /T'
!macroend
