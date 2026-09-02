# Cocos Engine Docker 构建环境

当前 Docker 环境用于隔离不同 Cocos Engine 历史版本的构建工具链，并输出可给 Creator 配置为自定义引擎的完整引擎归档包。

## 支持版本

| 版本 | 复用镜像 | 复用构建逻辑 | 默认源码变量 | 默认构建命令 |
| --- | --- | --- | --- | --- |
| `4.0` | `cocos-dev:4.0` | `4.0` | `COCOS_4_0_SRC` | `npm run build` |
| `3.8.9` | `cocos-dev:3.8` | `3.8` | `COCOS_3_8_9_SRC` | `npm run build` |
| `3.8.7` | `cocos-dev:3.8` | `3.8` | `COCOS_3_8_7_SRC` | `npm run build` |
| `2.4.16` | `cocos-dev:2.4` | `2.4` | `COCOS_2_4_16_SRC` | `npx gulp build` |

`3.8.x` 会复用 `docker/3.8` 和 `cocos-dev:3.8`，`2.4.x` 会复用 `docker/2.4` 和 `cocos-dev:2.4`。输出目录仍按完整版本号区分，例如 `$OUTPUT_DIR/3.8.7/engine/`。

不支持在 Linux Docker 内直接打完整 Creator 桌面应用、macOS `.app/.dmg` 或 Windows 安装包。

## 引擎包内容

`pack <version> engine` / `auto-pack <version> engine` 输出的是完整引擎目录归档，不再只是 `bin/` 和少量配置文件。目标是让解压后的目录可以作为 Creator 的自定义引擎路径使用。

3.x / 4.x 默认包含：

```text
bin/
cocos/
native/
pal/
platforms/
editor/
external/
exports/
extensions/
scripts/
templates/
licenses/
@types/
DebugInfos.json
DebugInfos.d.ts
EngineErrorMap.md
package.json
package-lock.json
cc.config.json
cc.config.schema.json
README.md
README.zh-CN.md
LICENSE 或 LICENSE.md
tsconfig.json
predefine.ts
```

2.4.x 默认包含：

```text
bin/
cocos2d/
editor/
extensions/
external/
gulp/
licenses/
polyfill/
DebugInfos.json
EngineErrorMap.md
package.json
package-lock.json
README.md
api.d.ts
modules.json
gulpfile.js
index.js
extends.js
predefine.js
tsconfig.json
CHANGELOG.txt
AUTHORS.txt
```

默认排除：

```text
.git/
node_modules/
native/node_modules/
```

因此 `.tar.gz` 解压后包含源码、已构建 JS 引擎产物、native 相关目录、模板和编辑器相关目录，更适合交给 Creator 做项目构建。

## 初始化配置

```bash
cp env/.env.example .cocos-docker.env
```

当前本机推荐配置：

```bash
COCOS_4_0_SRC=/Users/libin/cocos4
COCOS_3_8_9_SRC=/Users/libin/cocos-engine
COCOS_3_8_7_SRC=/Users/libin/cocos-engine-3.8.7
COCOS_2_4_16_SRC=/Users/libin/cocos-engine-2.4.16
OUTPUT_DIR=/Users/libin/cocos-output
CACHE_DIR=/Users/libin/.cache/cocos-docker
```

`COCOS_3_8_7_SRC` 和 `COCOS_2_4_16_SRC` 可以通过 `git worktree` 从 `/Users/libin/cocos-engine` 对应 tag 创建。

## 固定路径

容器内统一路径：

```text
/workspace/cocos   当前版本源码
/workspace/output  当前版本输出目录
/workspace/cache   当前版本缓存目录
```

宿主机输出目录：

```text
$OUTPUT_DIR/<version>/engine/
```

## 构建 Cocos 4.0 引擎包

```bash
./tools/cocos-docker image 4.0
./tools/cocos-docker install 4.0
./tools/cocos-docker pack 4.0 engine
```

`pack 4.0 engine` 会在缺少 `native/external/emscripten/webgpu/glslang.js` 时自动执行：

```bash
npm run update:native-external
```

也可以手动提前初始化 native external：

```bash
./tools/cocos-docker init 4.0
```

## 构建 Cocos 3.8.x 引擎包

