ARG BASE_IMAGE=ubuntu:22.04
FROM ${BASE_IMAGE}

ARG NODE_VERSION=12.22.12

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

ENV PATH=/opt/node/bin:${PATH}

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    unzip \
    xz-utils \
    git \
    python3 \
    python3-pip \
    python-is-python3 \
    build-essential \
    pkg-config \
    make \
    ccache \
    rsync \
    file \
    sudo \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

RUN arch="$(uname -m)" \
    && case "$arch" in \
      x86_64) node_arch="x64" ;; \
      aarch64) node_arch="arm64" ;; \
      *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" -o /tmp/node.tar.xz \
    && mkdir -p /opt/node \
    && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && npm config set fund false \
    && npm config set audit false \
    && npm install -g gulp-cli@2.3.0

COPY entrypoint.sh /usr/local/bin/cocos-docker-entrypoint
RUN chmod +x /usr/local/bin/cocos-docker-entrypoint

WORKDIR /workspace/cocos
ENTRYPOINT ["/usr/local/bin/cocos-docker-entrypoint"]
CMD ["bash"]
