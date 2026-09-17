#!/bin/bash
# Double-click to remove Arrow Switch from Premiere Pro.
osascript -e 'do shell script "rm -rf \"/Library/Application Support/Adobe/CEP/extensions/com.arrow.switch\"; rm -rf \"/Library/Application Support/Adobe/CEP/extensions/com.arrow.autocut\"; pkgutil --forget com.arrow.switch.pkg >/dev/null 2>&1; pkgutil --forget com.arrow.autocut.pkg >/dev/null 2>&1; true" with administrator privileges' \
  && osascript -e 'display dialog "Arrow Switch was removed. Restart Premiere Pro to finish." buttons {"OK"} default button 1 with title "Arrow Switch"'
