ARG BASE_IMAGE=ubuntu:22.04
FROM ${BASE_IMAGE}

ARG NODE_VERSION=18.17.0
ARG INSTALL_ANDROID=false
ARG ANDROID_CMDLINE_TOOLS_VERSION=11076708
ARG ANDROID_PLATFORM_VERSION=35
ARG ANDROID_BUILD_TOOLS_VERSION=35.0.0
ARG ANDROID_NDK_VERSION=25.2.9519653
ARG CMAKE_VERSION=3.22.1

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64

ENV PATH=/opt/node/bin:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/emulator:${ANDROID_HOME}/build-tools/${ANDROID_BUILD_TOOLS_VERSION}:${PATH}

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
    openjdk-17-jdk \
    build-essential \
    pkg-config \
    make \
    ninja-build \
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
    && npm config set audit false

RUN if [ "${INSTALL_ANDROID}" = "true" ]; then \
      mkdir -p ${ANDROID_HOME}/cmdline-tools \
      && curl --retry 5 --retry-delay 3 --connect-timeout 30 -fsSL "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS_VERSION}_latest.zip" -o /tmp/android-tools.zip \
      && unzip -q /tmp/android-tools.zip -d /tmp/android-tools \
      && mv /tmp/android-tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest \
      && rm -rf /tmp/android-tools /tmp/android-tools.zip \
      && yes | sdkmanager --licenses >/dev/null \
      && sdkmanager \
        "platform-tools" \
        "platforms;android-${ANDROID_PLATFORM_VERSION}" \
        "build-tools;${ANDROID_BUILD_TOOLS_VERSION}" \
        "ndk;${ANDROID_NDK_VERSION}" \
        "cmake;${CMAKE_VERSION}" \
      && chmod -R a+rX ${ANDROID_HOME}; \
    else \
      mkdir -p ${ANDROID_HOME} \
      && echo "Skip Android SDK/NDK installation. Set COCOS_3_8_INSTALL_ANDROID=true to enable it."; \
    fi

COPY entrypoint.sh /usr/local/bin/cocos-docker-entrypoint
RUN chmod +x /usr/local/bin/cocos-docker-entrypoint

WORKDIR /workspace/cocos
ENTRYPOINT ["/usr/local/bin/cocos-docker-entrypoint"]
CMD ["bash"]
