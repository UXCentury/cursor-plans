# Cursor Plans

Cursor has no global list of workspace plans. This extension adds one.

**Publisher:** [UXCentury](https://uxcentury.com)

## What it does

- Adds a **Plans** item to the activity bar
- Lists `*.plan.md` files from `.cursor/plans/` (falls back to `docs/plans/`)
- Click a plan to open the markdown
- **Copy build prompt** — paste into a new Agent chat to run the plan (uses the real `@` path)
- Refreshes when a plan file is added, changed, or deleted

Optional frontmatter `group:` splits the list. Plans without it stay flat.

```yaml
group: Later
```

## Commands

| Command | What it does |
| --- | --- |
| Plans: Show sidebar | Opens the Plans activity-bar view |
| Plans: Refresh | Rescans workspace plan files |
| Plans: Reveal folder | Opens `README.md` in a plans folder, or reveals the folder |

## Developer

Built by **UXCentury** (UXC LLC), a design and engineering studio in Yerevan.

- Website: [uxcentury.com](https://uxcentury.com)
- Contact: [sales@uxcentury.com](mailto:sales@uxcentury.com)

## License

[MIT](LICENSE) — Copyright (c) 2026 UXCentury (UXC LLC).
