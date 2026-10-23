---
name: Activity bar list
overview: "Show workspace plan files in the sidebar, open one from the card, and copy a build prompt with the real @ path."
todos:
  - id: copy-path
    content: "Copy prompt uses the plan file's workspace-relative path"
    status: completed
  - id: groups
    content: "Show a group heading only when a plan sets group in frontmatter"
    status: completed
  - id: watch
    content: "Refresh when a plan file is added, changed, or deleted"
    status: completed
  - id: open-row
    content: "Click the card to open; keep Copy build prompt as the extra action"
    status: completed
isProject: false
---

# Activity bar list

Cursor has no global list of workspace plans. This sidebar is that list.

Click a card to open the markdown. Copy the build prompt and paste it into a new Agent chat to run the plan.

Optional frontmatter:

```yaml
group: Later
```

Plans without `group` stay in a flat list.
