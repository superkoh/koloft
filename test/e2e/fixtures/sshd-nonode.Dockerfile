FROM debian:bookworm-slim
ENV LANG=C.UTF-8
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    openssh-server tmux rsync git procps curl ca-certificates \
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
    'PrintMotd no' \
    'AllowTcpForwarding yes' \
    > /etc/ssh/sshd_config \
 && useradd -m -s /bin/bash kuser \
 && usermod -p '*' kuser \
 && mkdir /home/kuser/proj \
 && printf '# Lab project\n\nkoloft-ssh-lab marker for kuser.\n' > /home/kuser/proj/README.md \
 && printf '{\n  "hasCompletedOnboarding": true\n}\n' > /home/kuser/.claude.json \
 && chown -R kuser:kuser /home/kuser/proj /home/kuser/.claude.json
COPY fake-claude.js /usr/local/bin/claude
RUN chmod 755 /usr/local/bin/claude
CMD ["/bin/sh", "-c", "mkdir -p /run/sshd && ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key && mkdir -p /home/kuser/.ssh && printf '%s\\n' \"$LAB_PUBKEY\" > /home/kuser/.ssh/authorized_keys && chown -R kuser:kuser /home/kuser/.ssh && chmod 700 /home/kuser/.ssh && chmod 600 /home/kuser/.ssh/authorized_keys && exec /usr/sbin/sshd -D -e"]
