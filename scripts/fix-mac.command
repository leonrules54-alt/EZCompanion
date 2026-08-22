#!/bin/bash
# One-click fix for "Halo is damaged and can't be opened" on macOS.
# This strips the quarantine flag that Gatekeeper puts on unsigned apps.
# Run this ONCE — after the first launch Halo works normally.

APP="/Applications/Halo.app"

if [ ! -d "$APP" ]; then
  echo "❌ Halo.app not found in /Applications."
  echo "   Please drag Halo.app from the DMG into your Applications folder first."
  echo ""
  read -p "Press Enter to close..."
  exit 1
fi

echo "🔧 Removing quarantine flag from Halo.app..."
xattr -cr "$APP"

if [ $? -eq 0 ]; then
  echo "✅ Done! Halo is ready to use."
  echo ""
  echo "   You can now open Halo normally."
  echo "   This fix only needs to be run once."
else
  echo "❌ Something went wrong. Try running this command in Terminal:"
  echo "   xattr -cr /Applications/Halo.app"
fi

echo ""
read -p "Press Enter to close..."
