FROM node:22-bookworm-slim
ENV LANG=C.UTF-8
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    openssh-server openssh-client tmux rsync git tcsh fish procps \
 && rm -rf /var/lib/apt/lists/*
RUN rm -f /etc/ssh/ssh_host_* \
 && sed -i 's/^session[[:space:]]*required[[:space:]]*pam_loginuid.so/session optional pam_loginuid.so/' /etc/pam.d/sshd \
 && printf '%s\n' \
    'HostKey /etc/ssh/ssh_host_ed25519_key' \
    'PermitRootLogin no' \
    'PubkeyAuthentication yes' \
    'PasswordAuthentication no' \
    'KbdInteractiveAuthentication no' \
    'UsePAM yes' \
    'X11Forwarding no' \
    'PrintMotd no' \
    'AcceptEnv LANG LC_*' \
    'Subsystem sftp /usr/lib/openssh/sftp-server' \
    'Match User puser' \
    '  PasswordAuthentication yes' \
    '  PubkeyAuthentication no' \
    'Match User muser' \
    '  MaxSessions 2' \
    > /etc/ssh/sshd_config
RUN useradd -m -s /bin/bash kuser \
 && useradd -m -s /bin/bash puser \
 && useradd -m -s /usr/bin/tcsh tuser \
 && useradd -m -s /usr/bin/fish fuser \
 && useradd -m -s /bin/bash nuser \
 && useradd -m -s /bin/bash muser \
 && echo 'puser:koloft-pw' | chpasswd \
 && for u in kuser tuser fuser nuser muser; do usermod -p '*' "$u"; done \
 && for u in kuser puser tuser fuser nuser muser; do \
      mkdir "/home/$u/proj" \
      && printf '# Lab project\n\nkoloft-ssh-lab marker for %s.\n' "$u" > "/home/$u/proj/README.md" \
      && chown -R "$u:$u" "/home/$u/proj"; \
    done \
 && sed -i '1i echo "Welcome to the box"' /home/nuser/.bashrc
COPY fake-claude.js /usr/local/bin/claude
COPY sshd-entrypoint.sh /usr/local/sbin/sshd-entrypoint
RUN chmod 755 /usr/local/bin/claude /usr/local/sbin/sshd-entrypoint
EXPOSE 22
CMD ["/usr/local/sbin/sshd-entrypoint"]
