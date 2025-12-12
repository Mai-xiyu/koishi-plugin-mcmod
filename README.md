# koishi-plugin-mcmod

[![npm](https://img.shields.io/npm/v/koishi-plugin-mcmod.svg?color=blue)](https://www.npmjs.com/package/koishi-plugin-mcmod)
[![Koishi](https://img.shields.io/badge/Koishi-Plugin-%234985ea)](https://koishi.chat)
![Node](https://img.shields.io/badge/node-%3E=14-green)
![License](https://img.shields.io/badge/license-MIT-green)
![Platform](https://img.shields.io/badge/platform-qq%20discord%20telegram-blue)

**Koishi 插件：从 mcmod.cn 搜索模组、整合包、教程、作者等内容，并生成高质量图片卡片。**

适用于 QQ、QQ 频道、Discord、Telegram 等多平台机器人。

---

## 功能特性

* 搜索 mcmod.cn / center.mcmod.cn 内容：

  * 模组（Mod）
  * 整合包（Modpack）
  * 资料 / 百科条目
  * 教程文章
  * 作者主页 / 贡献者信息

* 提供交互式搜索列表与分页浏览。

* 自动生成高清卡片（基于 @napi-rs/canvas）：

  * 模组卡片：封面、标签、作者、统计、版本、简介
  * 教程卡片：标题、目录、正文、插图
  * 作者卡片：头像、团队、代表项目、合作作者、简介

* 支持自动 Cookie 刷新（可选 `cookie-manager.js`）。

* 自动探测可用中文字体，避免乱码。

---

## 安装

```bash
npm install koishi-plugin-mcmod
```

启用后即可使用。

---

## 用法

### 搜索（自动识别类型）

```
mcmod <关键词>
```

支持翻页与序号选择。

### 指定类型搜索

```
mcmod mod <关键词>
mcmod pack <关键词>
mcmod data <关键词>
mcmod tutorial <关键词>
mcmod author <关键词>
```

### URL 直查

```
mcmod url <mcmod.cn 链接>
```

---

## 可选配置

| 选项       | 类型     | 说明                    |
| -------- | ------ | --------------------- |
| fontPath | string | 自定义字体路径，未设置时自动匹配系统字体。 |

可增加 `cookie-manager.js` 支持长期稳定 Cookie。

---

## 许可

MIT License
作者：**mai_xiyu**