构建 3.8.9：

```bash
./tools/cocos-docker image 3.8
./tools/cocos-docker install 3.8.9
./tools/cocos-docker pack 3.8.9 engine
```

构建 3.8.7：

```bash
./tools/cocos-docker install 3.8.7
./tools/cocos-docker pack 3.8.7 engine
```

`3.8.7`、`3.8.9` 都复用 `cocos-dev:3.8` 镜像和 `docker/3.8` 构建逻辑。

`pack 3.8.x engine` 会在缺少 `native/external/emscripten/webgpu/glslang.js` 时自动执行：

```bash
cd native && npm install && npx gulp init
```

也可以手动提前初始化 native external：

```bash
./tools/cocos-docker init 3.8.9
./tools/cocos-docker init 3.8.7
```

## 构建 Cocos 2.4.x 引擎包

```bash
./tools/cocos-docker image 2.4
./tools/cocos-docker install 2.4.16
./tools/cocos-docker pack 2.4.16 engine
```

`2.4.16` 复用 `cocos-dev:2.4` 镜像和 `docker/2.4` 构建逻辑。

默认构建命令：

```bash
npx gulp build
```

`2.4.x` 没有 `native/external/emscripten/webgpu/glslang.js` 这套 WebGPU external。它依赖仓库内 `external/`，`pack 2.4.x engine` 会先检查：

```bash
external/box2d/box2d.js
```

缺失时会明确报错，需要换成完整的 `2.4.x` 引擎源码。

## 给其他开发者的完整使用流程

其他开发者有两种使用方式：

```text
方式 A：自己从 Dockerfile 构建 Docker 环境，然后构建引擎包。
方式 B：使用别人导出的 cocos-dev-*.tar 镜像，然后构建引擎包。
```

两种方式最后都会输出可给 Creator 配置为自定义引擎路径的完整引擎 `.tar.gz`。

## 方式 A：自己构建 Docker 环境并构建引擎

适用场景：没有现成的 `cocos-dev-*.tar`，或者希望自己重新生成 Docker 构建环境。

### 1. 准备目录

假设本机目录如下：

```text
/Users/other/cocos-docker-kit/        放 docker/、tools/、env/
/Users/other/cocos4/                  自己的 4.0 引擎源码
/Users/other/cocos-engine-3.8.9/      自己的 3.8.9 引擎源码
/Users/other/cocos-engine-3.8.7/      自己的 3.8.7 引擎源码
/Users/other/cocos-engine-2.4.16/     自己的 2.4.16 引擎源码
/Users/other/cocos-output/            输出目录
/Users/other/.cache/cocos-docker/     缓存目录
```

`cocos-docker-kit` 至少需要包含：

```text
docker/
tools/cocos-docker
env/.env.example
```

### 2. 创建配置文件

```bash
cd /Users/other/cocos-docker-kit
cp env/.env.example .cocos-docker.env
```

修改 `.cocos-docker.env`：

```bash
COCOS_4_0_SRC=/Users/other/cocos4
COCOS_3_8_9_SRC=/Users/other/cocos-engine-3.8.9
COCOS_3_8_7_SRC=/Users/other/cocos-engine-3.8.7
COCOS_2_4_16_SRC=/Users/other/cocos-engine-2.4.16

OUTPUT_DIR=/Users/other/cocos-output
CACHE_DIR=/Users/other/.cache/cocos-docker
```

如果只构建某一个版本，只需要保留对应版本的 `COCOS_xxx_SRC`、`OUTPUT_DIR`、`CACHE_DIR`。

### 3. 构建 Docker 镜像

按需要构建对应版本族镜像：

```bash
./tools/cocos-docker image 4.0
./tools/cocos-docker image 3.8
./tools/cocos-docker image 2.4
```

对应关系：

```text
4.0 / 4.0.x    -> cocos-dev:4.0
3.8.x          -> cocos-dev:3.8
2.4.x          -> cocos-dev:2.4
```

例如 `3.8.7` 和 `3.8.9` 都只需要构建一次 `cocos-dev:3.8`。

确认镜像：

```bash
docker images | grep cocos-dev
```

### 4. 构建引擎包

推荐直接用 `auto-pack`：

