set -u
OUT=/Users/admin/out
mkdir -p $OUT
rm -f $OUT/pos-$1.json
TIP_OUT=$OUT /Users/admin/Electron.app/Contents/MacOS/Electron /Users/admin/tipapp --case=$1 > $OUT/electron-$1-$2.log 2>&1 &
EPID=$!
for i in {1..60}; do
  [ -f $OUT/pos-$1.json ] && break
  sleep 0.5
done
cat $OUT/pos-$1.json
echo
/usr/bin/osascript -l JavaScript /Users/admin/kit/drive.js $OUT/pos-$1.json $OUT/$1-$2-$5 $2 ${3:-8} ${4:-none} > $OUT/log-$1-$2-$5.json 2>&1
cat $OUT/log-$1-$2-$5.json
kill $EPID
sleep 1
mkdir -p "/Volumes/My Shared Files/kit/out"
cp $OUT/* "/Volumes/My Shared Files/kit/out/"
