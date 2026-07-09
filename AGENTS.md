# AGENTS.md

## What This Is

Hugo-based personal blog (tuxnode.fun) focused on low-level systems, architecture, and security. Not an application — it's a content site with a theme.

## Essential Commands

```bash
# First-time setup (theme is a git submodule)
git submodule update --init --recursive

# Local dev server (http://localhost:1313)
hugo server

# Production build (what CI runs)
hugo --gc --minify
```

**Hugo version**: 0.163.3 (extended). CI pins this version.

## Key Gotchas

- **Theme is a submodule**: `themes/digio-theme` must be initialized before build. If `hugo server` fails with missing theme, run `git submodule update --init --recursive`.
- **CI removes theme content**: The workflow runs `rm -rf themes/digio-theme/content` before building — don't add content inside the theme dir.
- **No lint/test/typecheck**: This is a blog. There are no code quality tools. Verify changes with `hugo server` and visual inspection.
- **`.hugo_build.lock`**: Ignored in git. Delete it if Hugo complains about stale locks.

## Content Structure

- Posts live in `content/posts/` as Markdown with YAML frontmatter
- Filename convention: `YYYY-MM-DD-slug.md`
- Required frontmatter fields: `title`, `date`, `tags` (array), `author`
- Tags are the primary categorization (e.g., `libc`, `pwn`, `assembly`)

## Deployment

Push to `master` triggers GitHub Actions → Hugo build → deploy to GitHub Pages. No manual deploy steps.

## Customization

- Site config: `hugo.toml`
- Custom styles: `static/css/custom.css`
- Templates override theme via `layouts/` directory (already set up)
