# koishi-plugin-cfmrmod

Koishi 插件：搜索 CurseForge / Modrinth / MCMod，并渲染图片卡片。

## 使用方法

### 指令
- `cf <关键词>`：默认搜索 CurseForge Mod
- `cf.mod/.pack/.resource/.shader/.plugin <关键词>`
- `mr <关键词>`：默认搜索 Modrinth Mod
- `mr.mod/.pack/.resource/.shader/.plugin <关键词>`
- `cnmc <关键词>`：默认搜索 MCMod Mod
- `cnmc.mod/.data/.pack/.tutorial/.author/.user <关键词>`
- `cf.help` / `mr.help` / `cnmc.help`

列表交互：输入序号查看，`n` 下一页，`p` 上一页，`q` 退出。

### 配置要点
- `prefixes`: 设置 `cf` / `mr` / `cnmc` 指令前缀
- `fontPath`: 中文字体路径
- `timeouts`: 搜索会话超时（毫秒）
- `debug`: 调试日志开关

## 项目特点
- 支持 CurseForge / Modrinth / MCMod 多平台搜索
- 结果以图片卡片形式展示
- 支持多类型内容（模组/整合包/教程/作者/用户等）
- 可配置前缀与超时等通用参数
