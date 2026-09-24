# Scene Trace：两文件录制与步进回放

当前版本提供微信小游戏／Web 的逐条日志，以及**基础 UI 和静态 MeshRenderer 范围**的两文件独立重建。
它还不是“所有引擎 API、任意完整游戏”的确定性录制器。请先核对下方覆盖范围。

## 快速验收

在引擎仓库执行：

```sh
node scripts/trace/build-demo.cjs /private/tmp/cocos-trace-demo
python3 -m http.server 8768 --bind 127.0.0.1 --directory /private/tmp/cocos-trace-demo
```

打开 http://127.0.0.1:8768 ，使用支持 WebGL2 的现代浏览器：

1. 点击“自动回放验收”：录制三帧，等待 Worker / IndexedDB 提交，再用另一个 Worker 读取 `trace.txt` 和 `trace.bin`，清空原场景后重建，检查文字、位置、颜色、缩放和纹理字节。结果应为 PASS。
2. 刷新页面，点击“恢复最近的后台记录”，验证记录不依赖原页面内存。
3. 点击“下一条指令”／“下一帧”。画布显示当前状态，面板显示调用参数、返回值、异常和差异；“节点与属性”显示节点数、组件数及属性快照。
4. 分别点击“保存 trace.txt”和“保存 trace.bin”。另一台机器运行同版本引擎后，同时选择这两个文件即可重建本示例。

示例使用真实 Node、Label、Sprite、Canvas、Camera 和 WebGL2。为了独立于 Creator 资源导入，它注册测试夹具效果和简单 UI 着色器；**不能用它证明项目摄像机投影、自定义材质或完整内置着色器正确**。视口尺寸和系统字体差异仍会影响画面。
构建工具不会清空输出目录，会覆盖同名演示文件。

## 空 trace.txt 开关

