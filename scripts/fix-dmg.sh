#!/bin/bash
# Fix DMG: clean up hidden files and set proper window layout
set -e

DMG_PATH="$1"
if [ -z "$DMG_PATH" ]; then
  DMG_PATH="src-tauri/target/release/bundle/dmg/Ergonode Batch Uploader_0.1.0_aarch64.dmg"
fi

echo "Fixing DMG: $DMG_PATH"

# Convert to read-write
TEMP_DMG="${DMG_PATH}.rw.dmg"
hdiutil convert "$DMG_PATH" -format UDRW -o "$TEMP_DMG"

# Mount
MOUNT_DIR=$(hdiutil attach "$TEMP_DMG" -readwrite -noverify | grep "/Volumes/" | sed 's/.*\/Volumes/\/Volumes/')
echo "Mounted at: $MOUNT_DIR"

# Delete .VolumeIcon.icns
if [ -f "$MOUNT_DIR/.VolumeIcon.icns" ]; then
  rm -f "$MOUNT_DIR/.VolumeIcon.icns"
  SetFile -a c "$MOUNT_DIR" 2>/dev/null || true
  echo "Deleted .VolumeIcon.icns"
fi

# Use AppleScript to set clean window layout
VOLUME_NAME=$(basename "$MOUNT_DIR")
osascript <<APPLESCRIPT
tell application "Finder"
  tell disk "$VOLUME_NAME"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {400, 200, 900, 470}
    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to 80
    set position of item "Ergonode Batch Uploader.app" of container window to {140, 110}
    set position of item "Applications" of container window to {360, 110}
    close
    open
  end tell
end tell
APPLESCRIPT
echo "Set DMG window layout"

sleep 2

# Delete .fseventsd LAST (right before unmount, so macOS can't recreate it)
rm -rf "$MOUNT_DIR/.fseventsd" 2>/dev/null || true

# Also delete any other hidden files that macOS may have created
rm -rf "$MOUNT_DIR/.DS_Store" 2>/dev/null || true
rm -rf "$MOUNT_DIR/.Trashes" 2>/dev/null || true
rm -rf "$MOUNT_DIR/.Spotlight-V100" 2>/dev/null || true

echo "Cleaned hidden files"

# Unmount immediately after cleanup (no sleep - minimize time for macOS to recreate files)
hdiutil detach "$MOUNT_DIR"

# Convert back to compressed read-only, replacing original
rm "$DMG_PATH"
hdiutil convert "$TEMP_DMG" -format UDZO -o "$DMG_PATH"
rm "$TEMP_DMG"

echo "Done: $DMG_PATH"
