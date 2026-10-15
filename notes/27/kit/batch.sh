set -u
R=/Users/admin/kit/runcase.sh
for spec in "$@"; do
  c=${spec%%:*}
  rest=${spec#*:}
  m=${rest%%:*}
  rest=${rest#*:}
  s=${rest%%:*}
  tag=${rest#*:}
  line=$(/bin/zsh $R $c $m 8 $s $tag | tail -1)
  echo "$c $m $s $tag $(echo $line | grep -o '"seq":"[YN]*"') notElectronFront=$(echo $line | grep -o '"front":"[^"]*"' | grep -vc Electron)"
done
