# 关键事项
- UI能够复用DSH就复用，不能复用就照着风格做成一模一样
- 引擎和后端尽量复用DSH组件
- 所有代码参考DSH的代码风格
- 不要创建分支，直接在main分支上开发
- 永远用中文回答
- DSH 源码路径 = `D:\projects-code\llm\sandore`

# 测试启动（开发/生产端口隔离）
- 生产实例（`dsh --profile web`，端口 3080）不加载 sandore 插件，保持干净
- sandore 插件只挂载在开发 profile：`~/.dsh/profiles/dev/cordis.patch.yml`
- 测试实例用另一个端口启动：`dsh --profile dev --port 3090`，访问 http://127.0.0.1:3090
- 开发流程：改 sandore 代码 → 重启 dev 实例（3090）即可，生产实例完全不受影响
- 调插件配置直接编辑 `~/.dsh/profiles/dev/cordis.patch.yml`（只有 dev 实例会热重载）
- 若改动了 `~/.dsh/profiles/web/cordis.patch.yml`（生产层），会触发生产实例 HMR 重载、中断对话——不要往里插开发插件
