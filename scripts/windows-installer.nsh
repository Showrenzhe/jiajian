!define JJ_THUMB "{1D514B20-D8CF-47F5-A5A1-EB81A6848B97}"
!define JJ_THUMB_SLOT "{E357FCCD-A995-4576-B01F-234630154E96}"

!macro customInstall
  SetRegView 64
  WriteRegStr HKCU "Software\Classes\CLSID\${JJ_THUMB}\InprocServer32" "" "$INSTDIR\resources\ProjectThumbnail.dll"
  WriteRegStr HKCU "Software\Classes\CLSID\${JJ_THUMB}\InprocServer32" "ThreadingModel" "Apartment"
  WriteRegStr HKCU "Software\Classes\.sdworkbench\ShellEx\${JJ_THUMB_SLOT}" "" "${JJ_THUMB}"
  WriteRegStr HKCU "Software\Classes\.sdworkbench\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  CreateShortCut "$SMPROGRAMS\卸载${SHORTCUT_NAME}.lnk" "$INSTDIR\${UNINSTALL_FILENAME}" "/currentuser"
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\卸载${SHORTCUT_NAME}.lnk"
  ${IfNot} ${isUpdated}
    Push $R0
    SetRegView 64
    DeleteRegKey HKCU "Software\Classes\CLSID\${JJ_THUMB}"
    ReadRegStr $R0 HKCU "Software\Classes\.sdworkbench\ShellEx\${JJ_THUMB_SLOT}" ""
    ${If} $R0 == "${JJ_THUMB}"
      DeleteRegKey HKCU "Software\Classes\.sdworkbench\ShellEx\${JJ_THUMB_SLOT}"
    ${EndIf}
    ReadRegStr $R0 HKCU "Software\Classes\.sdworkbench\DefaultIcon" ""
    ${If} $R0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
      DeleteRegKey HKCU "Software\Classes\.sdworkbench\DefaultIcon"
    ${EndIf}
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
    ; The installed version's cached setup and block map are rebuilt on install.
    ${GetParent} "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}" $R0
    Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
    Delete "$R0\current.blockmap"
    RMDir "$R0"
    Pop $R0
  ${EndIf}
!macroend
