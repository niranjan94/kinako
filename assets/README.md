# Brand icons

The shared Kinako mark lives in [forkBrand.ts](../packages/shared/src/forkBrand.ts). [The icon exporter](../scripts/export-brand-icons.ts) supplies the channel palettes and composes the same geometry into the native, web, and marketing assets.

Run `vp run icons:export` from the repository root to regenerate the tracked assets on any platform. Run `vp run icons:check` to compare them with the exporter without writing files. `vp run icons:export:android` regenerates just the Android artwork.

The Icon Composer projects under `{dev,nightly,prod}/app-icon.icon` retain editable foreground and background layers for iOS. The desktop macOS PNGs use a rounded 824×824 icon body and shadow in a transparent 1024×1024 canvas. The iOS fallback PNGs and Apple touch icons use full-bleed backgrounds so the OS can apply its own mask.

Android uses a shared transparent foreground and one full-bleed background per variant. The launcher and Android 12+ splash masks show the central two thirds of the canvas. The themed launcher and notification icons use monochrome silhouettes of the mark.
