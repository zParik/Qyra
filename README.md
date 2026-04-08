# Quire

The free, offline, open-source PDF Swiss Army Knife. Built with Tauri + React + TypeScript.

## Downloads

Grab the latest build from [Releases](../../releases) or the **Artifacts** section of the latest [Actions run](../../actions).

| Platform | Formats |
|----------|---------|
| Windows  | `.msi`, `.exe` (NSIS) |
| Linux    | `.deb`, `.rpm`, `.AppImage` |

## Linux on Wayland (Arch, Hyprland, etc.)

The AppImage is pre-patched to use your system's `libwayland-client.so` instead of the bundled copy, and the app disables WebKitGTK's DMA-buf renderer at startup. If there are issues, try `LD_PRELOAD=/usr/lib/libwayland-client.so Quire.appimage`.


## Development

```bash
npm install
npm run tauri dev
```

## Building

```bash
npm run tauri build
```

## License

See [LICENSE](LICENSE).
