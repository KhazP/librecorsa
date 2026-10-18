# Security policy

LibreCorsa is a static site with an optional online leaderboard on Supabase. The parts worth reporting are the
leaderboard (`scripts/leaderboard-supabase/schema.sql`: anything that lets someone read or change data they
shouldn't, post under a name they don't own, or knock the board over), the force-feedback bridge (`npm run ffb`)
and anything that runs untrusted input in the browser.

## Reporting

Please report privately through **[Report a vulnerability](https://github.com/KhazP/librecorsa/security/advisories/new)**
(GitHub's private vulnerability reporting) rather than in a public issue. Include what you found, how to
reproduce it and what it lets an attacker do. You'll get a reply within a week.

Fake lap times are a known limit, not a vulnerability: the board checks laps for plausibility but can't prove
they were driven. Reports of a specific cheated entry can go in a normal issue.

## Supported versions

Only the current `main` branch, which is what https://khazp.github.io/librecorsa/ runs.
