#!/bin/bash
set -Eeuo pipefail

APPIMAGE_PATH="$1"
UPDATE_FILE="$2"
PARENT_PID="$3"
TEMP_DIR="$4"

while /bin/kill -0 "$PARENT_PID" 2>/dev/null; do
  /bin/sleep 1
done

if [ ! -f "$APPIMAGE_PATH" ] || [ ! -s "$UPDATE_FILE" ]; then
  echo "AppImage update or current APPIMAGE path is missing." >&2
  exit 1
fi

NEW_FILE="$APPIMAGE_PATH.update-$$"
BACKUP="$APPIMAGE_PATH.previous-$$"
/bin/cp "$UPDATE_FILE" "$NEW_FILE"
/bin/chmod 755 "$NEW_FILE"
/bin/mv "$APPIMAGE_PATH" "$BACKUP"
if ! /bin/mv "$NEW_FILE" "$APPIMAGE_PATH"; then
  /bin/mv "$BACKUP" "$APPIMAGE_PATH"
  exit 1
fi
/bin/rm -f "$BACKUP"
/bin/rm -rf "$TEMP_DIR"
"$APPIMAGE_PATH" >/dev/null 2>&1 &
