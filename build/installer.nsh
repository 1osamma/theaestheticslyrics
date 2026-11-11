; LUMINA installer: optional desktop and Start menu shortcuts (a page with two checkboxes).
; Included by electron-builder (electron-builder.yml → nsis.include).

!ifndef BUILD_UNINSTALLER
  !include nsDialogs.nsh
  !include LogicLib.nsh

  Var LmDesktopBox
  Var LmStartBox
  Var LmWantDesktop
  Var LmWantStart

  !macro customInit
    ; Silent installs (/S) skip the page: create both shortcuts by default.
    StrCpy $LmWantDesktop ${BST_CHECKED}
    StrCpy $LmWantStart ${BST_CHECKED}
  !macroend

  !macro customPageAfterChangeDir
    Page custom LmShortcutsCreate LmShortcutsLeave
  !macroend

  Function LmShortcutsCreate
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateLabel} 0 0 100% 20u "Choose which shortcuts to create for LUMINA:"
    Pop $0
    ${NSD_CreateCheckbox} 0 26u 100% 12u "Create a &desktop shortcut"
    Pop $LmDesktopBox
    ${NSD_SetState} $LmDesktopBox $LmWantDesktop
    ${NSD_CreateCheckbox} 0 44u 100% 12u "Create a &Start menu shortcut"
    Pop $LmStartBox
    ${NSD_SetState} $LmStartBox $LmWantStart
    nsDialogs::Show
  FunctionEnd

  Function LmShortcutsLeave
    ${NSD_GetState} $LmDesktopBox $LmWantDesktop
    ${NSD_GetState} $LmStartBox $LmWantStart
  FunctionEnd

  !macro customInstall
    ${If} $LmWantDesktop == ${BST_CHECKED}
      CreateShortCut "$DESKTOP\LUMINA.lnk" "$INSTDIR\theaestheticslyrics.exe" "" "$INSTDIR\theaestheticslyrics.exe" 0
      WinShell::SetLnkAUMI "$DESKTOP\LUMINA.lnk" "theaestheticslyrics"
    ${EndIf}
    ${If} $LmWantStart == ${BST_CHECKED}
      CreateShortCut "$SMPROGRAMS\LUMINA.lnk" "$INSTDIR\theaestheticslyrics.exe" "" "$INSTDIR\theaestheticslyrics.exe" 0
      WinShell::SetLnkAUMI "$SMPROGRAMS\LUMINA.lnk" "theaestheticslyrics"
    ${EndIf}
  !macroend
!endif

!macro customUnInstall
  Delete "$DESKTOP\LUMINA.lnk"
  Delete "$SMPROGRAMS\LUMINA.lnk"
!macroend
