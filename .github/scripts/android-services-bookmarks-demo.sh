#!/usr/bin/env bash
# Temporary wrapper for the services-bookmarks verification run: puts a Chrome bookmark export in
# the emulator's Downloads (the BookmarksDemo driver picks it from the system document picker),
# runs the generic demo script with the BookmarksDemo driver, then pulls whatever the export step
# saved to Downloads so the artifact carries the Netscape file the app wrote.
set -uo pipefail

out=${DEMO_OUT:-artifacts/android-services-bookmarks-demo}
mkdir -p "$out"

adb wait-for-device
cat > /tmp/chrome-bookmarks.html <<'EOF'
<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
     It will be read and overwritten.
     DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="1700000100" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://example.com/" ADD_DATE="1700000010">Example Domain</A>
        <DT><H3 ADD_DATE="1700000020" LAST_MODIFIED="1700000090">Work</H3>
        <DL><p>
            <DT><H3 ADD_DATE="1700000030" LAST_MODIFIED="1700000080">Docs</H3>
            <DL><p>
                <DT><A HREF="https://developer.mozilla.org/" ADD_DATE="1700000040">MDN Web Docs</A>
                <DT><A HREF="https://www.electronjs.org/docs/latest" ADD_DATE="1700000050">Electron docs</A>
            </DL><p>
            <DT><A HREF="https://github.com/" ADD_DATE="1700000060">GitHub</A>
        </DL><p>
    </DL><p>
    <DT><H3 ADD_DATE="1700000070" LAST_MODIFIED="1700000100">Recipes</H3>
    <DL><p>
        <DT><A HREF="https://www.seriouseats.com/" ADD_DATE="1700000080">Serious Eats</A>
        <DT><A HREF="https://www.kingarthurbaking.com/recipes" ADD_DATE="1700000090">King Arthur Baking</A>
    </DL><p>
    <DT><A HREF="https://en.wikipedia.org/" ADD_DATE="1700000095">Wikipedia</A>
</DL><p>
EOF
adb push /tmp/chrome-bookmarks.html /sdcard/Download/chrome-bookmarks.html
adb shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Download/chrome-bookmarks.html || true

status=0
bash .github/scripts/android-gesture-demo.sh || status=$?

adb shell ls -la /sdcard/Download/ > "$out/downloads-listing.txt" 2>&1 || true
for name in $(adb shell ls /sdcard/Download/ | tr -d '\r' | grep -E '^zenium_bookmarks_.*\.html$'); do
  adb pull "/sdcard/Download/$name" "$out/$name" || true
done
if grep -ls "Exported by Zenium" "$out"/zenium_bookmarks_*.html > /dev/null 2>&1; then
  echo "export written by the app:"
  head -n 8 "$out"/zenium_bookmarks_*.html
else
  echo "::warning::no exported file with the Zenium header was found in Downloads"
fi
exit $status
