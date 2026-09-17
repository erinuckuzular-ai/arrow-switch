#!/bin/bash
# Double-click to remove Arrow AutoCut from Premiere Pro.
osascript -e 'do shell script "rm -rf \"/Library/Application Support/Adobe/CEP/extensions/com.arrow.autocut\"; pkgutil --forget com.arrow.autocut.pkg >/dev/null 2>&1; true" with administrator privileges' \
  && osascript -e 'display dialog "Arrow AutoCut was removed. Restart Premiere Pro to finish." buttons {"OK"} default button 1 with title "Arrow AutoCut"'