```bash
./tools/cocos-docker auto-pack 4.0 engine
./tools/cocos-docker auto-pack 3.8.9 engine
./tools/cocos-docker auto-pack 3.8.7 engine
./tools/cocos-docker auto-pack 2.4.16 engine
```

`auto-pack` 会自动：

```text
1. 检查 .cocos-docker.env
2. 检查 Docker 镜像是否存在
3. 检查 node_modules 是否已安装
4. 未安装依赖时自动执行 install
5. 执行引擎构建
6. 打包完整引擎目录
```

输出目录：

```text
$OUTPUT_DIR/<version>/engine/*.tar.gz
```

例如：

```text
/Users/other/cocos-output/3.8.7/engine/cocos-engine-3.8.7-YYYYMMDD-HHMMSS.tar.gz
```

这个 `.tar.gz` 解压后就是给 Creator 使用的自定义引擎目录。

## 方式 B：使用已导出的 Docker 镜像构建引擎包

这一节描述别人拿到你保存好的 Docker 镜像后，如何从导入镜像一直到输出自己的引擎包。

### 你需要交付给对方的内容

```text
cocos-dev-4.0.tar          可选，需要构建 4.0 时提供
cocos-dev-3.8.tar          可选，需要构建 3.8 时提供
cocos-dev-2.4.tar          可选，需要构建 2.4 时提供
docker/                    Dockerfile 和版本配置
tools/cocos-docker         构建脚本
env/.env.example           配置模板
```

镜像导出命令：

```bash
docker save cocos-dev:4.0 -o cocos-dev-4.0.tar
docker save cocos-dev:3.8 -o cocos-dev-3.8.tar
docker save cocos-dev:2.4 -o cocos-dev-2.4.tar
```

注意：`cocos-dev-*.tar` 只包含构建环境，例如 Ubuntu、Node、npm、Python、构建工具链以及可选 Android SDK/NDK；不包含你的引擎源码，也不包含已经构建出的 engine 产物。

### 对方需要准备的内容

```text
Docker Desktop / Docker Engine
你的 cocos-dev-*.tar 镜像包
对应版本的 Cocos 引擎源码
本 Docker 构建脚本目录
```

例如对方本机目录如下：

```text
/Users/other/cocos-docker-kit/        放 docker/、tools/、env/ 和 cocos-dev-*.tar
/Users/other/cocos4/                  对方自己的 4.0 引擎源码
/Users/other/cocos-engine-3.8.9/      对方自己的 3.8.9 引擎源码
/Users/other/cocos-engine-3.8.7/      对方自己的 3.8.7 引擎源码
/Users/other/cocos-engine-2.4.16/     对方自己的 2.4.16 引擎源码
/Users/other/cocos-output/            输出目录
/Users/other/.cache/cocos-docker/     缓存目录
```

### 1. 导入 Docker 镜像

进入包含 `cocos-dev-*.tar` 的目录：

```bash
cd /Users/other/cocos-docker-kit
```

按需导入镜像：

```bash
docker load -i cocos-dev-4.0.tar
docker load -i cocos-dev-3.8.tar
docker load -i cocos-dev-2.4.tar
```

确认镜像已导入：

```bash
docker images | grep cocos-dev
```

应该能看到：

```text
cocos-dev   4.0
cocos-dev   3.8
cocos-dev   2.4
```

### 2. 创建配置文件

```bash
cp env/.env.example .cocos-docker.env
```

然后修改 `.cocos-docker.env`：

```bash
COCOS_4_0_SRC=/Users/other/cocos4
COCOS_3_8_9_SRC=/Users/other/cocos-engine-3.8.9
COCOS_3_8_7_SRC=/Users/other/cocos-engine-3.8.7
COCOS_2_4_16_SRC=/Users/other/cocos-engine-2.4.16
OUTPUT_DIR=/Users/other/cocos-output
CACHE_DIR=/Users/other/.cache/cocos-docker

COCOS_4_0_IMAGE=cocos-dev:4.0
COCOS_3_8_IMAGE=cocos-dev:3.8
COCOS_2_4_IMAGE=cocos-dev:2.4
```

如果只构建某一个版本，只需要配置对应版本的源码路径和镜像名。

### 3. 一键构建并输出引擎包

