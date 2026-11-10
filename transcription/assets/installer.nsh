; Standard NSIS finish-page options. Both are checked by default by MUI2.
!macro customFinishPage
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartTranscription"
  !define MUI_FINISHPAGE_RUN_TEXT "Start BitsBytes Transcription"
  !define MUI_FINISHPAGE_SHOWREADME ""
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION "DesktopChoiceHandled"
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Add a desktop shortcut"
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE "ApplyDesktopChoice"
  !insertmacro MUI_PAGE_FINISH
Function ApplyDesktopChoice
  SendMessage $mui.FinishPage.ShowReadme ${BM_GETCHECK} 0 0 $0
  ${If} $0 == ${BST_CHECKED}
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${Else}
    WinShell::UninstShortcut "$newDesktopLink"
    Delete "$newDesktopLink"
  ${EndIf}
FunctionEnd

Function DesktopChoiceHandled
FunctionEnd

Function StartTranscription
  ${StdUtils.ExecShellAsUser} $0 "$appExe" "open" ""
FunctionEnd
!macroend
