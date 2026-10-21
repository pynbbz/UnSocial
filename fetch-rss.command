#!/bin/zsh

set -u

unsocial_executable="/Applications/UnSocial.app/Contents/MacOS/UnSocial"

if [[ ! -x "${unsocial_executable}" ]]; then
  print -u2 "UnSocial was not found in /Applications."
  read "?Press Return to close..."
  exit 1
fi

print "Refreshing UnSocial RSS feeds..."
print "When the feeds are ready, open or refresh your RSS reader."
print ""

"${unsocial_executable}" --fetch-and-serve
result=$?

if (( result == 0 )); then
  print ""
  print "The RSS reader retrieved every refreshed feed."
  /usr/bin/osascript -e 'display notification "The RSS reader retrieved every refreshed feed." with title "UnSocial RSS delivery complete"' >/dev/null
else
  print -u2 ""
  print -u2 "RSS refresh failed (exit code ${result})."
  /usr/bin/osascript -e 'display notification "Open the launcher window to see the error." with title "UnSocial RSS refresh failed"' >/dev/null
  read "?Press Return to close..."
fi

exit "${result}"
