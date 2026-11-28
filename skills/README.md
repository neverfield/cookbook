# Cursor Skills

This folder holds copyable Cursor Skills examples. Each skill is a self-contained directory that can be copied into a project or personal skills folder.

## Layout

```text
skills/
├── README.md
└── <skill-name>/
    ├── SKILL.md
    ├── scripts/        # optional helper scripts or runtime
    ├── references/     # optional supporting documentation
    ├── examples/       # optional worked examples
    └── templates/      # optional reusable templates
```

## Skill Conventions

- Name each skill directory in `kebab-case` with a `SKILL.md` entry point at its root.
- Start `SKILL.md` with YAML frontmatter defining `name` (matching the directory name) and `description` (what the skill does and when to use it), plus optional fields such as `disable-model-invocation: true`:

```markdown
---
name: <skill-name>
description: Short summary of what the skill does and when an agent should use it.
---
```

- Keep supporting scripts, references, examples, and templates self-contained inside `<skill-name>/` so the directory works as a standalone copy.

## Using a Skill

Copy a skill directory into your project or personal Cursor skills folder:

```bash
# Project-scoped skill
mkdir -p /path/to/project/.cursor/skills
cp -R skills/<skill-name> /path/to/project/.cursor/skills/

# Personal skill available across workspaces
mkdir -p ~/.cursor/skills
cp -R skills/<skill-name> ~/.cursor/skills/
```