推荐使用 `auto-pack`，它会自动判断并跳过已经完成的步骤：

```bash
./tools/cocos-docker auto-pack 4.0 engine cocos-dev-4.0.tar
./tools/cocos-docker auto-pack 3.8.9 engine cocos-dev-3.8.tar
./tools/cocos-docker auto-pack 3.8.7 engine cocos-dev-3.8.tar
./tools/cocos-docker auto-pack 2.4.16 engine cocos-dev-2.4.tar
```

`auto-pack` 会按顺序执行：

```text
1. 检查 .cocos-docker.env 配置
2. 检查 Docker 镜像是否已存在
   - 已存在：跳过 docker load
   - 不存在：从传入的 cocos-dev-*.tar 执行 docker load
3. 检查当前版本的 node_modules 是否已安装
   - 已安装：跳过 install
   - 未安装：自动执行 install
4. 执行 pack <version> engine
5. 输出 engine tar.gz
```

如果镜像 `.tar` 文件就在当前目录，也可以省略第三个参数，默认使用：

```text
cocos-dev-<version-family>.tar
```

例如：

```bash
./tools/cocos-docker auto-pack 3.8.7 engine
```

### 4. 手动分步构建

如果需要排查问题，也可以手动执行：

```bash
./tools/cocos-docker doctor 4.0
./tools/cocos-docker install 4.0
./tools/cocos-docker pack 4.0 engine
```

`install` 只需要在首次构建某个源码目录、删除 `node_modules`、切换依赖或依赖报错时重新执行。

构建完成后，输出文件位于：

```text
$OUTPUT_DIR/4.0/engine/*.tar.gz
$OUTPUT_DIR/3.8.9/engine/*.tar.gz
$OUTPUT_DIR/3.8.7/engine/*.tar.gz
$OUTPUT_DIR/2.4.16/engine/*.tar.gz
```

按照上面的示例路径，实际输出类似：

```text
/Users/other/cocos-output/4.0/engine/cocos-engine-4.0-YYYYMMDD-HHMMSS.tar.gz
/Users/other/cocos-output/3.8.9/engine/cocos-engine-3.8.9-YYYYMMDD-HHMMSS.tar.gz
/Users/other/cocos-output/3.8.7/engine/cocos-engine-3.8.7-YYYYMMDD-HHMMSS.tar.gz
/Users/other/cocos-output/2.4.16/engine/cocos-engine-2.4.16-YYYYMMDD-HHMMSS.tar.gz
```

这些 `.tar.gz` 就是最终可交付的引擎包。解压后应得到一个完整引擎目录，Creator 侧把自定义引擎路径指向该解压目录即可。

### 5. 单版本最小示例

如果对方只构建 4.0，完整流程如下：

```bash
cd /Users/other/cocos-docker-kit
docker load -i cocos-dev-4.0.tar
cp env/.env.example .cocos-docker.env
```

编辑 `.cocos-docker.env`：

```bash
COCOS_4_0_SRC=/Users/other/cocos4
OUTPUT_DIR=/Users/other/cocos-output
CACHE_DIR=/Users/other/.cache/cocos-docker
COCOS_4_0_IMAGE=cocos-dev:4.0
```

执行一键构建：

```bash
./tools/cocos-docker auto-pack 4.0 engine cocos-dev-4.0.tar
```

如果后续只是修改引擎源码并重新打包，继续执行同一条命令即可。镜像已存在时会跳过 `docker load`，依赖已安装时会跳过 `install`。

最终输出：

```text
/Users/other/cocos-output/4.0/engine/*.tar.gz
```

## 添加新的引擎版本

新增引擎版本分两类。

### 添加同一大版本/小版本下的补丁版本

例如新增 `3.8.10`，它和 `3.8.7`、`3.8.9` 一样复用 `3.8` 构建环境。

1. 准备源码目录：

```bash
git -C /Users/libin/cocos-engine worktree add /Users/libin/cocos-engine-3.8.10 3.8.10
```

2. 在 `.cocos-docker.env` 增加源码路径：

```bash
COCOS_3_8_10_SRC=/Users/libin/cocos-engine-3.8.10
```

3. 直接构建：

