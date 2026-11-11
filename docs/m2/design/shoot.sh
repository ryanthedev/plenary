#!/bin/sh
# Re-take the mock's screenshots: sh docs/m2/design/shoot.sh  (needs Google Chrome; writes shots/*.png)
cd "$(dirname "$0")"
C="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
# Process rules (OFFICE.md): no ports and no pattern kills. Each Chrome runs with --screenshot (no debugging port,
# no server), its own throwaway profile, and its PID recorded in "${TMPDIR:-/tmp}/plenary-shoot-pids.log". Only that PID is killed, and only
# if it hangs past 30 s.
# Chrome won't size a window below ~500 px, so phone shots load phone.html (a 390 px iframe, centered) and crop
# the middle 390 px.
run_chrome() {  # out url width height
  prof=$(mktemp -d "${TMPDIR:-/tmp}/plenary-shot.XXXXXX")
  "$C" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --no-first-run \
    --user-data-dir="$prof" --window-size="$3,$4" --virtual-time-budget=1500 --screenshot="$1" "$2" >/dev/null 2>&1 &
  pid=$!
  echo "$(date +%H:%M:%S) $pid $1" >> "${TMPDIR:-/tmp}/plenary-shoot-pids.log"
  i=0; while kill -0 "$pid" 2>/dev/null; do i=$((i + 1)); [ "$i" -gt 300 ] && { kill "$pid"; echo "killed hung chrome $pid" >&2; break; }; sleep 0.1; done
  wait "$pid" 2>/dev/null
  rm -rf "$prof"
}
shot() {  # name width height query
  if [ "$2" -lt 600 ]; then
    q=$(printf %s "$4" | sed 's/&/%26/g; s/=/%3D/g')
    run_chrome "shots/$1.png" "file://$PWD/phone.html?bare=1&q=$q" 600 "$3"
    sips -c "$3" "$2" "shots/$1.png" >/dev/null
  else
    run_chrome "shots/$1.png" "file://$PWD/index.html?$4" "$2" "$3"
  fi
  echo "shots/$1.png $(sips -g pixelWidth -g pixelHeight "shots/$1.png" | awk '/pixel/{printf "%s ", $2}')"
}
mkdir -p shots
for theme in light dark; do
  for role in presenter annotator viewer; do
    shot "desk-$role-$theme" 1440 900 "role=$role&theme=$theme"
    shot "phone-$role-$theme" 390 844 "role=$role&theme=$theme"
  done
done
shot desk-presenter-tabs-dark 1440 900 "theme=dark&panel=tabs&tab=animate"
shot desk-thread-light 1440 900 "open=thread&drawer=comments"
shot desk-point-dark 1440 900 "role=annotator&theme=dark&open=point"
shot desk-resolved-light 1440 900 "role=viewer&open=resolved"
shot desk-viewer-thread-light 1440 900 "role=viewer&open=thread"
shot desk-viewer-reconnecting-dark 1440 900 "role=viewer&theme=dark&conn=reconnecting"
shot phone-viewer-offline-light 390 844 "role=viewer&conn=offline"
shot desk-readonly-mermaid-light 1440 900 "conn=readonly&open=mermaid&drawer=notes"
shot desk-emote-light 1440 900 "role=annotator&open=emote"
shot desk-mermaid-light 1440 900 "open=mermaid"
shot desk-export-dark 1440 900 "theme=dark&open=export"
shot desk-reconnecting-light 1440 900 "conn=reconnecting"
shot desk-offline-dark 1440 900 "role=annotator&theme=dark&conn=offline"
shot desk-readonly-light 1440 900 "conn=readonly"
shot desk-sources-light 1440 900 "src=1&drawer=notes"
shot phone-sheet-panel-light 390 844 "sheet=panel"
shot phone-sheet-tools-dark 390 844 "theme=dark&sheet=tools"
shot phone-sheet-notes-light 390 844 "role=annotator&sheet=notes"
shot phone-thread-dark 390 844 "theme=dark&open=thread"
shot phone-offline-light 390 844 "conn=offline"
