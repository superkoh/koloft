/usr/sbin/screencapture -x "/Volumes/My Shared Files/probe/kit/screen-$1.png"
echo "exit $?"
system_profiler SPDisplaysDataType | grep -i -E 'resolution|looks like'
