#!/bin/bash
set -Eeuo pipefail

APP_PATH="$1"
UPDATE_ZIP="$2"
PARENT_PID="$3"
TEMP_DIR="$4"

show_error() {
  /usr/bin/osascript -e "display alert \"Bomberman Online update failed\" message \"The update could not be installed. Your existing app and save data were left in place.\" as critical" >/dev/null 2>&1 || true
}
trap 'status=$?; if [ "$status" -ne 0 ]; then show_error; fi' ERR

while /bin/kill -0 "$PARENT_PID" 2>/dev/null; do
  /bin/sleep 1
done

if [ ! -d "$APP_PATH" ] || [ ! -s "$UPDATE_ZIP" ]; then
  echo "Installed app bundle or downloaded ZIP is missing." >&2
  exit 1
fi

EXTRACTED="$TEMP_DIR/extracted"
/bin/mkdir -p "$EXTRACTED"
/usr/bin/ditto -x -k "$UPDATE_ZIP" "$EXTRACTED"

CANDIDATE=""
COUNT=0
while IFS= read -r -d '' item; do
  if [ -f "$item/Contents/Info.plist" ]; then
    CANDIDATE="$item"
    COUNT=$((COUNT + 1))
  fi
done < <(/usr/bin/find "$EXTRACTED" -maxdepth 3 -type d -name '*.app' -print0)

if [ "$COUNT" -ne 1 ] || [ -z "$CANDIDATE" ]; then
  echo "Update ZIP must contain exactly one valid .app bundle." >&2
  exit 1
fi

APP_NAME="$(/usr/bin/basename "$APP_PATH")"
if [ "$(/usr/bin/basename "$CANDIDATE")" != "$APP_NAME" ]; then
  /bin/mv "$CANDIDATE" "$EXTRACTED/$APP_NAME"
  CANDIDATE="$EXTRACTED/$APP_NAME"
fi

PARENT_DIR="$(/usr/bin/dirname "$APP_PATH")"
BACKUP="$PARENT_DIR/.$APP_NAME.update-backup-$$"

/bin/mv "$APP_PATH" "$BACKUP"
if ! /bin/mv "$CANDIDATE" "$APP_PATH"; then
  /bin/mv "$BACKUP" "$APP_PATH"
  exit 1
fi

/bin/rm -rf "$BACKUP"
/bin/rm -rf "$TEMP_DIR"
/usr/bin/open "$APP_PATH"
