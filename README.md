# Geek's Tech Base

专注于底层系统、计算机架构与安全研究的个人技术博客。

基于 [Hugo](https://gohugo.io/) 和 [digio-theme](https://github.com/danapixels/digio-theme) 构建。

## 技术栈

| 组件 | 技术 |
|------|------|
| 静态生成器 | Hugo v0.163.3 (extended) |
| 主题 | [digio-theme](https://github.com/danapixels/digio-theme) |
| 托管平台 | GitHub Pages |
| CI/CD | GitHub Actions |
| 评论系统 | [Giscus](https://giscus.app/)（基于 GitHub Discussions） |

## 特性

- Markdown 内容管理，YAML frontmatter，支持标签分类
- 代码高亮（Monokai 主题，CSS 类名渲染）
- 自动生成目录导航
- Giscus 评论系统（基于 GitHub Discussions）
- 暗色主题，响应式设计
- GitHub Actions 自动部署

**[查看完整特性文档](docs/blog-features.md)**

## 快速开始

```bash
# 安装 Hugo (需要 extended 版本)
brew install hugo

# 初始化主题子模块
git submodule update --init --recursive

# 本地运行
hugo server

# 打开 http://localhost:1313
```

## 许可证

MIT
