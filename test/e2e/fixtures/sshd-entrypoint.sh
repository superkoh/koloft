#!/bin/sh
set -e
mkdir -p /run/sshd
rm -f /etc/ssh/ssh_host_*
ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key
for u in kuser tuser fuser nuser muser; do
  d="/home/$u/.ssh"
  mkdir -p "$d"
  printf '%s\n' "$LAB_PUBKEY" > "$d/authorized_keys"
  chown -R "$u:$u" "$d"
  chmod 700 "$d"
  chmod 600 "$d/authorized_keys"
done
exec /usr/sbin/sshd -D -e
