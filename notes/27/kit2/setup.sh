set -u
S="/Volumes/My Shared Files/probe"
rm -rf /Users/admin/Electron.app /Users/admin/tipapp /Users/admin/kit
cp -R "$S/electron/Electron.app" /Users/admin/Electron.app
cp -R "$S/kit/app" /Users/admin/tipapp
mkdir -p /Users/admin/kit
cp "$S/kit/drive.js" "$S/kit/runcase.sh" /Users/admin/kit/
codesign --force --deep --sign - /Users/admin/Electron.app
sw_vers
system_profiler SPDisplaysDataType | grep -i resolution
echo setup-done
