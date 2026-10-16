DB='/Library/Application Support/com.apple.TCC/TCC.db'
sudo -n true && echo sudo-ok
sqlite3 "$DB" '.schema access'
NOW=$(date +%s)
for svc in kTCCServiceAccessibility kTCCServiceScreenCapture kTCCServicePostEvent; do
  for cl in /usr/libexec/sshd-keygen-wrapper /usr/libexec/sshd-session; do
    sudo -n sqlite3 "$DB" "INSERT OR REPLACE INTO access (service,client,client_type,auth_value,auth_reason,auth_version,indirect_object_identifier,flags,last_modified,last_reminded) VALUES ('$svc','$cl',1,2,4,1,'UNUSED',0,$NOW,$NOW)"
  done
  sudo -n sqlite3 "$DB" "INSERT OR REPLACE INTO access (service,client,client_type,auth_value,auth_reason,auth_version,indirect_object_identifier,flags,last_modified,last_reminded) VALUES ('$svc','com.apple.sshd-session',0,2,4,1,'UNUSED',0,$NOW,$NOW)"
done
sqlite3 "$DB" 'select service,client,client_type,auth_value from access'
sudo -n killall tccd
pkill universalAccessAuthWarn
echo tcc-done
