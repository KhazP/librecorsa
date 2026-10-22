# Repository Rules & Workflow

## Git Commit Rules (Atomic Feature Chunks)

- **Always commit in small, logical, self-contained chunks:** Never bundle multiple distinct features, subsystems, or architectural layers into a single monolithic commit. Break changes down into clear, atomic commits (for example: data/environment model → core physics/logic → vehicle/subsystem wiring → shaders/rendering → UI & verification tests) so anyone reading `git log` immediately understands each addition.
- **Stage explicitly per chunk:** Use `git add "<file1>" "<file2>" ...` for only the files belonging to that specific feature chunk. Do not use `git add -A` or `git add .` when multiple features or unrelated working-tree changes are present.
- **Use Conventional Commits:** Format every commit message as `<type>(<scope>): <concise summary>` (e.g., `feat(weather): ...`, `feat(tyres): ...`, `feat(physics): ...`, `feat(render): ...`, `fix(gt3): ...`).
- **Verify before committing:** Ensure `npx tsc --noEmit` and any relevant verification scripts in `scripts/verify-*.ts` pass before finalizing commits.
