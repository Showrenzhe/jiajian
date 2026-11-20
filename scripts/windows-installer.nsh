!macro customInstall
  CreateShortCut "$SMPROGRAMS\卸载${SHORTCUT_NAME}.lnk" "$INSTDIR\${UNINSTALL_FILENAME}" "/currentuser"
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\卸载${SHORTCUT_NAME}.lnk"
  ${IfNot} ${isUpdated}
    ; The installed version's cached setup and block map are rebuilt on install.
    Push $R0
    ${GetParent} "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}" $R0
    Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
    Delete "$R0\current.blockmap"
    RMDir "$R0"
    Pop $R0
  ${EndIf}
!macroend
