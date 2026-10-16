set -u
R="/Volumes/My Shared Files/probe/kit/runcase.sh"
for tag in r1 r2; do
  for c in f0 g0 h0; do
    line=$(/bin/zsh "$R" $c centre 8 tips $tag click | tail -1)
    echo "$c $tag $(echo $line | grep -o '"seq":"[YN]*"') $(echo $line | grep -o '"click":"[^"]*"') notElectronFront=$(echo $line | grep -o '"front":"[^"]*"' | grep -vc Electron)"
  done
done
