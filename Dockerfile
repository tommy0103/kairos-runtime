FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV BUN_INSTALL=/root/.bun
ENV PATH=/root/.bun/bin:/root/.cargo/bin:${PATH}
ARG APT_MIRROR=http://mirrors.tuna.tsinghua.edu.cn/debian

RUN set -eux; \
    rm -f /etc/apt/sources.list.d/debian.sources; \
    printf '%s\n' \
      "deb ${APT_MIRROR} bookworm main contrib non-free non-free-firmware" \
      "deb ${APT_MIRROR} bookworm-updates main contrib non-free non-free-firmware" \
      "deb ${APT_MIRROR}-security bookworm-security main contrib non-free non-free-firmware" \
      > /etc/apt/sources.list; \
    apt-get -o Acquire::Retries=5 update; \
    apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      build-essential \
      pkg-config \
      libssl-dev \
      libprotobuf-dev \
      protobuf-compiler \
      python3 \
      make \
      g++ \
      unzip; \
    rm -rf /var/lib/apt/lists/*

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Install Bun
RUN set -euo pipefail \
    && curl -fsSL https://bun.sh/install | bash \
    && /root/.bun/bin/bun --version \
    && ln -sf /root/.bun/bin/bun /usr/local/bin/bun \
    && /root/.bun/bin/bun install -g node-gyp typescript

# Install Rust toolchain for sandboxd
RUN set -euo pipefail \
    && curl -fsSL https://sh.rustup.rs | bash -s -- -y --profile minimal \
    && /root/.cargo/bin/rustc --version

WORKDIR /workspace

CMD ["bash"]