```bash
./tools/cocos-docker auto-pack 3.8.10 engine cocos-dev-3.8.tar
```

或者 `.tar` 在当前目录时省略：

```bash
./tools/cocos-docker auto-pack 3.8.10 engine
```

输出目录：

```text
$OUTPUT_DIR/3.8.10/engine/
```

新增 `2.4.x` 也一样，只需要增加：

```bash
COCOS_2_4_x_SRC=/path/to/cocos-engine-2.4.x
```

然后执行：

```bash
./tools/cocos-docker auto-pack 2.4.x engine cocos-dev-2.4.tar
```

变量名规则：版本号中的 `.` 和 `-` 都替换成 `_`，并加上 `COCOS_` 前缀和 `_SRC` 后缀。例如：

```text
3.8.10  -> COCOS_3_8_10_SRC
2.4.16  -> COCOS_2_4_16_SRC
4.0     -> COCOS_4_0_SRC
```

同一版本族下的补丁版本默认复用版本族配置：

```text
3.8.x -> COCOS_3_8_IMAGE / docker/3.8 / cocos-dev-3.8.tar
2.4.x -> COCOS_2_4_IMAGE / docker/2.4 / cocos-dev-2.4.tar
```

如果某个补丁版本需要特殊命令，可以单独覆盖完整版本变量，例如：

```bash
COCOS_3_8_10_INSTALL_CMD='npm ci'
COCOS_3_8_10_PACK_ENGINE_CMD='npm run build && mkdir -p /workspace/output/engine && tar --exclude="./node_modules" --exclude="./native/node_modules" --exclude="./.git" -czf /workspace/output/engine/custom-3.8.10.tar.gz bin cocos native pal platforms editor external exports extensions scripts templates licenses @types DebugInfos.json DebugInfos.d.ts EngineErrorMap.md package.json package-lock.json cc.config.json cc.config.schema.json README.md README.zh-CN.md LICENSE.md tsconfig.json predefine.ts'
```

### 添加新的版本族

如果新增的是新的版本族，例如 `3.7.x`、`3.9.x`、`4.1.x`，通常需要额外增加：

```text
docker/<version-family>/Dockerfile
docker/<version-family>/entrypoint.sh
docker/<version-family>/versions.env
```

并在 `tools/cocos-docker` 的 `version_family()` 和 `version_cmd()` 中补充对应构建逻辑。只有当它和现有 `2.4`、`3.8`、`4.0` 构建流程完全兼容时，才建议直接映射到已有版本族。

## 常用检查命令

```bash
./tools/cocos-docker doctor 4.0
./tools/cocos-docker doctor 3.8.9
./tools/cocos-docker doctor 3.8.7
./tools/cocos-docker doctor 2.4.16
```

进入容器：

```bash
./tools/cocos-docker shell 3.8.9
./tools/cocos-docker shell 3.8.7
./tools/cocos-docker shell 2.4.16
```

直接执行命令：

```bash
./tools/cocos-docker run 3.8.9 -- node -v
./tools/cocos-docker run 3.8.7 -- node -v
./tools/cocos-docker run 2.4.16 -- node -v
```

## Android 工具链

默认跳过 Android SDK/NDK 下载，先保证引擎构建可用。

如后续需要 Android Native 构建，可在 `.cocos-docker.env` 打开：

```bash
COCOS_3_8_INSTALL_ANDROID=true
COCOS_4_0_INSTALL_ANDROID=true
```

然后重新构建对应镜像。

## 自定义命令

每个版本的命令都可以在 `.cocos-docker.env` 覆盖：

```bash
COCOS_3_8_BUILD_ENGINE_CMD='npm run build:dev'
COCOS_2_4_BUILD_ENGINE_CMD='npx gulp build-html5'
COCOS_2_4_PACK_ENGINE_CMD='npx gulp build && mkdir -p /workspace/output/engine && tar --exclude="./node_modules" --exclude="./.git" -czf /workspace/output/engine/custom.tar.gz bin cocos2d editor extensions external gulp licenses polyfill DebugInfos.json EngineErrorMap.md package.json package-lock.json README.md api.d.ts modules.json gulpfile.js index.js extends.js predefine.js tsconfig.json CHANGELOG.txt AUTHORS.txt'
```
