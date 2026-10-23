# Changelog

## 0.0.10

- Export all, one, or selected plans to a `.cplan` file, with a progress bar
- Import a `.cplan` bundle into `.cursor/plans/` (keep both, overwrite, or skip)

## 0.0.9

- Search the sidebar by name, overview, group, or filename
- Paginate long lists, eight plans per page

## 0.0.8

- Sidebar lists this project only. Home-folder plans from other repos stay out of the list
- Save to workspace moves the open `~/.cursor/plans` file, or opens a picker
- A banner appears when the open editor is a home-folder plan

## 0.0.7

- Save to workspace moves a home-folder plan into `.cursor/plans`
- Workspace list includes Cursor's native `slug_hash.plan.md` names, not only `01-name.plan.md`

## 0.0.6

- Sidebar tabs to filter All, New, In progress, and Done

## 0.0.5

- Parser tests (`npm test`) and GitHub Actions CI
- Repository and issue links point at GitHub

## 0.0.4

- Copy build prompt uses the plan file's real workspace path
- Group headings only when a plan sets `group` in frontmatter
- Watch `.cursor/plans` and `docs/plans` and refresh on change
- Click a card to open; Copy build prompt is the extra action
- Reveal folder opens a plans README or the plans directory
- Empty state says where to put `01-name.plan.md`

## 0.0.3

- MIT license (UXCentury)
- Set publisher and author to UXCentury
- Marketplace description, keywords, dark gallery banner
- Activity-bar icon (theme-tinted SVG) and 256×256 marketplace icon
- Command titles use the Plans category

## 0.0.2

- Initial Plans sidebar for workspace `*.plan.md` files