游戏运行时只能访问发布后的页面／小游戏代码包，不能直接读取 Creator 源项目目录。
本仓库附带一个构建扩展，将项目根目录的空文件转换为发布目录中的专用开关标记。
扩展使用 [Creator 构建扩展接口](https://docs.cocos.com/creator/3.8/manual/zh/editor/publish/custom-build-plugin.html)；需要先在项目中安装并启用一次：

```sh
node scripts/trace/install-creator-extension.cjs /absolute/path/to/game-project
```

在 Creator 扩展管理器中刷新并启用 `cocos-trace-marker`，然后：

1. 在**游戏项目根目录**创建空 `trace.txt`。
2. 使用当前修改后的自定义引擎重新构建 Web 或微信小游戏。
3. 运行构建结果。Web 会自动显示录制／导出面板。`game.init` 未显式传 `trace` 时，会检测发布根目录的开关，自动建立新录制目录／捕获 ID。
4. 删除源项目的空文件并重新构建即可关闭。构建扩展只删除自己生成的标记，拒绝覆盖已有录制文件。

也可直接在 Web 发布目录／小游戏代码包根目录放空 `trace.txt` 测试运行时接入。
**Creator 编辑器预览服务器的根目录映射尚未接入；构建扩展未在真实 Creator 构建进程／微信真机中验收。**
`trace: false` 禁用检测；显式 `trace: true`／配置对象保留旧版配置行为，不自动启用两文件存储。
Web 无开关时会产生一次检查请求，最多等待 1.5 秒；录制存储初始化失败不会阻止游戏启动。

自动录制从第一次场景启动完成后开始。加载、反序列化和此前的 onLoad 不在日志中。
跨场景时停止并保留当前录制。空文件自动录制最多 200000 条指令；手动录制默认 20000 条，可通过 maxCommands 调整，到上限停止，保留完整前缀。

## 保存与崩溃恢复

- 微信：同步追加到 `wx.env.USER_DATA_PATH/cocos-trace/<capture-id>/trace.txt` 和 `trace.bin`。方法执行前写 BEGIN，完成／抛异常后写 END。可从 `getSceneTraceCapture().location` 获取路径，再用开发者工具或项目自己的导出 UI 取出这两个文件。
- Web：后台 Worker 串行写 IndexedDB 数据库 `cocos-trace-v1`，可以跨刷新恢复并导出两文件。页面没有权限自动覆盖电脑项目根目录文件。Worker / IndexedDB 被 CSP 或浏览器禁用时会报告初始化失败。
- `getSceneTraceCapture().status` 显示 queued／committed／error。Web 的 committed 是收到事务完成确认的**存储块序号**，不是 API 指令编号。写队列上限 128 MiB，超过后报告保存失败。
- 微信同步 API 返回不等于操作系统 fsync；Web 方法执行不等待事务完成。**均不保证断电或整个宿主进程崩溃时最后一条已持久化**，尤其 Web 可能丢失尚未提交的尾部。
- 崩溃后读取已提交的完整行；忽略未完成末行及尚未发布引用的二进制尾部。有 BEGIN 无 END 的调用标为 incomplete，回放在该条停止。它是排查线索，不等于已证明的崩溃根因。
- 两文件使用同一捕获 ID 和资源 CRC32，拒绝混用／损坏。CRC32 用于检测意外损坏，不是安全签名。

手动录制两文件：

```ts
import { createSceneTraceArchiveCapture, startSceneTrace, stopSceneTrace } from 'cc';
const capture = await createSceneTraceArchiveCapture();
startSceneTrace({ archive: capture.writer, project: 'build-revision' });
// 触发问题……
stopSceneTrace();
const pair = await capture.read(); // 等待已排队写入；text 和 binary 可分别保存
```

每个 writer 只支持一段录制；再次录制应创建新 capture。写入失败不会替换游戏 API 的返回值或异常。
`traceRuntime.persistenceError` 是日志层错误，异步错误还需检查 capture.status.error。

## 回放组件

在专用调试场景的一个**根节点**添加 `Debug/TraceReplay`：

- `directory`：Web 为包含两文件的 HTTP(S) 目录 URL；微信为可读沙箱目录。Web 字符串路径不能绕过浏览器权限读取电脑文件夹，本地文件请用面板的文件选择器。
- `loadOnStart`：启动时自动加载；也可调用 `loadDirectory()` 或 `loadPair({text, binary})`。
- `stepCommand()`／`stepFrame()`：向前步进。
- `player.lastStep`：当前指令、原始结果、实际结果及错误；`inspect()`：节点树、数量和组件属性。
- `close()`：关闭步进会话，旧 player 失效。场景保持当前状态，加载下一次 trace 会重新创建起始场景。

组件将自身节点设为常驻节点，以便场景替换后继续控制。请把控制节点和游戏内容分开。
Web 可调用 `createSceneTracePanel()` 创建带导入、导出、步进及节点属性查看按钮的面板。
也可直接调用 `openSceneTraceArchive(text, binary)`，返回 `TracePlayer`。

重建模式校验引擎版本，在不运行项目脚本的情况下新建场景和支持的组件。
原项目自定义脚本使用 `TraceRecordedComponent` 占位，保留类型、enabled 和对象引用；不恢复脚本业务字段或执行其逻辑。
回放暂停 game/director、update、scheduler、physics，并按记录的 deferredDestroy 边界执行延迟销毁。
逐条渲染不会发送 director 的 BEFORE_COMMIT／BEFORE_RENDER／AFTER_RENDER 用户事件。
已有网络、Promise、setTimeout 等业务任务不会因暂停自动取消，因此应使用专用调试场景。

## 覆盖范围

**逐条录制**支持普通 Node 构造、常见变换／层级／显隐／排序、addComponent、destroy、组件 enabled，以及 `scene-trace.ts` 中列出的 UI setter／方法。
方法返回值、异常、帧边界、console.error、Web 和微信可注册的未捕获错误／未处理 rejection 被记录。
构造事件在构造完成后记录，因此不能捕获构造函数内部崩溃的 BEGIN。

**独立重建**当前支持：Node、UITransform、UIOpacity、Label（系统字体）、Sprite、Canvas、Camera、DirectionalLight、MeshRenderer、Button。
方向光包含继承的颜色／色温／静态设置、阴影属性以及 HDR／LDR 强度；回放构建需要启用 `3d` 引擎功能。旧 trace 没有记录方向光属性时会用默认值重建并显示警告，准确复现光照需更新录制端重新录制。起始场景的 SceneGlobals 数据配置一并保存；环境立方体贴图、烘焙探针等未支持资源仍会明确失败。
`trace.bin` 保存起始节点与组件属性，以及首次引用的 ImageAsset、Texture2D、普通 SpriteFrame 依赖和实际像素字节，以及静态 Mesh 的结构／顶点索引字节、Material 参数和 EffectAsset 着色器。
材质会保存第一次使用时的 Effect、宏、管线状态和属性；同名 Effect 与回放引擎已有版本不一致时拒绝加载。它们按不可变资源快照处理，录制中直接修改资源内部内容不受支持。
已进入动态合图的 SpriteFrame、压缩图、GPU-only 纹理、网格 SpriteFrame、动态网格更新、字体、CubeTexture 等其他资源类别会报告缺少适配。
起始快照存在不可序列化属性时拒绝独立重建，不静默当成完整场景。

**尚未覆盖**：所有引擎 API、instantiate／Prefab、自定义组件创建、未列出的内置组件独立恢复、普通字段写入、`node.position.x = ...` 原地修改、跨场景、场景全局配置的运行时修改、异步调度顺序、物理内部状态、网络／输入／随机数／时间来源、GPU 指令。反向步进通过重建初始场景再执行到目标位置实现，大记录回退会有等待时间。
没有经过挂钩接口的行为不会自动生成 unsupported 行；不应把“没有 unsupported”视为已经捕获一切。
对已挂钩接口中的未知参数／目标会记录 unsupported；回放遇到 incomplete、unsupported、异常或返回值差异时停止。
原始截图仅是可选证据，不是 GPU 状态恢复。

旧版 `startSceneTrace()`／`exportSceneTrace()`／`openSceneTrace(json, project)` 仍可用：默认 JSON 保存到 localStorage，依赖原始场景与 UUID 资源，不是两文件独立模式。重放前必须由项目重载相同检查点。

## 自动化回归

```sh
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/jest tests/trace tests/core/node.test.ts tests/ui/sprite.test.ts --runInBand
```

Jest 覆盖 API 语义、帧步进、崩溃断尾、资源校验、微信存储适配器、构建标记和独立场景／纹理重建。
微信文件接口在测试中使用模拟实现，不能等同于真机验证。浏览器验收使用真实 Worker、IndexedDB 与 WebGL2。


## 排查 Node.addComponent 的 Unsupported object

旧录制若显示 `Node.addComponent`、`args: []`、`Unsupported object: t`，其中 `t` 可能只是压缩后的构造名。
旧版会让返回值序列化错误覆盖参数错误，记录因此不足以识别要创建的组件；不能通过猜测类型或跳过该指令来修复回放。
需要更新录制端引擎、重新构建游戏并生成新的一对文件。新版用注册名／类 ID 保存支持的组件构造参数，并在 `argumentTypes`、`serializationErrors` 中分别保留参数类型及各阶段错误。
自定义组件动态创建仍需要适配，若新记录显示其注册名，不代表该组件已支持独立重建。

### NewProject_4 的 scene.scene 适配

该场景包含两个 Capsule MeshRenderer、DirectionalLight、Camera，以及 RandomSpheres 动态生成的球体和 HUD（Canvas／UITransform／Label／Sprite／Button）。补充静态网格、材质和 Effect 资源快照、MeshRenderer 材质赋值与场景环境配置恢复。业务脚本使用占位组件，回放其已记录的引擎调用。按帧步进仅在帧执行完成后绘制一次，逐指令步进仍逐条绘制。

Web 日志每次调用仍立即发送给 Worker；Worker 将已经排队的连续写入合并为最多 1024 个块的事务，提交后才确认 committed。没有等待凑批的定时器，尾部仍受异步持久化限制。

旧录制文件缺失网格／材质或组件参数时不能补出原始状态，需使用更新后的引擎重新构建并录制。

实际项目的隔离验收（不修改原项目）：

```sh
node scripts/trace/build-project-demo.cjs /Users/libin/NewProject_4 /private/tmp/scene-trace-project-check
python3 -m http.server 8774 --bind 127.0.0.1 --directory /private/tmp/scene-trace-project-check
```

`index.html` 加载发布场景，记录前三帧并校验回放；`replay.html` 在新页面提供两文件加载面板，保留内置引擎资源／渲染管线初始化，移除 main 和 resources bundle 预加载及原始场景启动。回放不运行原项目脚本。页面可下载两文件；点击“恢复最近的后台记录”从 IndexedDB 读取录制并从起始状态逐条／逐帧查看，也可加载别人提供的两文件。

此脚本针对当前 Creator SystemJS 发布结构。测试副本禁用外部 RuntimeBridge WebSocket；若当前引擎没有 WorkerPool 接口，会明确显示并将 RandomSpheres 切为 MAIN_THREAD。这验证球体的创建和呈现，不验证原 Worker 后端。当前 `trace_tool` 分支缺少该 demo 引用的 `getWorkerCapabilities` 等 WorkerPool 接口，原 mode=3 的运行仍需相匹配的 Worker 引擎模块。

本次 Web 验收：10000 个动态球体＋2 个 Capsule，共 10002 个 MeshRenderer；前三帧 100082 条指令，无 unsupported 或回放中止。同页回放的最终画布像素一致；新页面不加载 main/resources 及项目脚本也完成同份记录回放。验收使用 MAIN_THREAD；微信真机和原 Worker 模式未验收。

## 命令导航与调试

回放面板显示分页命令列表（每页 80 条），可按 API 名称或完整指令编号搜索。选择一条只显示详情，不改变场景。“跳转到所选指令”执行到该条之后；“运行到所选指令前”停在调用之前。编号从 0 开始。

- 上一条：回到当前已执行指令之前；上一帧：回到当前帧之前的最后状态，首帧之前为起始场景。
- 后退通过重建快照、重新执行前缀完成，包含节点创建／销毁；不是反向调用 setter。远距离后退仍有重建成本。
- 跳转每批最多执行 500 条、约 12 毫秒后让出主线程，最后绘制一次；单条 API 和起始快照重建本身不能被分割。
- 播放逐帧推进，暂停在当前帧跳转结束后生效。遇到错误或结果差异停止，不跨过错误。
- “设置／取消断点”在列表显示 ●，播放会停在该条执行前。再次播放可继续越过这个已命中的断点。

要调试实际引擎代码，请用 Chrome／Edge 打开回放网址，并打开开发者工具（F12，或 macOS 的 Command+Option+I）：

1. 加载两文件，选中有问题的指令，点“运行到所选指令前”。
2. 点“调试下一条”，会在 `TraceRuntime.execute` 中已解码参数、尚未调用 API 的位置触发 `debugger`。
3. 在 Scope 查看 `command`、`target`、`args`，单步进入 `api(target, args)`／构造工厂。`traceRuntime.replayDebugContext` 保存最近一次的目标、参数、结果或异常，重建场景时清空。
4. 勾选“异常／返回差异时进入调试器”可在回放异常、解码失败或返回不一致时进入 debugger。需要在抛出位置暂停，可再开启 DevTools 的“Pause on caught exceptions”，因为 Trace 会捕获引擎异常用于比对。

`build-project-demo.cjs` 生成未压缩引擎并保留 `cc.js.map`，包含 TypeScript 源码。浏览器必须启用 JavaScript source maps，不能关闭／忽略 debugger 断点。未打开 DevTools 时 `debugger` 通常不会暂停；面板断点仍可正常停止播放。

这里调试的是当前引擎执行录制指令时的状态，不能还原原游戏业务脚本调用栈、Worker 内部执行栈或远端崩溃时的内存。旧版 JSON 的后退需要调用方提供 `prepareReplay` 重载原始场景；两文件格式可直接重建。

`TraceReplay` 组件也提供异步 `seekCommand(index)`、`previousCommand()`、`previousFrame()`；`seekCommand(-1)` 返回起始快照。

## 构建裁剪与运行开关

Trace 是独立的 `scene-trace` 构建 feature，默认关闭。Creator 使用当前自定义引擎时，重启编辑器以重新加载引擎模块注册表，然后在“项目设置 → 引擎管理器 → 功能裁剪”对应配置中勾选“场景 Trace（诊断录制）”，再重新构建。仅手改 includeModules 而没有编辑器模块注册表时，Creator 会过滤掉此项。正常发布的 features 不包含它时，`SCENE_TRACE=false`，核心仅有受编译常量保护的桥接点；不会导入录制器、存储 Worker、面板或 TraceReplay 组件，也不会探测 trace.txt。
诊断构建需要在引擎构建 features 中包含 `scene-trace`，随后用 trace.txt 或 game.init 的 trace 选项启动录制。仅将运行时 `trace` 设为 false 不会裁掉已构建进去的模块。`scripts/trace/build-demo.cjs` 和 `build-project-demo.cjs` 会主动启用这个模块。Creator 的 marker 扩展仅负责复制开关文件，不能代替引擎模块选择。

命令列表支持输入页码后点“跳转页码”或按 Enter。每一帧的第一条指令显示红色并标记“开始”；分页或搜索不会将普通行误标为帧首。

## 全 API 覆盖进度

当前仍是节点、选定 UI 和 3D 组件的诊断子集，不能宣称全 API 已完成。`node scripts/trace/audit-api.cjs /private/tmp/trace-api-inventory.json` 可生成源码接口候选清单（包含内部导出类，不等同于 cc 对外 API 数量）。逐项验收必须同时覆盖调用录制、参数/返回值编码、初始状态及资源恢复、真实场景回放。普通字段原地修改、回调及 Promise 完成、动态资源、物理/动画内部状态、网络/输入和业务脚本执行链仍需专项适配；不能通过移除白名单或静默跳过错误来宣布支持。
