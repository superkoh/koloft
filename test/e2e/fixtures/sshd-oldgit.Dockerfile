FROM alpine:3.13
RUN apk add --no-cache openssh-server git tmux rsync bash \
 && printf '%s\n' \
    'HostKey /etc/ssh/ssh_host_ed25519_key' \
    'PermitRootLogin no' \
    'PubkeyAuthentication yes' \
    'PasswordAuthentication no' \
    'PrintMotd no' \
    'AllowTcpForwarding yes' \
    > /etc/ssh/sshd_config \
 && adduser -D -s /bin/sh kuser \
 && sed -i 's/^kuser:!/kuser:*/' /etc/shadow \
 && mkdir /home/kuser/proj \
 && printf '# Lab project\n\nkoloft-ssh-lab marker for kuser.\n' > /home/kuser/proj/README.md \
 && chown -R kuser:kuser /home/kuser/proj
CMD ["/bin/sh", "-c", "ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key && mkdir -p /home/kuser/.ssh && printf '%s\\n' \"$LAB_PUBKEY\" > /home/kuser/.ssh/authorized_keys && chown -R kuser:kuser /home/kuser/.ssh && chmod 700 /home/kuser/.ssh && chmod 600 /home/kuser/.ssh/authorized_keys && exec /usr/sbin/sshd -D -e"]
