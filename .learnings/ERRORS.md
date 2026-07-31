# Error Log

## [ERR-20260731-001] skill-package-validator-missing-pyyaml

**Logged**: 2026-07-31T00:00:00+07:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary
The official skill package validator could not start because its Python runtime did not include PyYAML.

### Error
```text
ModuleNotFoundError: No module named 'yaml'
```

### Context
- Command: `python3 .../quick_validate.py dist/coordinator-package/pharos-security-coordinator`
- The coordinator package had already been generated successfully.
- This is a validator environment dependency failure, not a package validation failure.

### Suggested Fix
Run the validator from an isolated Python environment that includes PyYAML, without adding it to the production coordinator runtime.

### Resolution
- **Resolved**: 2026-07-31T00:00:00+07:00
- **Notes**: Installed PyYAML only in `/tmp/pharos-skill-validator-venv`; the official validator then returned `Skill is valid!`.

### Metadata
- Reproducible: yes
- Related Files: coordinator/SKILL.md, coordinator/agents/openai.yaml

---

## [ERR-20260731-002] suite-skill-venv-not-present

**Logged**: 2026-07-31T00:00:00+07:00
**Priority**: low
**Status**: resolved
**Area**: tooling

### Summary
The copied skill-inspector subtree has no local `.venv`, so its first verification command could not start.

### Error
```text
zsh:1: no such file or directory: .venv/bin/python
```

### Resolution
- **Resolved**: 2026-07-31T00:00:00+07:00
- **Notes**: Re-ran the checked-in test suite with the upstream skill-inspector virtualenv and `PYTHONPATH=src`; 83 tests passed and no production files or dependencies were changed.

### Metadata
- Reproducible: yes
- Related Files: skill-inspector/pyproject.toml

---
