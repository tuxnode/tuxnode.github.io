# 博客特性文档

Geek's Tech Base - 基于 Hugo 的技术博客，专注于底层系统、计算机架构与安全研究。

## 技术栈

| 组件 | 技术 |
|------|------|
| 静态生成器 | Hugo v0.163.3 |
| 主题 | [digio-theme](https://github.com/danapixels/digio-theme) |
| 托管平台 | GitHub Pages |
| CI/CD | GitHub Actions |
| 评论系统 | [Giscus](https://giscus.app/)（基于 GitHub Discussions） |

## 核心功能

### 内容管理

- **Markdown 写作**：所有文章使用 Markdown 编写，YAML 格式 frontmatter
- **标签系统**：文章通过标签分类（如 `libc`、`pwn`、`assembly`）
- **代码高亮**：Monokai 主题，CSS 类名渲染
- **自动目录**：长文章自动生成目录导航

### 页面结构

| 页面 | 说明 |
|------|------|
| 首页 | 头像、简介、状态、GitHub 链接、最新文章 |
| 文章 | 技术文章列表，支持标签筛选和目录 |
| 关于 | 个人介绍与兴趣爱好 |

### 评论系统（Giscus）

- 基于 GitHub Discussions 的评论功能
- 支持点赞、嵌套回复、Markdown 格式
- 读者通过 GitHub 账号登录评论
- 主题跟随系统偏好（亮色/暗色）

### 设计风格

- 暗色主题，自定义 CSS 样式
- 等宽字体（Fira Code）
- 响应式布局
- 装饰性边框图片

## 项目结构

```
.
├── content/              # Markdown 文章与页面
│   ├── _index.md         # 首页配置
│   ├── me.md             # 关于页面
│   └── posts/            # 博客文章
├── layouts/              # Hugo 模板
│   ├── baseof.html       # 基础布局
│   ├── _default/         # 默认模板
│   └── posts/            # 文章模板
├── static/               # 静态资源（图片、CSS）
├── themes/               # Hugo 主题（digio-theme）
├── hugo.toml             # 站点配置
└── .github/workflows/    # CI/CD 流水线
```

## 部署方式

通过 GitHub Actions 自动化部署：

1. 推送到 `master` 分支
2. Hugo 构建站点（`hugo --gc --minify`）
3. 部署到 GitHub Pages

## 撰写文章

在 `content/posts/` 目录下创建新文件，使用以下 frontmatter 格式：

```markdown
---
title: "文章标题"
date: 2026-06-20
tags: ["标签1", "标签2"]
author: tuxnode
---

正文内容...
```

## 自定义配置

### 添加标签

在 frontmatter 中添加标签：

```yaml
tags: ["libc", "pwn", "security"]
```

### 更换主题

修改 `hugo.toml`：

```toml
theme = "your-theme-name"
```

### 修改样式

编辑 `static/css/custom.css` 自定义样式。

## 相关链接

- **站点**：https://tuxnode.fun
- **仓库**：https://github.com/tuxnode/tuxnode.github.io
- **主题**：https://github.com/danapixels/digio-theme
