---
name: truth-first
description: Enforces evidence-first verification before proposing or modifying code. Eliminates hallucinated functions, assumptions, and ghost dependencies.
---

# Evidence-First Verification Protocol

Before modifying, creating, or refactoring any code:
1. **Never guess**: Do not assume a library, API endpoint, or method exists based solely on common patterns.
2. **Verify ground truth**:
   - Inspect `package.json`, `requirements.txt`, or relevant dependency manifests first.
   - Search existing files for real type signatures and function definitions.
3. **Execute read-only checks**:
   - If unsure about framework behavior or library versions, run a terminal check (e.g. `--version` or grep imports).
4. **Flag missing context**: If documentation or required implementation details are absent, explicitly ask the user rather than inventing placeholder logic.