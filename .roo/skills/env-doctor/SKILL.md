---
name: env-doctor
description: Diagnoses and resolves environment, startup, dependency, Docker, and port configuration issues.
---

# Environment Diagnostic Protocol

When the user encounters runtime errors, startup crashes, or build failures:
1. **Scan Environment**:
   - Check presence of `.env` and compare keys against `.env.example`.
   - Verify active runtime versions (Node, Python, Go, Docker) against project engine specifications.
2. **Check System Conflicts**:
   - Verify if target ports are already occupied by another process.
   - Check if required services (PostgreSQL, Redis, Docker daemon) are active and accepting connections.
3. **Dependency Integrity**:
   - Identify mismatch between lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `poetry.lock`) and manifest files.
4. **Resolution Plan**:
   - State the root cause in 1-2 sentences.
   - Provide the exact shell commands needed to resolve the conflict (e.g., stopping conflicting PID, installing missing native packages).