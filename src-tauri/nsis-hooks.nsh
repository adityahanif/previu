; Uninstall hooks for Previu.
;
; Previu writes its shell associations from the running app (see
; src/assoc.rs), so the installer has no record of them. Without these lines an
; uninstall would leave nine ProgIDs and an "Open with" entry behind, all
; pointing at a deleted executable.

; A shortcut shows its target's icon unless the link names one, so both of the
; installer's shortcuts would carry the executable's mark. They get the brand
; tile instead, which ships next to the executable as a resource.
;
; Everything here is spelled out -- literal names instead of the installer's
; `${PRODUCTNAME}` and friends, and only variables declared before this include
; -- because a macro body keeps the text it had when it was read, and this file
; is read before the installer defines any of that. `BUNDLEID` is the one
; exception: it is mirrored below and undefined again so the installer's own
; definition still wins.
!ifndef BUNDLEID
  !define BUNDLEID "app.previu.viewer"
  !define PREVIU_BUNDLEID_MIRROR
!endif

!macro PREVIU_BRAND_SHORTCUT_ICONS
  ${If} ${FileExists} "$INSTDIR\previu-brand.ico"
    ${If} ${FileExists} "$DESKTOP\Previu.lnk"
      CreateShortCut "$DESKTOP\Previu.lnk" "$INSTDIR\previu.exe" "" "$INSTDIR\previu-brand.ico" 0
      !insertmacro SetLnkAppUserModelId "$DESKTOP\Previu.lnk"
    ${EndIf}
    ; The start menu entry sits in a folder when the user picked one, and which
    ; one is a variable this file cannot read, so both shapes are checked.
    ${If} ${FileExists} "$SMPROGRAMS\Previu.lnk"
      CreateShortCut "$SMPROGRAMS\Previu.lnk" "$INSTDIR\previu.exe" "" "$INSTDIR\previu-brand.ico" 0
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\Previu.lnk"
    ${ElseIf} ${FileExists} "$SMPROGRAMS\Previu\Previu.lnk"
      CreateShortCut "$SMPROGRAMS\Previu\Previu.lnk" "$INSTDIR\previu.exe" "" "$INSTDIR\previu-brand.ico" 0
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\Previu\Previu.lnk"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro PREVIU_BRAND_SHORTCUT_ICONS
!macroend

; The finish page creates the desktop shortcut after the install section has
; run, so the icons are applied once more as the installer closes.
Function .onGUIEnd
  !insertmacro PREVIU_BRAND_SHORTCUT_ICONS
FunctionEnd

!ifdef PREVIU_BUNDLEID_MIRROR
  !undef BUNDLEID
  !undef PREVIU_BUNDLEID_MIRROR
!endif

!macro NSIS_HOOK_PREUNINSTALL
  ; One ProgID per file type, and the "Open with" pointer that names it.
  DeleteRegKey  HKCU "Software\Classes\Previu.png"
  DeleteRegValue HKCU "Software\Classes\.png\OpenWithProgids" "Previu.png"
  DeleteRegKey  HKCU "Software\Classes\Previu.jpg"
  DeleteRegValue HKCU "Software\Classes\.jpg\OpenWithProgids" "Previu.jpg"
  DeleteRegKey  HKCU "Software\Classes\Previu.jpeg"
  DeleteRegValue HKCU "Software\Classes\.jpeg\OpenWithProgids" "Previu.jpeg"
  DeleteRegKey  HKCU "Software\Classes\Previu.jfif"
  DeleteRegValue HKCU "Software\Classes\.jfif\OpenWithProgids" "Previu.jfif"
  DeleteRegKey  HKCU "Software\Classes\Previu.gif"
  DeleteRegValue HKCU "Software\Classes\.gif\OpenWithProgids" "Previu.gif"
  DeleteRegKey  HKCU "Software\Classes\Previu.webp"
  DeleteRegValue HKCU "Software\Classes\.webp\OpenWithProgids" "Previu.webp"
  DeleteRegKey  HKCU "Software\Classes\Previu.bmp"
  DeleteRegValue HKCU "Software\Classes\.bmp\OpenWithProgids" "Previu.bmp"
  DeleteRegKey  HKCU "Software\Classes\Previu.avif"
  DeleteRegValue HKCU "Software\Classes\.avif\OpenWithProgids" "Previu.avif"
  DeleteRegKey  HKCU "Software\Classes\Previu.pdf"
  DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "Previu.pdf"

  ; The application entry, and the capabilities that Settings > Default apps
  ; lists under the name "Previu".
  DeleteRegKey   HKCU "Software\Classes\Applications\Previu.exe"
  DeleteRegKey   HKCU "Software\Previu\Capabilities"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Previu"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; The installer's own install-path branch survives its cleanup, and it is
  ; Previu's own key, so take the rest of the tree with it.
  DeleteRegKey HKCU "Software\Previu"
!macroend
