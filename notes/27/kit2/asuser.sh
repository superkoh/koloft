J="$1"
shift
sudo -n launchctl asuser $(id -u admin) sudo -n -u admin HOME=/Users/admin USER=admin /bin/zsh "/Volumes/My Shared Files/probe/kit/$J" "$@"
