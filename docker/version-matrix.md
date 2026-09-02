# Cocos Engine Docker 版本矩阵

| 目标 | 镜像 | Node | JDK | Android SDK | Android NDK | CMake | 默认构建入口 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Cocos 2.4 Engine | `cocos-dev:2.4` | `12.22.12` | 无默认依赖 | 默认不安装 | 默认不安装 | 系统工具链 | `npx gulp build` |
| Cocos 3.8 Engine | `cocos-dev:3.8` | `18.17.0` | `17` | 默认不安装，可选 `35` | 可选 `25.2.9519653` | 可选 `3.22.1` | `npm run build` |
| Cocos 4.0 Engine | `cocos-dev:4.0` | `18.17.0` | `17` | 默认不安装，可选 `35` | 可选 `26.3.11579264` | 可选 `3.27.7` | `npm run build` |

## 源码目录建议

```text
/Users/libin/cocos4                 4.0 当前仓库
/Users/libin/cocos-engine           3.8.9 当前分支
/Users/libin/cocos-engine-2.4.16    2.4.16 worktree
```

## 默认归档范围

### 4.0 / 3.8

```text
bin/
DebugInfos.json
DebugInfos.d.ts
package.json
cc.config.json
cc.config.schema.json
README.md
README.zh-CN.md
LICENSE
```

`3.8` 额外包含：

```text
package-lock.json
```

### 2.4

```text
bin/
DebugInfos.json
package.json
README.md
EngineErrorMap.md
```

如需加入 `native/`、`editor/`、`templates/` 或其他平台资源，可通过 `.cocos-docker.env` 中的 `COCOS_<VERSION>_PACK_ENGINE_CMD` 覆盖。
