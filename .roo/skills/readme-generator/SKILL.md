---
name: readme-generator
description: Analyzes project structure, scripts, and dependencies to generate clear, structured README documentation and architecture diagrams.
---

# Documentation Generator Protocol

When creating or updating `README.md`:
1. **Analyze Project Structure**:
   - Scan root configuration files (`package.json`, `docker-compose.yml`, `Makefile`, etc.).
   - Identify the tech stack, build system, and entry points.
2. **Required Sections**:
   - **Header**: Project name and a 1-sentence value proposition.
   - **Architecture / Flow**: Use a Mermaid diagram if the system has multiple layers (frontend, backend, database).
   - **Prerequisites**: Exact runtime versions and external tools needed.
   - **Getting Started**: Step-by-step shell commands (install, configure `.env`, run dev).
   - **Available Scripts**: Table of CLI commands with descriptions.
3. Keep instructions concise, factual, and strictly aligned with existing project files.