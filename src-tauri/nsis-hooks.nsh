; Uninstall hooks for Previu.
;
; Previu writes its shell associations from the running app (see
; src/assoc.rs), so the installer has no record of them. Without these lines an
; uninstall would leave nine ProgIDs and an "Open with" entry behind, all
; pointing at a deleted executable.

; Both shortcuts keep the installer's default icon, which is the executable's
; mark -- the artwork (see the Icons section of the README).

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
