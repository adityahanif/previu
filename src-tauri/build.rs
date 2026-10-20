/// The default application manifest Tauri embeds, plus `longPathAware`.
///
/// The Common Controls dependency is what makes the native file dialog render as
/// the modern one; Tauri documents it as required for its dialog APIs. The
/// long path setting is what lets this viewer open files below `MAX_PATH`-deep
/// directories, and there is nowhere else to ask for it: the `windows-gnu`
/// toolchain's own manifest carries it, but that manifest is displaced below.
const APP_MANIFEST: &str = r#"
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0" xmlns:asmv3="urn:schemas-microsoft-com:asm.v3">
  <asmv3:application>
    <asmv3:windowsSettings xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">
      <longPathAware>true</longPathAware>
    </asmv3:windowsSettings>
  </asmv3:application>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v2">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false" />
      </requestedPrivileges>
    </security>
  </trustInfo>
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
"#;

fn main() {
    // The `windows-gnu` driver links an application manifest of its own into
    // every executable, which collides with the one Tauri embeds as a resource:
    // ld reports `.rsrc merge failure: multiple non-default manifests` and the
    // image ends up carrying two. It pulls that manifest in through a
    // `%:if-exists(default-manifest.o%s)` spec, so an object of that name found
    // earlier on its search path is used instead -- `scripts/tauri.mjs` writes an
    // empty one and points here, leaving this manifest as the only one.
    if let Some(dir) = std::env::var_os("PREVIU_MANIFEST_SHIM") {
        println!("cargo:rustc-link-arg-bins=-B{}", dir.to_string_lossy());
    }
    println!("cargo:rerun-if-env-changed=PREVIU_MANIFEST_SHIM");

    // tauri-build embeds the icon but does not declare it as an input, and this
    // script emitting its own directives switches off cargo's "watch everything
    // in the package" default. Without this line a replaced icon would keep the
    // previous image until something else caused a rebuild.
    println!("cargo:rerun-if-changed=icons");

    let windows = tauri_build::WindowsAttributes::new().app_manifest(APP_MANIFEST);
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to run tauri-build");
}
