const output = document.createElement('p');
output.style = 'background:white;color:black;padding:8px';
output.textContent = '正在初始化回放引擎……';
document.body.prepend(output);
(async () => {
    const cc = await System.import('cc');
    await cc.game.init({ settingsPath: 'src/replay-settings.json', trace: false });
    await cc.game.run(); cc.game.pause();
    cc.director.runSceneImmediate(new cc.Scene('Empty replay host'));
    output.textContent = 'Trace 回放 v2 · 请同时选择 trace.txt 和 trace.bin。后台记录仅属于当前浏览器；从内置浏览器换到 Chrome 时请导入两文件。点击 API 查看参数／返回值；跳转执行到该条，调试下一条进入 DevTools。';
    cc.createSceneTracePanel();
})().catch((error) => { output.textContent = String(error.stack || error); });
